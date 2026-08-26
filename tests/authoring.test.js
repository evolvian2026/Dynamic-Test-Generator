/**
 * Authoring the bank: question CRUD, bulk import, near-duplicate detection and
 * exposure control.
 *
 * These are the features that write to the bank rather than read from it, so
 * the assertions are mostly about what *cannot* happen — a PATCH that silently
 * wipes tags, a hard delete that orphans a generated test, an import that
 * guesses at a taxonomy it could not match.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, cleanup, sampleTest } from './helpers.js';

let http;
let admin;
let viewer;

const newQuestion = (overrides = {}) => ({
  question_text: 'Which scheduling algorithm can starve long jobs?',
  question_type: 'MCQ',
  difficulty: 'Medium',
  marks: 2,
  status: 'active',
  tags: ['scheduling', 'cpu'],
  attributes: { source: 'unit-test' },
  taxonomy: [{ subject: 'Operating System', area: 'Process Management', isPrimary: true }],
  options: [
    { option_text: 'Shortest Job First', is_correct: true },
    { option_text: 'First Come First Served', is_correct: false },
    { option_text: 'Round Robin', is_correct: false },
  ],
  ...overrides,
});

before(async () => {
  http = await startServer();
  admin = await http.login();

  // A viewer, to prove the write endpoints are closed to read-only roles.
  await http.post('/api/users', {
    name: 'Read Only', email: 'viewer@test.local', password: 'Viewer@12345', role: 'viewer',
  }, { token: admin });
  viewer = await http.login('viewer@test.local', 'Viewer@12345');
});

after(async () => {
  await http.close();
  cleanup();
});

/* ------------------------------------------------------------------ *
 * Question CRUD
 * ------------------------------------------------------------------ */

test('a created question gets a QID and resolves its taxonomy branch', async () => {
  const created = await http.post('/api/questions', newQuestion(), { token: admin });
  assert.equal(created.status, 201);
  assert.match(created.body.qid, /^QID\d+$/);
  assert.equal(created.body.subjects[0], 'Operating System');
  assert.deepEqual(created.body.tags.sort(), ['cpu', 'scheduling']);

  const fetched = await http.get(`/api/questions/${created.body.qid}`, { token: admin });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.question_text, newQuestion().question_text);
});

test('an MCQ without a correct option is refused', async () => {
  const result = await http.post('/api/questions', newQuestion({
    options: [
      { option_text: 'A', is_correct: false },
      { option_text: 'B', is_correct: false },
    ],
  }), { token: admin });
  assert.equal(result.status, 400);
  assert.match(JSON.stringify(result.body), /correct/i);
});

test('an unknown taxonomy branch is rejected rather than invented', async () => {
  const result = await http.post('/api/questions', newQuestion({
    taxonomy: [{ subject: 'Astrophysics', area: 'Stellar Nucleosynthesis' }],
  }), { token: admin });
  assert.equal(result.status, 400);
});

test('a PATCH that omits a field leaves it alone', async () => {
  const created = await http.post('/api/questions', newQuestion(), { token: admin });
  const { qid } = created.body;

  // Only the difficulty is sent. Tags, options and attributes must survive:
  // Zod's .partial() does not suppress .default(), so this is a real regression
  // risk rather than a theoretical one.
  const patched = await http.patch(`/api/questions/${qid}`, { difficulty: 'Hard' }, { token: admin });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.difficulty, 'Hard');
  assert.deepEqual(patched.body.tags.sort(), ['cpu', 'scheduling']);
  assert.equal(patched.body.options.length, 3);
  assert.equal(patched.body.attributes.source, 'unit-test');
});

test('a PATCH can replace tags and taxonomy explicitly', async () => {
  const { body } = await http.post('/api/questions', newQuestion(), { token: admin });
  const patched = await http.patch(`/api/questions/${body.qid}`, {
    tags: ['replaced'],
    taxonomy: [{ subject: 'DBMS', area: 'Normalization', isPrimary: true }],
  }, { token: admin });

  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.tags, ['replaced']);
  assert.equal(patched.body.subjects[0], 'DBMS');
});

test('retiring keeps the question; hard delete is refused while a test uses it', async () => {
  const { body: question } = await http.post('/api/questions', newQuestion(), { token: admin });

  const retired = await http.del(`/api/questions/${question.qid}`, { token: admin });
  assert.equal(retired.status, 200);
  assert.equal((await http.get(`/api/questions/${question.qid}`, { token: admin })).body.status, 'retired');

  // Put a fresh question into a real test, then try to delete it outright.
  const { body: used } = await http.post('/api/questions', newQuestion({
    question_text: 'A question that will be used by a test.',
  }), { token: admin });

  const created = await http.post('/api/tests', {
    ...sampleTest(),
    mode: 'manual',
    sections: [{
      section_name: 'Manual', question_count: 1, marks_per_question: 1, negative_marks: 0,
      rule: {}, qids: [used.qid],
    }],
  }, { token: admin });
  assert.equal(created.status, 201);

  const refused = await http.del(`/api/questions/${used.qid}?hard=true`, { token: admin });
  assert.equal(refused.status, 409);
  assert.equal((await http.get(`/api/questions/${used.qid}`, { token: admin })).status, 200);
});

test('a viewer cannot author or retire questions', async () => {
  assert.equal((await http.post('/api/questions', newQuestion(), { token: viewer })).status, 403);
  assert.equal((await http.patch('/api/questions/QID1', { difficulty: 'Hard' }, { token: viewer })).status, 403);
  assert.equal((await http.del('/api/questions/QID1', { token: viewer })).status, 403);
});

/* ------------------------------------------------------------------ *
 * Bulk import
 * ------------------------------------------------------------------ */

const importRows = [
  {
    question_text: 'Which normal form removes transitive dependencies?',
    type: 'MCQ', difficulty: 'Medium', marks: '2',
    subject: 'dbms', area: 'normalization', tags: 'normal-forms, keys',
    option_a: '1NF', option_b: '2NF', option_c: '3NF', option_d: 'BCNF', correct_option: 'C',
    source_book: 'Elmasri',
  },
  {
    question_text: 'A row with no subject at all, which cannot be classified.',
    type: 'MCQ', difficulty: 'Easy',
    option_a: 'yes', option_b: 'no', correct_option: 'A',
  },
];

test('import preview writes nothing and reports what would happen', async () => {
  const before = (await http.get('/api/questions/statistics', { token: admin })).body.total;

  const preview = await http.post('/api/questions/import/preview', { rows: importRows }, { token: admin });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.totals.rows, 2);
  assert.equal(preview.body.totals.ready, 1);
  assert.equal(preview.body.totals.needsAttention, 1);

  const [good, bad] = preview.body.items;
  assert.equal(good.valid, true);
  // "dbms" and "normalization" are matched against the taxonomy, not taken literally.
  assert.equal(good.taxonomy.subject, 'DBMS');
  assert.equal(good.taxonomy.area, 'Normalization');
  assert.equal(bad.valid, false);
  assert.ok(bad.issues.length > 0);

  // An unrecognised column becomes an extensible attribute rather than an error.
  assert.ok(preview.body.columns.attributeColumns.includes('source_book'));

  const after = (await http.get('/api/questions/statistics', { token: admin })).body.total;
  assert.equal(after, before, 'preview must not write to the bank');
});

test('import commit writes only the accepted rows', async () => {
  const preview = await http.post('/api/questions/import/preview', { rows: importRows }, { token: admin });
  const result = await http.post('/api/questions/import/commit', { items: preview.body.items }, { token: admin });

  assert.equal(result.status, 200);
  assert.equal(result.body.created, 1);
  assert.equal(result.body.skipped.length, 1);

  const qid = result.body.qids[0];
  const stored = await http.get(`/api/questions/${qid}?withAnswers=true`, { token: admin });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.subjects[0], 'DBMS');
  assert.deepEqual(stored.body.tags.sort(), ['keys', 'normal-forms']);
  assert.equal(stored.body.attributes.source_book, 'Elmasri');
  // The letter in correct_option must land on the right option.
  assert.equal(stored.body.options.find((o) => o.is_correct).option_text, '3NF');
});

test('import is closed to roles without the import capability', async () => {
  const result = await http.post('/api/questions/import/preview', { rows: importRows }, { token: viewer });
  assert.equal(result.status, 403);
});

/* ------------------------------------------------------------------ *
 * Near-duplicate detection
 * ------------------------------------------------------------------ */

test('two QIDs carrying the same question are reported as duplicates', async () => {
  const text = 'In a B+ tree of order 41, what is the maximum number of keys stored in an internal node?';
  const first = await http.post('/api/questions', newQuestion({ question_text: text }), { token: admin });
  // Same question, different reference number and light rewording — exactly the
  // shape a bank assembled from several sources produces.
  const second = await http.post('/api/questions', newQuestion({
    question_text: 'In a B+ tree of order 57, what is the maximum number of keys stored in an internal node?',
  }), { token: admin });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const similar = await http.get(`/api/questions/${first.body.qid}/similar?threshold=0.6`, { token: admin });
  assert.equal(similar.status, 200);
  assert.ok(similar.body.some((m) => m.qid === second.body.qid),
    'the near-identical question should be found');

});

test('the bank-wide report returns verified groups, worst offenders first', async () => {
  const report = await http.get('/api/questions/duplicates?threshold=0.6&limit=10', { token: admin });
  assert.equal(report.status, 200);
  assert.ok(report.body.groups.length > 0, 'the templated seed bank contains duplicate text');
  assert.ok(report.body.groups.length <= 10, 'the limit is honoured');

  for (const group of report.body.groups) {
    assert.ok(group.size >= 2);
    assert.equal(group.questions.length, group.size);
    // A shared fingerprint alone is not enough: every group is verified against
    // the requested threshold before it is reported.
    assert.ok(group.similarity >= 0.6);
  }

  // Groups are ordered by how many questions collide, so the report opens with
  // the worst offenders rather than an arbitrary pair.
  const sizes = report.body.groups.map((g) => g.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test('unrelated questions are not reported as duplicates', async () => {
  const a = await http.post('/api/questions', newQuestion({
    question_text: 'Explain the difference between preemptive and cooperative multitasking.',
  }), { token: admin });
  const similar = await http.get(`/api/questions/${a.body.qid}/similar?threshold=0.6`, { token: admin });
  assert.deepEqual(similar.body, []);
});

test('reindexing fingerprints is idempotent', async () => {
  const first = await http.post('/api/questions/duplicates/reindex', {}, { token: admin });
  assert.equal(first.status, 200);
  const second = await http.post('/api/questions/duplicates/reindex', {}, { token: admin });
  assert.equal(second.body.updated, 0, 'a second reindex has nothing left to do');
});

/* ------------------------------------------------------------------ *
 * Exposure control
 * ------------------------------------------------------------------ */

test('neverUsed excludes questions that a test already contains', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: admin });
  assert.equal(created.status, 201);
  const usedQid = created.body.sections[0].questions[0].qid;

  const rule = { question_type: ['MCQ'], subject: ['Operating System'] };
  const all = await http.post('/api/questions/count', { filter: rule }, { token: admin });
  const unused = await http.post('/api/questions/count', {
    filter: { ...rule, neverUsed: true },
  }, { token: admin });

  assert.ok(unused.body.available < all.body.available, 'excluding used questions must reduce the pool');

  const listed = await http.post('/api/questions/search', {
    filter: { ...rule, neverUsed: true }, pageSize: 200,
  }, { token: admin });
  assert.ok(!listed.body.items.some((q) => q.qid === usedQid));
});

test('a cooldown window excludes recently used questions', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: admin });
  const usedQid = created.body.sections[0].questions[0].qid;

  const cooled = await http.post('/api/questions/search', {
    filter: { question_type: ['MCQ'], subject: ['Operating System'], usedWithinDays: 30 },
    pageSize: 200,
  }, { token: admin });
  assert.ok(!cooled.body.items.some((q) => q.qid === usedQid));

  // The same rule with a zero-length window has nothing to exclude.
  const wide = await http.post('/api/questions/count', {
    filter: { question_type: ['MCQ'], subject: ['Operating System'] },
  }, { token: admin });
  assert.ok(wide.body.available > cooled.body.total, 'the cooldown must exclude at least the questions just used');
});

test('usage and exposure overview report real reuse', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: admin });
  const usedQid = created.body.sections[0].questions[0].qid;

  const usage = await http.get(`/api/questions/${usedQid}/usage`, { token: admin });
  assert.equal(usage.status, 200);
  assert.ok(usage.body.timesUsed >= 1);
  assert.ok(usage.body.tests.length >= 1);

  const overview = await http.get('/api/questions/exposure/overview', { token: admin });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.everUsed >= 1);
  assert.ok(overview.body.neverUsed > 0);
  assert.equal(overview.body.bankSize, overview.body.everUsed + overview.body.neverUsed);
  assert.ok(overview.body.mostExposed.length > 0);
});

test('an exposure rule is visible in the generation explanation', async () => {
  const created = await http.post('/api/tests', {
    ...sampleTest(),
    sections: [{
      section_name: 'Fresh only', question_count: 3, marks_per_question: 1, negative_marks: 0,
      rule: { question_type: ['MCQ'], subject: ['Operating System'], neverUsed: true },
    }],
  }, { token: admin });
  assert.equal(created.status, 201);

  const testQuestionId = created.body.sections[0].questions[0].id;
  const explain = await http.get(
    `/api/tests/${created.body.id}/questions/${testQuestionId}/explain`, { token: admin },
  );
  assert.equal(explain.status, 200);
  assert.match(JSON.stringify(explain.body).toLowerCase(), /used|exposure/);
});
