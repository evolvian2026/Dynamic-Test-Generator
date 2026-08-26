/**
 * Bulk question import.
 *
 * Nobody hand-enters a bank of any size, so this is what makes the application
 * usable with real data. The interesting problem is not parsing rows — it is
 * deciding where each row belongs in the taxonomy when the incoming file says
 * "Operating Systems" and the taxonomy says "Operating System".
 *
 * That matching is already solved: `matchClassification` in db/backfill.js does
 * subject-first resolution with word-boundary scoring and a confidence
 * threshold, and it is what the legacy migration uses. Here it drives a
 * two-phase flow instead:
 *
 *   preview  parse, match, and report exactly what would happen — matched,
 *            needs-attention, duplicate, invalid — changing nothing
 *   commit   write the rows the operator accepted
 *
 * Nothing is imported on a guess. A row whose taxonomy cannot be resolved
 * confidently is surfaced for a human rather than filed somewhere plausible.
 */

import { getDb } from '../db/index.js';
import { matchClassification } from '../db/backfill.js';
import { resolvePath } from '../core/taxonomy.js';
import { fingerprint, similarity } from '../core/similarity.js';
import { createQuestion, nextQid } from './questionService.js';
import { badRequest } from '../middleware/errors.js';
import { audit } from './testService.js';

/** Column aliases accepted in an incoming file, normalised to our field names. */
const COLUMN_ALIASES = {
  qid: ['qid', 'question id', 'id', 'item id', 'reference'],
  question_text: ['question_text', 'question', 'question text', 'text', 'stem', 'body'],
  question_type: ['question_type', 'type', 'question type', 'item type'],
  difficulty: ['difficulty', 'level', 'difficulty level'],
  marks: ['marks', 'mark', 'score', 'points', 'weight'],
  expected_seconds: ['expected_seconds', 'time', 'duration', 'expected time', 'time seconds'],
  status: ['status', 'state'],
  subject: ['subject', 'course subject'],
  area: ['area', 'topic', 'area/topic', 'area / topic'],
  sub_area: ['sub_area', 'subarea', 'subtopic', 'sub-topic', 'sub area', 'sub-area', 'sub area/sub topic'],
  tags: ['tags', 'tag', 'keywords', 'labels'],
  answer_text: ['answer_text', 'answer', 'correct answer', 'model answer', 'solution'],
  explanation: ['explanation', 'rationale', 'feedback'],
  options: ['options', 'choices'],
  correct_option: ['correct_option', 'correct', 'key', 'answer key'],
};

const OPTION_COLUMN = /^(option[_\s-]?|choice[_\s-]?)([a-h]|\d)$/i;
const OPTION_TYPES = new Set(['MCQ', 'Multiple Select', 'True/False']);

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Maps a file's header row onto our field names. */
export function mapColumns(headers) {
  const mapping = {};
  const optionColumns = [];
  const unmapped = [];

  for (const header of headers) {
    const key = norm(header);
    if (!key) continue;

    const optionMatch = String(header).trim().match(OPTION_COLUMN);
    if (optionMatch) {
      optionColumns.push({ header, label: optionMatch[2].toUpperCase() });
      continue;
    }

    // Both sides are normalised: the alias table is written with underscores
    // but `norm` turns them into spaces, so a raw comparison never matches.
    const field = Object.entries(COLUMN_ALIASES)
      .find(([name, aliases]) => norm(name) === key || aliases.some((alias) => norm(alias) === key))?.[0];
    if (field && mapping[field] === undefined) mapping[field] = header;
    else if (!field) unmapped.push(header);
  }

  // Unmapped columns become extensible attributes rather than being discarded —
  // the metadata registry is designed to absorb exactly this.
  return { mapping, optionColumns, attributeColumns: unmapped };
}

/** Splits a delimited cell, honouring brackets the way the taxonomy import does. */
function splitList(value) {
  if (value === null || value === undefined) return [];
  const out = [];
  let buffer = '';
  let depth = 0;
  for (const char of String(value)) {
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    if ((char === ',' || char === ';' || char === '|') && depth === 0) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    } else buffer += char;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/** Builds the option list for a row from either dedicated columns or one cell. */
function readOptions(row, columns, correctRaw) {
  const correctLabels = splitList(correctRaw).map((c) => c.trim().toUpperCase());

  let options = [];
  if (columns.optionColumns.length) {
    options = columns.optionColumns
      .map(({ header, label }) => ({ label, option_text: String(row[header] ?? '').trim() }))
      .filter((o) => o.option_text);
  } else if (columns.mapping.options) {
    options = splitList(row[columns.mapping.options]).map((text, index) => ({
      label: String.fromCharCode(65 + index),
      option_text: text,
    }));
  }

  return options.map((option, index) => ({
    option_text: option.option_text,
    is_correct:
      correctLabels.includes(option.label) ||
      correctLabels.includes(String(index + 1)) ||
      correctLabels.some((c) => c.toLowerCase() === option.option_text.toLowerCase()),
  }));
}

/**
 * Analyses parsed rows without writing anything.
 *
 * @param {Array<object>} rows    parsed spreadsheet rows (header -> value)
 * @param {object} [options]
 * @param {boolean}[options.detectDuplicates]  compare against the existing bank
 */
export function previewImport(rows, { detectDuplicates = true, defaultStatus = 'draft' } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw badRequest('The file contains no rows.');

  const db = getDb();
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = mapColumns(headers);

  if (!columns.mapping.question_text) {
    throw badRequest(
      `Could not find a question text column. Looked for: ${COLUMN_ALIASES.question_text.join(', ')}. ` +
      `The file has: ${headers.join(', ')}`,
    );
  }

  const existingQids = new Set(db.prepare('SELECT qid FROM questions').all().map((r) => r.qid));
  const seenInFile = new Set();

  const get = (row, field) => {
    const header = columns.mapping[field];
    return header === undefined ? undefined : row[header];
  };

  const items = rows.map((row, index) => {
    const rowNumber = index + 2; // 1-based, plus the header
    const issues = [];

    const questionText = String(get(row, 'question_text') ?? '').trim();
    const questionType = String(get(row, 'question_type') ?? 'MCQ').trim() || 'MCQ';
    const difficultyRaw = String(get(row, 'difficulty') ?? 'Medium').trim();
    const difficulty = ['Easy', 'Medium', 'Hard'].find((d) => d.toLowerCase() === difficultyRaw.toLowerCase()) || null;

    if (!questionText) issues.push('Question text is empty.');
    if (!difficulty) issues.push(`Difficulty "${difficultyRaw}" is not one of Easy, Medium, Hard.`);

    // ---- taxonomy resolution ----
    const subjectRaw = String(get(row, 'subject') ?? '').trim();
    const areaRaw = String(get(row, 'area') ?? '').trim();
    const subAreaRaw = String(get(row, 'sub_area') ?? '').trim();

    let taxonomy = null;
    let taxonomyConfidence = null;
    let taxonomySource = null;

    // An exact path is used as given; anything else goes through the matcher.
    if (subjectRaw && areaRaw) {
      const exact = resolvePath({ subject: subjectRaw, area: areaRaw, subArea: subAreaRaw || null });
      if (exact) {
        taxonomy = { subject: exact.subject, area: exact.area, subArea: exact.subArea };
        taxonomyConfidence = 1;
        taxonomySource = 'exact';
      }
    }
    if (!taxonomy) {
      const probe = areaRaw || subjectRaw;
      const secondary = subAreaRaw || (areaRaw ? null : areaRaw);
      if (probe) {
        const match = matchClassification(subjectRaw || probe, subAreaRaw || areaRaw || secondary);
        if (match) {
          taxonomy = {
            subject: match.subject.name,
            area: match.area.name,
            subArea: match.subArea ? match.subArea.name : null,
          };
          taxonomyConfidence = Number(match.score.toFixed(2));
          taxonomySource = match.via;
        }
      }
    }
    if (!taxonomy) {
      issues.push(
        subjectRaw || areaRaw
          ? `Could not place "${[subjectRaw, areaRaw, subAreaRaw].filter(Boolean).join(' > ')}" in the taxonomy.`
          : 'No subject or area given, so the question cannot be classified.',
      );
    }

    // ---- qid ----
    let qid = String(get(row, 'qid') ?? '').trim();
    let qidStatus = 'generated';
    if (qid) {
      if (existingQids.has(qid)) { qidStatus = 'exists'; issues.push(`QID ${qid} is already in the bank.`); }
      else if (seenInFile.has(qid)) { qidStatus = 'repeated'; issues.push(`QID ${qid} appears more than once in this file.`); }
      else { qidStatus = 'provided'; seenInFile.add(qid); }
    }

    // ---- options ----
    const options = readOptions(row, columns, get(row, 'correct_option'));
    if (OPTION_TYPES.has(questionType)) {
      if (options.length < 2) issues.push(`${questionType} needs at least two options.`);
      else if (!options.some((o) => o.is_correct)) issues.push('No option is marked correct.');
    }

    // ---- attributes from unmapped columns ----
    const attributes = {};
    for (const header of columns.attributeColumns) {
      const value = row[header];
      if (value === null || value === undefined || String(value).trim() === '') continue;
      attributes[norm(header).replace(/ /g, '_')] = String(value).trim();
    }

    const tags = splitList(get(row, 'tags'));

    return {
      row: rowNumber,
      qid: qid || null,
      qidStatus,
      question_text: questionText,
      question_type: questionType,
      difficulty,
      marks: Number(get(row, 'marks') ?? 1) || 1,
      expected_seconds: Number(get(row, 'expected_seconds') ?? 60) || 60,
      status: String(get(row, 'status') ?? defaultStatus).trim() || defaultStatus,
      answer_text: get(row, 'answer_text') ? String(get(row, 'answer_text')).trim() : null,
      explanation: get(row, 'explanation') ? String(get(row, 'explanation')).trim() : null,
      tags,
      attributes,
      options,
      taxonomy,
      taxonomyConfidence,
      taxonomySource,
      source: { subject: subjectRaw, area: areaRaw, subArea: subAreaRaw },
      issues,
      valid: issues.length === 0,
    };
  });

  // ---- near-duplicate detection against the existing bank ----
  if (detectDuplicates) {
    const lookup = db.prepare(
      'SELECT id, qid, question_text FROM questions WHERE text_fingerprint LIKE ? LIMIT 40',
    );
    for (const item of items) {
      if (!item.question_text) continue;
      const parts = fingerprint(item.question_text).split(' ').filter(Boolean).slice(0, 4);
      const seen = new Map();
      for (const part of parts) {
        for (const candidate of lookup.all(`%${part}%`)) seen.set(candidate.qid, candidate);
      }
      let best = null;
      for (const candidate of seen.values()) {
        const score = similarity(item.question_text, candidate.question_text);
        if (score >= 0.6 && (!best || score > best.similarity)) {
          best = { qid: candidate.qid, similarity: Number(score.toFixed(3)) };
        }
      }
      if (best) {
        item.duplicateOf = best;
        item.issues.push(`Looks like an existing question (${best.qid}, ${Math.round(best.similarity * 100)}% similar).`);
        item.valid = false;
      }
    }
  }

  const needsAttention = items.filter((i) => !i.valid);
  const lowConfidence = items.filter((i) => i.valid && i.taxonomyConfidence !== null && i.taxonomyConfidence < 0.85);

  return {
    columns: {
      mapped: columns.mapping,
      optionColumns: columns.optionColumns.map((c) => c.header),
      attributeColumns: columns.attributeColumns,
    },
    totals: {
      rows: items.length,
      ready: items.filter((i) => i.valid).length,
      needsAttention: needsAttention.length,
      duplicates: items.filter((i) => i.duplicateOf).length,
      lowConfidenceTaxonomy: lowConfidence.length,
    },
    items,
  };
}

/**
 * Writes the accepted rows.
 *
 * `rows` is the preview output (optionally edited by the operator — a corrected
 * taxonomy path, a fixed difficulty). Anything still invalid is skipped and
 * reported; the import never partially writes a question.
 */
export function commitImport(rows, user, { skipInvalid = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw badRequest('There is nothing to import.');

  const db = getDb();
  const created = [];
  const skipped = [];

  for (const item of rows) {
    if (!item.valid && !item.forceImport) {
      if (!skipInvalid) throw badRequest(`Row ${item.row} is not valid: ${(item.issues || []).join(' ')}`);
      skipped.push({ row: item.row, qid: item.qid, reasons: item.issues || ['not valid'] });
      continue;
    }
    if (!item.taxonomy) {
      skipped.push({ row: item.row, qid: item.qid, reasons: ['no taxonomy branch'] });
      continue;
    }

    try {
      const question = createQuestion(
        {
          qid: item.qid || nextQid(db),
          question_text: item.question_text,
          question_type: item.question_type,
          difficulty: item.difficulty,
          marks: item.marks,
          expected_seconds: item.expected_seconds,
          status: item.status,
          answer_text: item.answer_text,
          explanation: item.explanation,
          tags: item.tags,
          attributes: item.attributes,
          options: item.options,
          metadata: { importedAt: new Date().toISOString(), sourceRow: item.row },
          taxonomy: [{ ...item.taxonomy, isPrimary: true }],
        },
        user,
      );
      created.push(question.qid);
    } catch (error) {
      skipped.push({ row: item.row, qid: item.qid, reasons: [error.message] });
    }
  }

  audit(user?.id, 'questions.import', 'question', null, { created: created.length, skipped: skipped.length });
  return { created: created.length, qids: created, skipped };
}

export { splitList };
