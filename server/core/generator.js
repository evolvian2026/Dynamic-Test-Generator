/**
 * Test generation (spec §8, §9, §10, §12, §17, §26).
 *
 * Three modes:
 *   automatic — the engine picks every QID
 *   manual    — the user supplies the QIDs; the engine validates them
 *   hybrid    — the engine picks, then the user edits (replace/add/remove/move)
 *
 * Guarantees:
 *   * A QID appears at most once per test when `preventDuplicates` is on.
 *   * A given seed always reproduces the same test.
 *   * Generation never silently under-delivers — shortfalls are reported.
 */

import { sampleQuestions, getQuestionsByQids, countMatching } from './questions.js';
import { expandBuckets } from './distribution.js';
import { createRng, shuffle, generateSeed } from './rng.js';
import { explainMatch } from './filterEngine.js';
import { OPTION_BEARING_TYPES } from './metadata.js';

export class GenerationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GenerationError';
    this.status = 422;
    this.details = details;
  }
}

/**
 * Builds the question selection for a set of sections.
 *
 * @param {object} input
 * @param {Array}  input.sections            section configs (rule, distribution, counts)
 * @param {string} [input.mode]              automatic | manual | hybrid
 * @param {string} [input.seed]              reproducibility seed
 * @param {boolean}[input.preventDuplicates] default true
 * @param {string[]}[input.reservedQids]     QIDs already used (e.g. by a sibling version)
 * @param {boolean}[input.allowPartial]      accept a short section instead of throwing
 */
export function generateSelection(input) {
  const {
    sections = [],
    mode = 'automatic',
    seed = null,
    preventDuplicates = true,
    reservedQids = [],
    allowPartial = false,
  } = input;

  if (!sections.length) throw new GenerationError('A test needs at least one section.');

  const effectiveSeed = seed || generateSeed();
  const used = new Set(preventDuplicates ? reservedQids : []);
  const results = [];
  const warnings = [];

  sections.forEach((section, index) => {
    const sectionSeed = `${effectiveSeed}:s${index}`;
    const requestedTotal = Number(section.question_count ?? section.questionCount ?? 0);

    if (mode === 'manual') {
      results.push(collectManual(section, index, used, preventDuplicates, warnings));
      return;
    }

    const buckets = expandBuckets(section);
    const picked = [];

    buckets.forEach((bucket, bucketIndex) => {
      const exclude = preventDuplicates ? [...used] : [];
      const chosen = sampleQuestions(bucket.rule, {
        count: bucket.count,
        seed: `${sectionSeed}:b${bucketIndex}`,
        excludeQids: exclude,
      });

      for (const row of chosen) {
        if (preventDuplicates && used.has(row.qid)) continue;
        used.add(row.qid);
        picked.push({
          id: row.id,
          qid: row.qid,
          rule: bucket.rule,
          bucket: bucket.value ? `${bucket.field}=${bucket.value}` : null,
        });
      }

      if (chosen.length < bucket.count) {
        warnings.push({
          section: section.section_name || `Section ${index + 1}`,
          bucket: bucket.value ? `${bucket.field} = ${bucket.value}` : 'all',
          requested: bucket.count,
          selected: chosen.length,
          message:
            `Only ${chosen.length} of ${bucket.count} requested questions are available for ` +
            `${section.section_name || `Section ${index + 1}`}` +
            `${bucket.value ? ` (${bucket.field} = ${bucket.value})` : ''}.`,
        });
      }
    });

    // Any user-pinned QIDs are honoured first in hybrid mode.
    if (mode === 'hybrid' && Array.isArray(section.pinnedQids) && section.pinnedQids.length) {
      const pinned = getQuestionsByQids(section.pinnedQids);
      for (const q of pinned.reverse()) {
        if (picked.some((p) => p.qid === q.qid)) continue;
        if (preventDuplicates && used.has(q.qid)) continue;
        used.add(q.qid);
        picked.unshift({ id: q.id, qid: q.qid, rule: section.rule || {}, bucket: 'pinned' });
        if (picked.length > requestedTotal) {
          const dropped = picked.pop();
          used.delete(dropped.qid);
        }
      }
    }

    const ordered = section.randomize === false
      ? picked
      : shuffle(picked, createRng(`${sectionSeed}:order`));

    results.push(buildSectionResult(section, index, ordered, requestedTotal));
  });

  const shortfall = results.reduce((a, r) => a + r.shortfall, 0);
  if (shortfall > 0 && !allowPartial) {
    throw new GenerationError(
      `Not enough questions are available to satisfy every section (${shortfall} short).`,
      { sections: results, warnings },
    );
  }

  return { seed: effectiveSeed, mode, sections: results, warnings, usedQids: [...used] };
}

function collectManual(section, index, used, preventDuplicates, warnings) {
  const requested = Number(section.question_count ?? section.questionCount ?? 0);
  const qids = Array.isArray(section.qids) ? section.qids : [];
  const loaded = getQuestionsByQids(qids);
  const found = new Set(loaded.map((q) => q.qid));

  const missing = qids.filter((q) => !found.has(q));
  if (missing.length) {
    warnings.push({
      section: section.section_name || `Section ${index + 1}`,
      message: `These QIDs are not in the question bank and were skipped: ${missing.join(', ')}`,
    });
  }

  const picked = [];
  for (const q of loaded) {
    if (preventDuplicates && used.has(q.qid)) {
      warnings.push({
        section: section.section_name || `Section ${index + 1}`,
        message: `${q.qid} is already used earlier in this test and was skipped.`,
      });
      continue;
    }
    used.add(q.qid);
    picked.push({ id: q.id, qid: q.qid, rule: section.rule || {}, bucket: 'manual' });
  }

  return buildSectionResult(section, index, picked, requested || picked.length);
}

function buildSectionResult(section, index, picked, requestedTotal) {
  const marksPerQuestion = Number(section.marks_per_question ?? section.marksPerQuestion ?? 1);
  return {
    index,
    sectionName: section.section_name || section.sectionName || `Section ${index + 1}`,
    requested: requestedTotal,
    delivered: picked.length,
    shortfall: Math.max(0, requestedTotal - picked.length),
    marksPerQuestion,
    marks: picked.length * marksPerQuestion,
    questions: picked.map((p, order) => ({
      qid: p.qid,
      questionId: p.id,
      order: order + 1,
      marks: marksPerQuestion,
      reason: { rule: p.rule, bucket: p.bucket },
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Replace / alternatives (spec §12)
 * ------------------------------------------------------------------ */

/**
 * Finds interchangeable questions for a slot: same selection rule, excluding
 * everything already in the test.
 */
export function findReplacements({ rule, excludeQids = [], limit = 20, seed = null }) {
  const available = countMatching(rule, { excludeQids });
  const rows = sampleQuestions(rule, { count: limit, seed, excludeQids });
  return { available, candidates: getQuestionsByQids(rows.map((r) => r.qid)) };
}

/* ------------------------------------------------------------------ *
 * Versions (spec §17)
 * ------------------------------------------------------------------ */

/**
 * Produces N selections from the same rules. Each version uses a distinct
 * seed, so the difficulty and taxonomy distributions stay identical while the
 * QIDs differ. With `uniqueAcrossVersions`, no QID is reused between versions
 * — the engine reports honestly if the bank is too small for that.
 */
export function generateVersions({ sections, count, seed = null, preventDuplicates = true, uniqueAcrossVersions = false, allowPartial = false }) {
  const baseSeed = seed || generateSeed();
  const versions = [];
  const consumed = [];

  for (let i = 0; i < count; i += 1) {
    const label = String.fromCharCode(65 + (i % 26));
    const selection = generateSelection({
      sections,
      mode: 'automatic',
      seed: `${baseSeed}:v${label}`,
      preventDuplicates,
      reservedQids: uniqueAcrossVersions ? [...consumed] : [],
      allowPartial,
    });
    if (uniqueAcrossVersions) consumed.push(...selection.usedQids);
    versions.push({ label, ...selection });
  }

  return { baseSeed, versions };
}

/* ------------------------------------------------------------------ *
 * Presentation-time randomisation (spec §10)
 * ------------------------------------------------------------------ */

/** Shuffles the options of option-bearing question types, reproducibly. */
export function randomizeOptions(questions, seed) {
  return questions.map((q) => {
    if (!OPTION_BEARING_TYPES.has(q.question_type) || !q.options?.length) return q;
    return { ...q, options: shuffle([...q.options], createRng(`${seed}:${q.qid}`)) };
  });
}

/* ------------------------------------------------------------------ *
 * Audit (spec §25)
 * ------------------------------------------------------------------ */

/** "Why was this question selected?" for one stored test question. */
export function explainSelection(question, reason) {
  const rule = reason?.rule || {};
  const { matched, criteria } = explainMatch(rule, question);
  return {
    qid: question.qid,
    matched,
    bucket: reason?.bucket || null,
    criteria: criteria.length
      ? criteria
      : [{ criterion: 'No filter constraints — selected from the full active bank', actual: '', passed: true }],
  };
}
