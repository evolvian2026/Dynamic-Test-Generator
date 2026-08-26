/**
 * Question bank authoring.
 *
 * Test generation never invents questions — that boundary is deliberate and
 * unchanged. This module is bank *administration*: the Admin capability to
 * create, correct and retire the items that generation draws from.
 *
 * A question is written across five tables (row, options, tags, attributes,
 * taxonomy branches), so every write here runs in one transaction: a half-saved
 * question would be selectable by the generator.
 */

import { getDb } from '../db/index.js';
import { resolvePath, invalidateTaxonomyCache } from '../core/taxonomy.js';
import { getQuestionByQid } from '../core/questions.js';
import { fingerprint } from '../core/similarity.js';
import { badRequest, conflict, notFound } from '../middleware/errors.js';
import { audit } from './testService.js';

const OPTION_TYPES = new Set(['MCQ', 'Multiple Select', 'True/False']);

/** Next free QID, following the QID<n> convention already in the bank. */
export function nextQid(db) {
  const row = db
    .prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(qid, 4) AS INTEGER)), 1000) AS m FROM questions WHERE qid LIKE 'QID%'`)
    .get();
  return `QID${row.m + 1}`;
}

/**
 * Validates a question payload and resolves its taxonomy branches.
 * Throws with a precise message rather than writing something inconsistent.
 */
function prepare(input, { requireTaxonomy = true } = {}) {
  const errors = [];

  if (!input.question_text || !String(input.question_text).trim()) errors.push('Question text is required.');
  if (!input.question_type || !String(input.question_type).trim()) errors.push('Question type is required.');
  if (!input.difficulty) errors.push('Difficulty is required.');
  if (input.marks !== undefined && Number(input.marks) < 0) errors.push('Marks cannot be negative.');

  const options = Array.isArray(input.options) ? input.options : [];
  if (OPTION_TYPES.has(input.question_type)) {
    if (options.length < 2) errors.push(`${input.question_type} questions need at least two options.`);
    const correct = options.filter((o) => o.is_correct).length;
    if (correct === 0) errors.push('At least one option must be marked correct.');
    if (input.question_type === 'MCQ' && correct > 1) errors.push('An MCQ can have only one correct option.');
    if (input.question_type === 'True/False' && options.length !== 2) errors.push('True/False needs exactly two options.');
    if (options.some((o) => !String(o.option_text ?? '').trim())) errors.push('Options cannot be blank.');
  } else if (options.length) {
    errors.push(`${input.question_type} questions do not take options.`);
  }

  // Taxonomy: every branch must be a real path, not an arbitrary triple.
  const branches = [];
  const rawBranches = Array.isArray(input.taxonomy) ? input.taxonomy : [];
  for (const branch of rawBranches) {
    const resolved = resolvePath({ subject: branch.subject, area: branch.area, subArea: branch.subArea ?? null });
    if (!resolved) {
      errors.push(`"${[branch.subject, branch.area, branch.subArea].filter(Boolean).join(' > ')}" is not a valid taxonomy path.`);
      continue;
    }
    branches.push(resolved);
  }
  if (requireTaxonomy && !branches.length) errors.push('A question must be classified under at least one Subject > Area branch.');

  // Exactly one branch is primary.
  const primaryIndex = rawBranches.findIndex((b) => b.isPrimary);
  const primary = primaryIndex >= 0 && primaryIndex < branches.length ? primaryIndex : 0;

  if (errors.length) throw badRequest('The question is not valid.', errors);

  return { branches, primary, options };
}

/** Writes options, tags, attributes and taxonomy for a question id. */
function writeRelations(db, questionId, input, prepared, { replace = false } = {}) {
  if (replace) {
    db.prepare('DELETE FROM question_options WHERE question_id = ?').run(questionId);
    db.prepare('DELETE FROM question_tags WHERE question_id = ?').run(questionId);
    db.prepare('DELETE FROM question_attributes WHERE question_id = ?').run(questionId);
    db.prepare('DELETE FROM question_taxonomy WHERE question_id = ?').run(questionId);
  }

  const insertOption = db.prepare(
    'INSERT INTO question_options (question_id, position, option_text, is_correct) VALUES (?, ?, ?, ?)',
  );
  prepared.options.forEach((option, index) => {
    insertOption.run(questionId, index + 1, String(option.option_text), option.is_correct ? 1 : 0);
  });

  const insertTag = db.prepare('INSERT OR IGNORE INTO question_tags (question_id, tag) VALUES (?, ?)');
  for (const tag of input.tags || []) {
    const value = String(tag).trim();
    if (value) insertTag.run(questionId, value);
  }

  const insertAttr = db.prepare(
    'INSERT OR IGNORE INTO question_attributes (question_id, attr_key, attr_value, num_value) VALUES (?, ?, ?, ?)',
  );
  for (const [key, raw] of Object.entries(input.attributes || {})) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value === null || value === undefined || value === '') continue;
      const numeric = Number(value);
      insertAttr.run(questionId, key, String(value), Number.isFinite(numeric) ? numeric : null);
    }
  }

  const insertBranch = db.prepare(
    `INSERT INTO question_taxonomy (question_id, subject_id, area_id, sub_area_id, is_primary)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  prepared.branches.forEach((branch, index) => {
    insertBranch.run(questionId, branch.subjectId, branch.areaId, branch.subAreaId, index === prepared.primary ? 1 : 0);
  });
}

/** Creates one question. Returns the hydrated row. */
export function createQuestion(input, user) {
  const db = getDb();
  const prepared = prepare(input);

  const qid = String(input.qid || '').trim() || nextQid(db);
  if (db.prepare('SELECT 1 FROM questions WHERE qid = ?').get(qid)) {
    throw conflict(`A question with QID ${qid} already exists.`);
  }

  const write = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO questions (qid, question_type, question_text, difficulty, marks, expected_seconds,
                                status, answer_text, explanation, metadata, created_by, updated_by, text_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        qid,
        input.question_type,
        input.question_text,
        input.difficulty,
        Number(input.marks ?? 1),
        Number(input.expected_seconds ?? 60),
        input.status || 'draft',
        input.answer_text ?? null,
        input.explanation ?? null,
        JSON.stringify(input.metadata || {}),
        user?.id ?? null,
        user?.id ?? null,
        fingerprint(input.question_text),
      );
    writeRelations(db, info.lastInsertRowid, input, prepared);
    return info.lastInsertRowid;
  });

  const id = write();
  audit(user?.id, 'question.create', 'question', qid, { type: input.question_type });
  return getQuestionByQid(qid, { withAnswers: true });
}

/**
 * Updates a question in place.
 *
 * Relations are replaced wholesale when supplied, because a partial merge of
 * options or taxonomy branches would silently leave stale rows behind.
 */
export function updateQuestion(qid, input, user) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM questions WHERE qid = ?').get(qid);
  if (!existing) throw notFound(`No question with QID ${qid}`);

  const merged = {
    question_type: input.question_type ?? existing.question_type,
    question_text: input.question_text ?? existing.question_text,
    difficulty: input.difficulty ?? existing.difficulty,
    marks: input.marks ?? existing.marks,
    expected_seconds: input.expected_seconds ?? existing.expected_seconds,
    status: input.status ?? existing.status,
    answer_text: input.answer_text !== undefined ? input.answer_text : existing.answer_text,
    explanation: input.explanation !== undefined ? input.explanation : existing.explanation,
    metadata: input.metadata ?? safeJson(existing.metadata),
    options: input.options ?? currentOptions(db, existing.id),
    tags: input.tags ?? currentTags(db, existing.id),
    attributes: input.attributes ?? currentAttributes(db, existing.id),
    taxonomy: input.taxonomy ?? currentTaxonomy(db, existing.id),
  };

  const prepared = prepare(merged);

  const write = db.transaction(() => {
    db.prepare(
      `UPDATE questions
          SET question_type = ?, question_text = ?, difficulty = ?, marks = ?, expected_seconds = ?,
              status = ?, answer_text = ?, explanation = ?, metadata = ?, updated_by = ?,
              text_fingerprint = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      merged.question_type, merged.question_text, merged.difficulty, Number(merged.marks),
      Number(merged.expected_seconds), merged.status, merged.answer_text, merged.explanation,
      JSON.stringify(merged.metadata), user?.id ?? null, fingerprint(merged.question_text), existing.id,
    );
    writeRelations(db, existing.id, merged, prepared, { replace: true });
  });

  write();
  audit(user?.id, 'question.update', 'question', qid, Object.keys(input));
  return getQuestionByQid(qid, { withAnswers: true });
}

/**
 * Retires a question (status = 'retired') or deletes it outright.
 *
 * Deletion is refused while any generated test still references the QID —
 * a test must never lose the question it was built from. Retiring keeps
 * existing tests intact while removing the question from future selection,
 * which is almost always what is actually wanted.
 */
export function retireQuestion(qid, user, { hard = false } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT id, qid FROM questions WHERE qid = ?').get(qid);
  if (!existing) throw notFound(`No question with QID ${qid}`);

  const uses = db.prepare('SELECT COUNT(*) AS n FROM test_questions WHERE question_id = ?').get(existing.id).n;

  if (hard) {
    if (uses > 0) {
      throw conflict(
        `${qid} is used by ${uses} generated test(s) and cannot be deleted. Retire it instead — ` +
        'that removes it from future selection while leaving those tests intact.',
      );
    }
    db.prepare('DELETE FROM questions WHERE id = ?').run(existing.id);
    audit(user?.id, 'question.delete', 'question', qid, null);
    return { qid, deleted: true };
  }

  db.prepare(`UPDATE questions SET status = 'retired', updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(user?.id ?? null, existing.id);
  audit(user?.id, 'question.retire', 'question', qid, { uses });
  return { qid, retired: true, usedInTests: uses };
}

/* ---------------------------- current relations --------------------------- */

function currentOptions(db, questionId) {
  return db
    .prepare('SELECT option_text, is_correct FROM question_options WHERE question_id = ? ORDER BY position')
    .all(questionId)
    .map((o) => ({ option_text: o.option_text, is_correct: !!o.is_correct }));
}
function currentTags(db, questionId) {
  return db.prepare('SELECT tag FROM question_tags WHERE question_id = ?').all(questionId).map((r) => r.tag);
}
function currentAttributes(db, questionId) {
  const rows = db.prepare('SELECT attr_key, attr_value FROM question_attributes WHERE question_id = ?').all(questionId);
  const out = {};
  for (const row of rows) {
    if (out[row.attr_key] === undefined) out[row.attr_key] = row.attr_value;
    else if (Array.isArray(out[row.attr_key])) out[row.attr_key].push(row.attr_value);
    else out[row.attr_key] = [out[row.attr_key], row.attr_value];
  }
  return out;
}
function currentTaxonomy(db, questionId) {
  return db
    .prepare(
      `SELECT s.name AS subject, a.name AS area, sa.name AS subArea, qt.is_primary
         FROM question_taxonomy qt
         JOIN taxonomy_subjects s ON s.id = qt.subject_id
         JOIN taxonomy_areas a ON a.id = qt.area_id
         LEFT JOIN taxonomy_sub_areas sa ON sa.id = qt.sub_area_id
        WHERE qt.question_id = ?
        ORDER BY qt.is_primary DESC`,
    )
    .all(questionId)
    .map((r) => ({ subject: r.subject, area: r.area, subArea: r.subArea, isPrimary: !!r.is_primary }));
}

function safeJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

export { invalidateTaxonomyCache };
