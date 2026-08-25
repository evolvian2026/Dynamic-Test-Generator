/**
 * Test persistence (spec §9, §11, §12, §17, §18, §20).
 *
 * A stored test holds only QIDs — never a copy of the question content — so
 * the question bank remains the single source of truth (spec §30).
 */

import { getDb } from '../db/index.js';
import { generateSelection, generateVersions, findReplacements, explainSelection, randomizeOptions } from '../core/generator.js';
import { validateTestDefinition } from '../core/validation.js';
import { getQuestionsByQids, countMatching } from '../core/questions.js';
import { generateSeed } from '../core/rng.js';
import { HttpError, notFound, badRequest, conflict } from '../middleware/errors.js';

const TEST_COLUMNS = [
  'test_name', 'description', 'course', 'duration_minutes', 'total_marks', 'instructions',
  'starts_at', 'ends_at', 'status', 'generation_mode', 'randomize_questions', 'randomize_options',
  'prevent_duplicates', 'include_qid_in_student', 'random_seed', 'template_id', 'parent_test_id', 'version_label',
];

const bool = (v, d = 0) => (v === undefined || v === null ? d : v ? 1 : 0);

function nextTestId(db) {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM tests`).get();
  return `TST${String(row.next).padStart(5, '0')}`;
}

/** Normalises the incoming section payload into the shape the engine expects. */
function normalizeSections(sections = []) {
  return sections.map((section, index) => ({
    section_name: section.section_name ?? `Section ${index + 1}`,
    section_description: section.section_description ?? null,
    section_order: section.section_order ?? index + 1,
    question_count: Number(section.question_count ?? 0),
    marks_per_question: Number(section.marks_per_question ?? 1),
    negative_marks: Number(section.negative_marks ?? 0),
    time_limit_minutes: section.time_limit_minutes ?? null,
    rule: section.rule ?? {},
    distribution: section.distribution ?? null,
    qids: section.qids ?? [],
    pinnedQids: section.pinnedQids ?? [],
    randomize: section.randomize !== false,
  }));
}

/**
 * Validates + generates + persists in a single transaction. Nothing is written
 * unless the whole test is valid and every section can be filled.
 */
export function createTest({ user, test, sections, mode = 'automatic', allowPartial = false, templateId = null, parentTestId = null, versionLabel = null, seedOverride = null }) {
  const db = getDb();
  const normalized = normalizeSections(sections);
  const preventDuplicates = bool(test.prevent_duplicates, 1) === 1;
  const seed = seedOverride || test.random_seed || generateSeed();

  const preflight = validateTestDefinition(test, normalized, { checkAvailability: mode !== 'manual' });
  if (!preflight.valid) {
    throw new HttpError(422, 'The test configuration is not valid yet.', preflight);
  }

  const selection = generateSelection({
    sections: normalized,
    mode,
    seed,
    preventDuplicates,
    allowPartial,
  });

  const finalCheck = validateTestDefinition(test, normalized, { checkAvailability: false, selection });
  if (!finalCheck.valid) {
    throw new HttpError(422, 'The generated test failed validation.', finalCheck);
  }

  const totalMarks = selection.sections.reduce((a, s) => a + s.marks, 0);

  const write = db.transaction(() => {
    const testId = nextTestId(db);
    const info = db
      .prepare(
        `INSERT INTO tests (test_id, test_name, description, course, duration_minutes, total_marks,
                            instructions, starts_at, ends_at, status, generation_mode,
                            randomize_questions, randomize_options, prevent_duplicates,
                            include_qid_in_student, random_seed, template_id, parent_test_id,
                            version_label, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        testId,
        test.test_name,
        test.description ?? null,
        test.course ?? null,
        Number(test.duration_minutes ?? 60),
        totalMarks,
        test.instructions ?? null,
        test.starts_at ?? null,
        test.ends_at ?? null,
        test.status ?? 'draft',
        mode,
        bool(test.randomize_questions, 1),
        bool(test.randomize_options, 1),
        bool(test.prevent_duplicates, 1),
        bool(test.include_qid_in_student, 0),
        seed,
        templateId,
        parentTestId,
        versionLabel,
        user.id,
      );

    persistSections(db, info.lastInsertRowid, normalized, selection);
    return { id: info.lastInsertRowid, testId };
  });

  const { id } = write();
  audit(user.id, 'test.create', 'test', String(id), { mode, seed, sections: normalized.length });
  return { ...getTest(id), warnings: selection.warnings };
}

function persistSections(db, testDbId, normalized, selection) {
  const insertSection = db.prepare(
    `INSERT INTO test_sections (test_id, section_name, section_description, section_order,
                                question_count, marks_per_question, negative_marks,
                                time_limit_minutes, selection_rules)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertQuestion = db.prepare(
    `INSERT INTO test_questions (test_id, section_id, question_id, qid, question_order, marks, selection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  normalized.forEach((section, index) => {
    const result = selection.sections[index];
    const sectionInfo = insertSection.run(
      testDbId,
      section.section_name,
      section.section_description,
      section.section_order,
      result.delivered,
      section.marks_per_question,
      section.negative_marks,
      section.time_limit_minutes,
      JSON.stringify({ rule: section.rule, distribution: section.distribution, randomize: section.randomize }),
    );

    for (const q of result.questions) {
      insertQuestion.run(
        testDbId,
        sectionInfo.lastInsertRowid,
        q.questionId,
        q.qid,
        q.order,
        q.marks,
        JSON.stringify(q.reason),
      );
    }
  });
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function getTestRow(id) {
  const db = getDb();
  const byId = Number.isInteger(Number(id)) && String(Number(id)) === String(id);
  return byId
    ? db.prepare('SELECT * FROM tests WHERE id = ?').get(Number(id))
    : db.prepare('SELECT * FROM tests WHERE test_id = ?').get(String(id));
}

/** Full test with sections, question metadata and per-question audit reasons. */
export function getTest(id, { withAnswers = false, applyRandomization = false } = {}) {
  const db = getDb();
  const test = getTestRow(id);
  if (!test) throw notFound('Test not found');

  const sections = db
    .prepare('SELECT * FROM test_sections WHERE test_id = ? ORDER BY section_order, id')
    .all(test.id);

  const rows = db
    .prepare(
      `SELECT * FROM test_questions
        WHERE test_id = ?
        ORDER BY question_order, id`,
    )
    .all(test.id);

  const qids = rows.map((r) => r.qid);
  const loaded = new Map(getQuestionsByQids(qids, { withAnswers }).map((q) => [q.qid, q]));

  const bySection = new Map(sections.map((s) => [s.id, []]));
  for (const row of rows) {
    const question = loaded.get(row.qid);
    bySection.get(row.section_id)?.push({
      id: row.id,
      qid: row.qid,
      order: row.question_order,
      marks: row.marks,
      reason: safeJson(row.selection_reason),
      question: question || { qid: row.qid, missing: true },
    });
  }

  const creator = test.created_by
    ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(test.created_by)
    : null;

  const shapedSections = sections.map((s) => {
    let questions = bySection.get(s.id) || [];
    if (applyRandomization && test.randomize_options) {
      questions = questions.map((entry) => ({
        ...entry,
        question: randomizeOptions([entry.question], `${test.random_seed}:opt`)[0],
      }));
    }
    return {
      ...s,
      selection_rules: safeJson(s.selection_rules),
      questions,
      marks: questions.reduce((a, q) => a + q.marks, 0),
    };
  });

  return {
    ...test,
    randomize_questions: !!test.randomize_questions,
    randomize_options: !!test.randomize_options,
    prevent_duplicates: !!test.prevent_duplicates,
    include_qid_in_student: !!test.include_qid_in_student,
    createdBy: creator,
    sections: shapedSections,
    summary: summarize(test, shapedSections),
  };
}

/** Test summary block shown in the preview panel (spec §11). */
function summarize(test, sections) {
  const questions = sections.flatMap((s) => s.questions);
  const byDifficulty = {};
  const byType = {};
  const bySubject = {};
  const byArea = {};
  for (const entry of questions) {
    const q = entry.question || {};
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
    byType[q.question_type] = (byType[q.question_type] || 0) + 1;
    // A multi-mapped question contributes to each branch it belongs to.
    for (const subject of q.subjects || []) bySubject[subject] = (bySubject[subject] || 0) + 1;
    for (const area of q.areas || []) byArea[area] = (byArea[area] || 0) + 1;
  }
  return {
    totalQuestions: questions.length,
    totalMarks: questions.reduce((a, q) => a + q.marks, 0),
    totalSections: sections.length,
    durationMinutes: test.duration_minutes,
    estimatedMinutes: Math.round(
      questions.reduce((a, q) => a + (q.question?.expected_seconds || 0), 0) / 60,
    ),
    byDifficulty,
    byType,
    bySubject,
    byArea,
    sections: sections.map((s) => ({
      id: s.id,
      name: s.section_name,
      questions: s.questions.length,
      marks: s.marks,
    })),
  };
}

/** Paginated test history (spec §18). */
export function listTests({ user, page = 1, pageSize = 20, status, search, mine = false, includeArchived = true }) {
  const db = getDb();
  const clauses = [];
  const params = [];

  // Creators see their own tests; admins and viewers see all.
  if (mine || user.role === 'creator') { clauses.push('t.created_by = ?'); params.push(user.id); }
  if (status) { clauses.push('t.status = ?'); params.push(status); }
  if (!includeArchived) clauses.push(`t.status <> 'archived'`);
  if (search) {
    clauses.push('(t.test_name LIKE ? ESCAPE \'\\\' OR t.test_id LIKE ? ESCAPE \'\\\')');
    const like = `%${String(search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const size = Math.min(Math.max(1, Number(pageSize) || 20), 100);
  const pageNo = Math.max(1, Number(page) || 1);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tests t ${where}`).get(...params).n;
  const items = db
    .prepare(
      `SELECT t.id, t.test_id, t.test_name, t.course, t.status, t.duration_minutes, t.total_marks,
              t.generation_mode, t.version_label, t.parent_test_id, t.created_at, t.random_seed,
              u.name AS created_by_name,
              (SELECT COUNT(*) FROM test_questions tq WHERE tq.test_id = t.id) AS question_count,
              (SELECT COUNT(*) FROM test_sections ts WHERE ts.test_id = t.id) AS section_count
         FROM tests t LEFT JOIN users u ON u.id = t.created_by
         ${where}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, size, (pageNo - 1) * size);

  return { items, total, page: pageNo, pageSize: size, pageCount: Math.max(1, Math.ceil(total / size)) };
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export function updateTestMeta(id, patch, user) {
  const db = getDb();
  const test = getTestRow(id);
  if (!test) throw notFound('Test not found');

  const fields = [];
  const params = [];
  for (const key of TEST_COLUMNS) {
    if (patch[key] === undefined) continue;
    fields.push(`${key} = ?`);
    const boolish = ['randomize_questions', 'randomize_options', 'prevent_duplicates', 'include_qid_in_student'];
    params.push(boolish.includes(key) ? bool(patch[key]) : patch[key]);
  }
  if (!fields.length) return getTest(test.id);

  fields.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE tests SET ${fields.join(', ')} WHERE id = ?`).run(...params, test.id);
  audit(user.id, 'test.update', 'test', String(test.id), Object.keys(patch));
  return getTest(test.id);
}

export function deleteTest(id, user) {
  const db = getDb();
  const test = getTestRow(id);
  if (!test) throw notFound('Test not found');
  db.prepare('DELETE FROM tests WHERE id = ?').run(test.id);
  audit(user.id, 'test.delete', 'test', String(test.id), { test_id: test.test_id });
  return { deleted: true, test_id: test.test_id };
}

/** Copies configuration and question selection verbatim. */
export function duplicateTest(id, user, { name } = {}) {
  const db = getDb();
  const source = getTest(id);

  const clone = db.transaction(() => {
    const testId = nextTestId(db);
    const info = db
      .prepare(
        `INSERT INTO tests (test_id, test_name, description, course, duration_minutes, total_marks,
                            instructions, starts_at, ends_at, status, generation_mode, randomize_questions,
                            randomize_options, prevent_duplicates, include_qid_in_student, random_seed,
                            template_id, parent_test_id, version_label, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        testId,
        name || `${source.test_name} (Copy)`,
        source.description, source.course, source.duration_minutes, source.total_marks,
        source.instructions, source.starts_at, source.ends_at, source.generation_mode,
        bool(source.randomize_questions, 1), bool(source.randomize_options, 1),
        bool(source.prevent_duplicates, 1), bool(source.include_qid_in_student, 0),
        source.random_seed, source.template_id, source.parent_test_id, source.version_label, user.id,
      );

    const newTestId = info.lastInsertRowid;
    const insertSection = db.prepare(
      `INSERT INTO test_sections (test_id, section_name, section_description, section_order,
                                  question_count, marks_per_question, negative_marks, time_limit_minutes, selection_rules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertQuestion = db.prepare(
      `INSERT INTO test_questions (test_id, section_id, question_id, qid, question_order, marks, selection_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const section of source.sections) {
      const sectionInfo = insertSection.run(
        newTestId, section.section_name, section.section_description, section.section_order,
        section.question_count, section.marks_per_question, section.negative_marks,
        section.time_limit_minutes, JSON.stringify(section.selection_rules),
      );
      for (const entry of section.questions) {
        insertQuestion.run(
          newTestId, sectionInfo.lastInsertRowid, entry.question.id, entry.qid,
          entry.order, entry.marks, JSON.stringify(entry.reason),
        );
      }
    }
    return newTestId;
  });

  const newId = clone();
  audit(user.id, 'test.duplicate', 'test', String(newId), { from: source.test_id });
  return getTest(newId);
}

/** Re-runs generation from the stored rules with a new (or given) seed. */
export function regenerateTest(id, user, { seed = null } = {}) {
  const db = getDb();
  const source = getTest(id);
  const sections = source.sections.map((s) => ({
    section_name: s.section_name,
    section_description: s.section_description,
    section_order: s.section_order,
    question_count: s.selection_rules?.distribution ? s.question_count : s.question_count,
    marks_per_question: s.marks_per_question,
    negative_marks: s.negative_marks,
    time_limit_minutes: s.time_limit_minutes,
    rule: s.selection_rules?.rule ?? {},
    distribution: s.selection_rules?.distribution ?? null,
    randomize: s.selection_rules?.randomize !== false,
  }));

  const newSeed = seed || generateSeed();
  const selection = generateSelection({
    sections,
    mode: 'automatic',
    seed: newSeed,
    preventDuplicates: !!source.prevent_duplicates,
    allowPartial: true,
  });

  const apply = db.transaction(() => {
    db.prepare('DELETE FROM test_questions WHERE test_id = ?').run(source.id);
    db.prepare('DELETE FROM test_sections WHERE test_id = ?').run(source.id);
    persistSections(db, source.id, sections, selection);
    const totalMarks = selection.sections.reduce((a, s) => a + s.marks, 0);
    db.prepare(`UPDATE tests SET random_seed = ?, total_marks = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newSeed, totalMarks, source.id);
  });

  apply();
  audit(user.id, 'test.regenerate', 'test', String(source.id), { seed: newSeed });
  return { ...getTest(source.id), warnings: selection.warnings };
}

/** Creates sibling versions A/B/C… from one test's rules (spec §17). */
export function createVersions(id, user, { count = 2, uniqueAcrossVersions = false, seed = null }) {
  const source = getTest(id);
  const sections = source.sections.map((s) => ({
    section_name: s.section_name,
    section_description: s.section_description,
    section_order: s.section_order,
    question_count: s.question_count,
    marks_per_question: s.marks_per_question,
    negative_marks: s.negative_marks,
    time_limit_minutes: s.time_limit_minutes,
    rule: s.selection_rules?.rule ?? {},
    distribution: s.selection_rules?.distribution ?? null,
  }));

  const { versions } = generateVersions({
    sections,
    count,
    seed: seed || source.random_seed,
    preventDuplicates: !!source.prevent_duplicates,
    uniqueAcrossVersions,
    allowPartial: true,
  });

  const db = getDb();
  const created = [];

  const write = db.transaction(() => {
    for (const version of versions) {
      const testId = nextTestId(db);
      const info = db
        .prepare(
          `INSERT INTO tests (test_id, test_name, description, course, duration_minutes, total_marks,
                              instructions, starts_at, ends_at, status, generation_mode, randomize_questions,
                              randomize_options, prevent_duplicates, include_qid_in_student, random_seed,
                              template_id, parent_test_id, version_label, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'automatic', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          testId,
          `${source.test_name} — Version ${version.label}`,
          source.description, source.course, source.duration_minutes,
          version.sections.reduce((a, s) => a + s.marks, 0),
          source.instructions, source.starts_at, source.ends_at,
          bool(source.randomize_questions, 1), bool(source.randomize_options, 1),
          bool(source.prevent_duplicates, 1), bool(source.include_qid_in_student, 0),
          version.seed, source.template_id, source.id, version.label, user.id,
        );
      persistSections(db, info.lastInsertRowid, sections, version);
      created.push({ id: info.lastInsertRowid, test_id: testId, label: version.label, warnings: version.warnings });
    }
  });

  write();
  audit(user.id, 'test.versions', 'test', String(source.id), { count: created.length });
  return created.map((c) => ({ ...c, ...listSummary(c.id) }));
}

function listSummary(id) {
  const db = getDb();
  return db
    .prepare(
      `SELECT test_name, total_marks, random_seed, version_label,
              (SELECT COUNT(*) FROM test_questions tq WHERE tq.test_id = tests.id) AS question_count
         FROM tests WHERE id = ?`,
    )
    .get(id);
}

/* ------------------------------------------------------------------ *
 * Question-level editing (hybrid mode, spec §8, §12)
 * ------------------------------------------------------------------ */

function loadSection(testDbId, sectionId) {
  const section = getDb()
    .prepare('SELECT * FROM test_sections WHERE id = ? AND test_id = ?')
    .get(sectionId, testDbId);
  if (!section) throw notFound('Section not found in this test');
  return { ...section, selection_rules: safeJson(section.selection_rules) };
}

function usedQids(testDbId) {
  return getDb().prepare('SELECT qid FROM test_questions WHERE test_id = ?').all(testDbId).map((r) => r.qid);
}

/** Alternatives for one slot, matching the same section rule (spec §12). */
export function replacementOptions(testDbId, testQuestionId, { limit = 20 } = {}) {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM test_questions WHERE id = ? AND test_id = ?').get(testQuestionId, testDbId);
  if (!entry) throw notFound('Question not found in this test');

  const section = loadSection(testDbId, entry.section_id);
  const reason = safeJson(entry.selection_reason);
  const rule = reason.rule && Object.keys(reason.rule).length ? reason.rule : section.selection_rules.rule || {};

  const { available, candidates } = findReplacements({
    rule,
    excludeQids: usedQids(testDbId),
    limit,
  });
  return { current: entry.qid, rule, available, candidates };
}

export function replaceQuestion(testDbId, testQuestionId, newQid, user) {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM test_questions WHERE id = ? AND test_id = ?').get(testQuestionId, testDbId);
  if (!entry) throw notFound('Question not found in this test');

  const test = db.prepare('SELECT prevent_duplicates FROM tests WHERE id = ?').get(testDbId);
  const [question] = getQuestionsByQids([newQid]);
  if (!question) throw badRequest(`${newQid} is not in the question bank.`);

  if (test.prevent_duplicates) {
    const clash = db
      .prepare('SELECT 1 FROM test_questions WHERE test_id = ? AND qid = ? AND id <> ?')
      .get(testDbId, newQid, testQuestionId);
    if (clash) throw conflict(`${newQid} is already used in this test.`);
  }

  const reason = safeJson(entry.selection_reason);
  db.prepare(
    `UPDATE test_questions SET qid = ?, question_id = ?, selection_reason = ? WHERE id = ?`,
  ).run(newQid, question.id, JSON.stringify({ ...reason, bucket: 'manual-replacement', replacedFrom: entry.qid }), testQuestionId);

  audit(user.id, 'test.replaceQuestion', 'test', String(testDbId), { from: entry.qid, to: newQid });
  return getTest(testDbId);
}

export function addQuestions(testDbId, sectionId, qids, user) {
  const db = getDb();
  const section = loadSection(testDbId, sectionId);
  const test = db.prepare('SELECT prevent_duplicates FROM tests WHERE id = ?').get(testDbId);
  const existing = new Set(usedQids(testDbId));
  const questions = getQuestionsByQids(qids);

  const missing = qids.filter((q) => !questions.some((x) => x.qid === q));
  if (missing.length) throw badRequest(`Not in the question bank: ${missing.join(', ')}`);

  const insert = db.prepare(
    `INSERT INTO test_questions (test_id, section_id, question_id, qid, question_order, marks, selection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(question_order), 0) AS m FROM test_questions WHERE test_id = ? AND section_id = ?')
    .get(testDbId, sectionId).m;

  const run = db.transaction(() => {
    let order = maxOrder;
    for (const question of questions) {
      if (test.prevent_duplicates && existing.has(question.qid)) {
        throw conflict(`${question.qid} is already used in this test.`);
      }
      existing.add(question.qid);
      order += 1;
      insert.run(
        testDbId, sectionId, question.id, question.qid, order, section.marks_per_question,
        JSON.stringify({ rule: section.selection_rules.rule || {}, bucket: 'manual-add' }),
      );
    }
    syncSectionCounts(db, testDbId);
  });

  run();
  audit(user.id, 'test.addQuestions', 'test', String(testDbId), { section: sectionId, qids });
  return getTest(testDbId);
}

export function removeQuestion(testDbId, testQuestionId, user) {
  const db = getDb();
  const run = db.transaction(() => {
    const changes = db.prepare('DELETE FROM test_questions WHERE id = ? AND test_id = ?').run(testQuestionId, testDbId).changes;
    if (!changes) throw notFound('Question not found in this test');
    syncSectionCounts(db, testDbId);
  });
  run();
  audit(user.id, 'test.removeQuestion', 'test', String(testDbId), { testQuestionId });
  return getTest(testDbId);
}

/** Moves a question to another section (spec §8, hybrid mode). */
export function moveQuestion(testDbId, testQuestionId, targetSectionId, user) {
  const db = getDb();
  const target = loadSection(testDbId, targetSectionId);
  const run = db.transaction(() => {
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(question_order), 0) AS m FROM test_questions WHERE test_id = ? AND section_id = ?')
      .get(testDbId, targetSectionId).m;
    const changes = db
      .prepare('UPDATE test_questions SET section_id = ?, question_order = ?, marks = ? WHERE id = ? AND test_id = ?')
      .run(targetSectionId, maxOrder + 1, target.marks_per_question, testQuestionId, testDbId).changes;
    if (!changes) throw notFound('Question not found in this test');
    syncSectionCounts(db, testDbId);
  });
  run();
  audit(user.id, 'test.moveQuestion', 'test', String(testDbId), { testQuestionId, targetSectionId });
  return getTest(testDbId);
}

/** Persists an explicit question order within a section. */
export function reorderSection(testDbId, sectionId, orderedIds, user) {
  const db = getDb();
  const run = db.transaction(() => {
    const stmt = db.prepare('UPDATE test_questions SET question_order = ? WHERE id = ? AND test_id = ? AND section_id = ?');
    orderedIds.forEach((testQuestionId, index) => stmt.run(index + 1, testQuestionId, testDbId, sectionId));
  });
  run();
  audit(user.id, 'test.reorder', 'test', String(testDbId), { sectionId });
  return getTest(testDbId);
}

function syncSectionCounts(db, testDbId) {
  db.prepare(
    `UPDATE test_sections
        SET question_count = (SELECT COUNT(*) FROM test_questions tq WHERE tq.section_id = test_sections.id)
      WHERE test_id = ?`,
  ).run(testDbId);
  db.prepare(
    `UPDATE tests
        SET total_marks = COALESCE((SELECT SUM(marks) FROM test_questions tq WHERE tq.test_id = tests.id), 0),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(testDbId);
}

/** "Why was this question selected?" (spec §25). */
export function explainTestQuestion(testDbId, testQuestionId) {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM test_questions WHERE id = ? AND test_id = ?').get(testQuestionId, testDbId);
  if (!entry) throw notFound('Question not found in this test');
  const [question] = getQuestionsByQids([entry.qid]);
  if (!question) throw notFound('The underlying question is no longer in the bank');

  const reason = safeJson(entry.selection_reason);
  const section = loadSection(testDbId, entry.section_id);
  const rule = reason.rule && Object.keys(reason.rule).length ? reason.rule : section.selection_rules.rule || {};
  const poolSize = countMatching(rule);

  return {
    ...explainSelection(question, { ...reason, rule }),
    section: section.section_name,
    poolSize,
    seed: db.prepare('SELECT random_seed FROM tests WHERE id = ?').get(testDbId)?.random_seed,
  };
}

function safeJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

export function audit(userId, action, entityType, entityId, details) {
  try {
    getDb()
      .prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
      .run(userId ?? null, action, entityType, entityId, details ? JSON.stringify(details) : null);
  } catch {
    // Auditing must never break the request it is recording.
  }
}
