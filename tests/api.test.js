/** HTTP API: authentication, RBAC, test lifecycle, availability, audit. */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, cleanup, sampleTest } from './helpers.js';

let http;
let adminToken;

before(async () => {
  http = await startServer();
  adminToken = await http.login();
});

after(async () => {
  await http.close();
  cleanup();
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await http.get('/api/tests')).status, 401);
  assert.equal((await http.get('/api/questions/statistics')).status, 401);
  assert.equal((await http.get('/api/tests', { token: 'not-a-real-token' })).status, 401);
});

test('login returns a token and the role capability list', async () => {
  const result = await http.post('/api/auth/login', { email: 'admin@test.local', password: 'Admin@12345' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.role, 'admin');
  assert.ok(result.body.permissions.includes('users:write'));

  const bad = await http.post('/api/auth/login', { email: 'admin@test.local', password: 'wrong' });
  assert.equal(bad.status, 401);
  // The message must not reveal whether the account exists.
  assert.match(bad.body.error.message, /Incorrect email or password/);
});

test('question search is paginated and filtered server-side', async () => {
  const result = await http.post('/api/questions/search', {
    filter: { question_type: ['MCQ'], subject: ['Operating System'] },
    page: 1,
    pageSize: 5,
  }, { token: adminToken });

  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 5);
  assert.ok(result.body.total > 5);
  assert.ok(result.body.items.every((q) => q.question_type === 'MCQ'));
  assert.ok(result.body.items.every((q) => q.subjects.includes('Operating System')));
  // Answers are never included in a plain search.
  assert.ok(result.body.items.every((q) => q.answer_text === undefined));
});

test('page size is capped so a client cannot pull the whole bank', async () => {
  const result = await http.post('/api/questions/search', { filter: {}, pageSize: 100000 }, { token: adminToken });
  assert.equal(result.status, 400, 'an absurd page size is rejected by validation');

  const capped = await http.post('/api/questions/search', { filter: {}, pageSize: 200 }, { token: adminToken });
  assert.ok(capped.body.items.length <= 200);
});

test('areas cascade from the subject and sub-areas from the area', async () => {
  const areas = await http.get('/api/questions/facets/area?parent=Operating%20System', { token: adminToken });
  assert.equal(areas.status, 200);
  assert.equal(areas.body.length, 8);
  assert.ok(areas.body.some((r) => r.value === 'Memory Management'));
  assert.ok(!areas.body.some((r) => r.value === 'Normalization'), 'DBMS areas must not appear under Operating System');

  const subAreas = await http.get('/api/questions/facets/sub_area?parent=Memory%20Management', { token: adminToken });
  assert.equal(subAreas.status, 200);
  assert.deepEqual(
    subAreas.body.map((r) => r.value).sort(),
    ['Address Spaces and Allocation', 'Virtual Memory and Paging'],
  );
});

test('the taxonomy tree is served whole for the browser', async () => {
  const result = await http.get('/api/questions/taxonomy', { token: adminToken });
  assert.equal(result.status, 200);
  assert.equal(result.body.tree.length, 35);
  assert.equal(result.body.tree.reduce((a, s) => a + s.areas.length, 0), 293);
});

test('tag suggestions can be scoped to a taxonomy branch', async () => {
  const scoped = await http.get('/api/questions/tags?source=taxonomy&area=Memory%20Management', { token: adminToken });
  assert.equal(scoped.status, 200);
  const values = scoped.body.map((t) => t.value);
  assert.ok(values.includes('Demand Paging'));
  assert.ok(!values.includes('Bankers Algorithm'), 'a sibling area\'s tags must not leak in');
});

test('live availability responds with counts and remedies', async () => {
  const ok = await http.post('/api/tests/availability/section', {
    section: { section_name: 'S', question_count: 5, marks_per_question: 1, rule: { question_type: ['MCQ'] } },
  }, { token: adminToken });
  assert.equal(ok.body.sufficient, true);
  assert.ok(ok.body.available > 5);

  const short = await http.post('/api/tests/availability/section', {
    section: { section_name: 'S', question_count: 99999, marks_per_question: 1, rule: { question_type: ['MCQ'], subject: ['Operating System'], difficulty: ['Hard'] } },
  }, { token: adminToken });
  assert.equal(short.body.sufficient, false);
  assert.ok(short.body.suggestions.length > 0);
});

test('validation endpoint reports problems instead of rejecting the request', async () => {
  const result = await http.post('/api/tests/validate', {
    test: { test_name: '', duration_minutes: 0 },
    sections: [],
  }, { token: adminToken });

  assert.equal(result.status, 200, 'a malformed draft must still receive a validation report');
  assert.equal(result.body.valid, false);
  assert.ok(result.body.errors.length >= 3);
});

test('a test is created, stored by QID only, and read back complete', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  assert.equal(created.status, 201);

  const test = created.body;
  assert.match(test.test_id, /^TST\d{5}$/);
  assert.equal(test.sections.length, 3);
  assert.equal(test.summary.totalQuestions, 11);
  assert.equal(test.summary.totalMarks, 6 * 2 + 2 * 10 + 3 * 2);
  assert.equal(test.random_seed, 'DSA2026');

  const qids = test.sections.flatMap((s) => s.questions.map((q) => q.qid));
  assert.equal(new Set(qids).size, qids.length, 'no duplicate QIDs across sections');

  // Each section's questions must genuinely belong to the branch it asked for.
  const osSection = test.sections.find((s) => s.section_name === 'Operating Systems');
  assert.ok(osSection.questions.every((e) => e.question.subjects.includes('Operating System')));
  const dbSection = test.sections.find((s) => s.section_name === 'Databases');
  assert.ok(dbSection.questions.every((e) => e.question.subjects.includes('DBMS')));

  // Each stored row references the bank rather than copying the content.
  for (const section of test.sections) {
    for (const entry of section.questions) {
      assert.ok(entry.question.qid === entry.qid);
      assert.ok(entry.question.question_text.length > 0);
    }
  }
});

test('the same seed regenerates the same test', async () => {
  const first = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const second = await http.post('/api/tests', sampleTest(), { token: adminToken });

  const qids = (t) => t.body.sections.flatMap((s) => s.questions.map((q) => q.qid));
  assert.deepEqual(qids(first), qids(second));
});

test('regenerate keeps the rules but changes the questions', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const before = created.body.sections.flatMap((s) => s.questions.map((q) => q.qid));

  const regenerated = await http.post(`/api/tests/${created.body.id}/regenerate`, {}, { token: adminToken });
  assert.equal(regenerated.status, 200);
  const after = regenerated.body.sections.flatMap((s) => s.questions.map((q) => q.qid));

  assert.notDeepEqual(before, after, 'a new seed must produce a different selection');
  assert.equal(regenerated.body.sections.length, 3);
  assert.equal(regenerated.body.summary.totalQuestions, 11);
  assert.deepEqual(
    regenerated.body.sections.map((s) => s.section_name),
    ['Operating Systems', 'Coding', 'Databases'],
  );
});

test('replace swaps a question for another matching the same rule', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const testId = created.body.id;
  const entry = created.body.sections[0].questions[0];

  const options = await http.get(`/api/tests/${testId}/questions/${entry.id}/replacements?limit=5`, { token: adminToken });
  assert.equal(options.status, 200);
  assert.ok(options.body.candidates.length > 0);
  assert.ok(options.body.candidates.every((c) => c.question_type === 'MCQ'));
  assert.ok(options.body.candidates.every((c) => c.subjects.includes('Operating System')));

  const replacement = options.body.candidates[0].qid;
  const replaced = await http.post(`/api/tests/${testId}/questions/${entry.id}/replace`, { qid: replacement }, { token: adminToken });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.sections[0].questions[0].qid, replacement);

  // Section configuration is untouched by a replacement.
  assert.equal(replaced.body.sections[0].marks_per_question, 2);
  assert.equal(replaced.body.summary.totalQuestions, 11);
});

test('replacing with a QID already in the test is refused', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const [first, second] = created.body.sections[0].questions;

  const result = await http.post(
    `/api/tests/${created.body.id}/questions/${first.id}/replace`,
    { qid: second.qid },
    { token: adminToken },
  );
  assert.equal(result.status, 409);
  assert.match(result.body.error.message, /already used/);
});

test('explain returns a pass/fail line per criterion', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const entry = created.body.sections[0].questions[0];

  const result = await http.get(`/api/tests/${created.body.id}/questions/${entry.id}/explain`, { token: adminToken });
  assert.equal(result.status, 200);
  assert.equal(result.body.matched, true);
  assert.ok(result.body.poolSize > 0);
  assert.ok(result.body.criteria.some((c) => c.criterion.includes('Question Type')));
  assert.ok(result.body.criteria.every((c) => c.passed));
});

test('versions are created as siblings of the source test', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const result = await http.post(`/api/tests/${created.body.id}/versions`, { count: 3, uniqueAcrossVersions: true }, { token: adminToken });

  assert.equal(result.status, 201);
  assert.equal(result.body.length, 3);
  assert.deepEqual(result.body.map((v) => v.label), ['A', 'B', 'C']);

  const versions = await http.get(`/api/tests/${created.body.id}/versions`, { token: adminToken });
  assert.ok(versions.body.length >= 4, 'the source plus its three versions');
});

test('add, move and remove keep section counts and marks consistent', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const testId = created.body.id;
  const [arrays, coding] = created.body.sections;

  const search = await http.post('/api/questions/search', {
    filter: { question_type: ['MCQ'], subject: ['Operating System'] }, pageSize: 50,
  }, { token: adminToken });
  const used = new Set(created.body.sections.flatMap((s) => s.questions.map((q) => q.qid)));
  const spare = search.body.items.find((q) => !used.has(q.qid));

  const added = await http.post(`/api/tests/${testId}/sections/${arrays.id}/questions`, { qids: [spare.qid] }, { token: adminToken });
  assert.equal(added.status, 200);
  assert.equal(added.body.summary.totalQuestions, 12);
  assert.equal(added.body.sections[0].question_count, 7);

  const moved = await http.post(
    `/api/tests/${testId}/questions/${added.body.sections[0].questions[6].id}/move`,
    { sectionId: coding.id },
    { token: adminToken },
  );
  assert.equal(moved.body.sections[0].question_count, 6);
  assert.equal(moved.body.sections[1].question_count, 3);
  // Marks follow the destination section's scheme.
  assert.equal(moved.body.sections[1].questions.at(-1).marks, 10);

  const removed = await http.del(
    `/api/tests/${testId}/questions/${moved.body.sections[1].questions.at(-1).id}`,
    { token: adminToken },
  );
  assert.equal(removed.body.summary.totalQuestions, 11);
});

test('adding a duplicate QID is refused', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const existing = created.body.sections[0].questions[0].qid;
  const result = await http.post(
    `/api/tests/${created.body.id}/sections/${created.body.sections[0].id}/questions`,
    { qids: [existing] },
    { token: adminToken },
  );
  assert.equal(result.status, 409);
});

test('duplicate copies the configuration and the selection', async () => {
  const created = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const copy = await http.post(`/api/tests/${created.body.id}/duplicate`, { name: 'Copy for review' }, { token: adminToken });

  assert.equal(copy.status, 201);
  assert.equal(copy.body.test_name, 'Copy for review');
  assert.equal(copy.body.status, 'draft');
  assert.deepEqual(
    copy.body.sections.flatMap((s) => s.questions.map((q) => q.qid)),
    created.body.sections.flatMap((s) => s.questions.map((q) => q.qid)),
  );
  assert.notEqual(copy.body.test_id, created.body.test_id);
});

test('a manual-mode test uses exactly the supplied QIDs', async () => {
  const search = await http.post('/api/questions/search', {
    filter: { question_type: ['MCQ'], subject: ['DBMS'] }, pageSize: 4,
  }, { token: adminToken });
  const qids = search.body.items.map((q) => q.qid);

  const created = await http.post('/api/tests', {
    test: { test_name: 'Hand-picked', duration_minutes: 30, status: 'draft' },
    mode: 'manual',
    sections: [{ section_name: 'Chosen', question_count: qids.length, marks_per_question: 1, qids }],
  }, { token: adminToken });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.sections[0].questions.map((q) => q.qid).sort(), [...qids].sort());
});

test('blueprints expand into sections with feasibility data', async () => {
  const result = await http.post('/api/templates/blueprints/expand', { blueprintId: 'dsa-placement' }, { token: adminToken });
  assert.equal(result.status, 200);
  assert.equal(result.body.totalQuestions, 50);
  assert.equal(result.body.sections.reduce((a, s) => a + s.question_count, 0), 50);
  assert.equal(result.body.feasibility.length, result.body.sections.length);
  assert.ok(result.body.sections.every((s) => s.distribution?.values));
  // Blueprints scope by subject now, not by a flat topic list.
  assert.ok(result.body.sections.every((s) => s.rule.subject?.length));
});

test('templates round-trip a full builder configuration', async () => {
  const payload = sampleTest();
  const created = await http.post('/api/templates', {
    template_name: 'Round trip template',
    description: 'created by the test suite',
    configuration: { test: payload.test, sections: payload.sections },
  }, { token: adminToken });

  assert.equal(created.status, 201);
  const fetched = await http.get(`/api/templates/${created.body.id}`, { token: adminToken });
  assert.equal(fetched.body.configuration.sections.length, 3);
  assert.equal(fetched.body.configuration.test.test_name, 'Advanced DSA Assessment');

  const duplicate = await http.post('/api/templates', {
    template_name: 'Round trip template',
    configuration: { test: {}, sections: [] },
  }, { token: adminToken });
  assert.equal(duplicate.status, 409);
});

/* ----------------------------- RBAC (spec §29) ---------------------------- */

test('a viewer can read but never write', async () => {
  const token = await http.login('viewer@example.com', 'Viewer@12345');

  assert.equal((await http.get('/api/tests', { token })).status, 200);
  assert.equal((await http.get('/api/questions/statistics', { token })).status, 200);
  assert.equal((await http.post('/api/tests', sampleTest(), { token })).status, 403);
  assert.equal((await http.get('/api/users', { token })).status, 403);
  assert.equal((await http.post('/api/templates', { template_name: 'x', configuration: { test: {}, sections: [] } }, { token })).status, 403);
});

test('a creator cannot modify another user\'s test', async () => {
  const admins = await http.post('/api/tests', sampleTest(), { token: adminToken });
  const token = await http.login('creator@example.com', 'Creator@12345');

  assert.equal((await http.post('/api/tests', sampleTest(), { token })).status, 201);
  assert.equal((await http.patch(`/api/tests/${admins.body.id}`, { test_name: 'hijacked' }, { token })).status, 403);
  assert.equal((await http.del(`/api/tests/${admins.body.id}`, { token })).status, 403);
  assert.equal((await http.get('/api/users', { token })).status, 403);
});

test('the last active administrator cannot be demoted or disabled', async () => {
  const users = await http.get('/api/users', { token: adminToken });
  const admins = users.body.filter((u) => u.role === 'admin' && u.is_active);
  assert.equal(admins.length, 1, 'this fixture has exactly one admin');

  const demote = await http.patch(`/api/users/${admins[0].id}`, { role: 'viewer' }, { token: adminToken });
  assert.equal(demote.status, 400);
  assert.match(demote.body.error.message, /last active administrator/);
});

test('deactivating a user invalidates their existing token immediately', async () => {
  const created = await http.post('/api/users', {
    email: 'temp@test.local', name: 'Temp User', password: 'Temp@12345', role: 'creator',
  }, { token: adminToken });
  const token = await http.login('temp@test.local', 'Temp@12345');
  assert.equal((await http.get('/api/tests', { token })).status, 200);

  await http.patch(`/api/users/${created.body.id}`, { is_active: false }, { token: adminToken });
  assert.equal((await http.get('/api/tests', { token })).status, 401, 'the token must stop working at once');
});

test('every write is recorded in the audit log', async () => {
  await http.post('/api/tests', sampleTest(), { token: adminToken });
  const audit = await http.get('/api/analytics/audit?limit=20', { token: adminToken });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some((row) => row.action === 'test.create'));
});
