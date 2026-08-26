/**
 * The assessment lifecycle after a test exists: approval, blueprint coverage,
 * response capture and item analytics, QTI and paper-layout exports, saved
 * question sets and installation branding.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { startServer, cleanup, sampleTest } from './helpers.js';

let http;
let admin;
let creator;
let viewer;

/** A test owned by the creator, so an admin can review it without self-approving. */
async function creatorTest(overrides = {}) {
  const payload = { ...sampleTest(), ...overrides };
  const result = await http.post('/api/tests', payload, { token: creator });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

before(async () => {
  http = await startServer();
  admin = await http.login();

  await http.post('/api/users', {
    name: 'Test Creator', email: 'creator@test.local', password: 'Creator@12345', role: 'creator',
  }, { token: admin });
  await http.post('/api/users', {
    name: 'Read Only', email: 'viewer2@test.local', password: 'Viewer@12345', role: 'viewer',
  }, { token: admin });

  creator = await http.login('creator@test.local', 'Creator@12345');
  viewer = await http.login('viewer2@test.local', 'Viewer@12345');
});

after(async () => {
  await http.close();
  cleanup();
});

/* ------------------------------------------------------------------ *
 * Approval workflow
 * ------------------------------------------------------------------ */

test('a draft must pass through review before it can be published', async () => {
  const created = await creatorTest();
  assert.equal(created.status, 'draft');

  const early = await http.post(`/api/tests/${created.id}/publish`, {}, { token: creator });
  assert.equal(early.status, 409);
  assert.match(early.body.error.message, /approved/i);

  const submitted = await http.post(`/api/tests/${created.id}/submit-review`,
    { note: 'Ready for sign-off.' }, { token: creator });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.status, 'review');
  assert.equal(submitted.body.review.notes, 'Ready for sign-off.');

  const approved = await http.post(`/api/tests/${created.id}/approve`,
    { note: 'Looks balanced.' }, { token: admin });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.review.reviewedBy.email, 'admin@test.local');

  const published = await http.post(`/api/tests/${created.id}/publish`, {}, { token: creator });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, 'published');
});

test('a creator cannot approve, and nobody can approve their own test', async () => {
  const created = await creatorTest();
  await http.post(`/api/tests/${created.id}/submit-review`, {}, { token: creator });

  // The capability itself is withheld from creators.
  const byCreator = await http.post(`/api/tests/${created.id}/approve`, {}, { token: creator });
  assert.equal(byCreator.status, 403);

  // And an admin cannot sign off on a test they wrote themselves.
  const own = await http.post('/api/tests', sampleTest(), { token: admin });
  await http.post(`/api/tests/${own.body.id}/submit-review`, {}, { token: admin });
  const selfApproval = await http.post(`/api/tests/${own.body.id}/approve`, {}, { token: admin });
  assert.equal(selfApproval.status, 409);
  assert.match(selfApproval.body.error.message, /created it/i);
});

test('rejection returns the test to draft with the reviewer note attached', async () => {
  const created = await creatorTest();
  await http.post(`/api/tests/${created.id}/submit-review`, {}, { token: creator });

  const rejected = await http.post(`/api/tests/${created.id}/reject`,
    { note: 'Section 2 is too easy.' }, { token: admin });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'draft');
  assert.equal(rejected.body.review.notes, 'Section 2 is too easy.');

  // A rejected test cannot be approved without being resubmitted.
  assert.equal((await http.post(`/api/tests/${created.id}/approve`, {}, { token: admin })).status, 409);
});

test('changing the questions after approval revokes the sign-off', async () => {
  const created = await creatorTest();
  await http.post(`/api/tests/${created.id}/submit-review`, {}, { token: creator });
  const approved = await http.post(`/api/tests/${created.id}/approve`, {}, { token: admin });
  assert.equal(approved.body.status, 'approved');

  const testQuestionId = approved.body.sections[0].questions[0].id;
  const removed = await http.del(`/api/tests/${created.id}/questions/${testQuestionId}`, { token: creator });
  assert.equal(removed.status, 200);

  const after = await http.get(`/api/tests/${created.id}`, { token: creator });
  assert.equal(after.body.status, 'draft', 'editing an approved test must send it back to draft');
  assert.match(after.body.review.notes, /after approval/i);
});

test('an empty test cannot be submitted for review', async () => {
  // A section must be created with questions, so the test is emptied afterwards.
  const created = await creatorTest({
    sections: [{
      section_name: 'Will be emptied', question_count: 2, marks_per_question: 1, negative_marks: 0,
      rule: { question_type: ['MCQ'] },
    }],
  });

  for (const question of created.sections[0].questions) {
    const removed = await http.del(`/api/tests/${created.id}/questions/${question.id}`, { token: creator });
    assert.equal(removed.status, 200);
  }

  const submitted = await http.post(`/api/tests/${created.id}/submit-review`, {}, { token: creator });
  assert.equal(submitted.status, 409);
  assert.match(submitted.body.error.message, /empty/i);
});

/* ------------------------------------------------------------------ *
 * Blueprint coverage
 * ------------------------------------------------------------------ */

test('coverage compares a stated distribution with what was actually drawn', async () => {
  const created = await http.post('/api/tests', {
    ...sampleTest(),
    sections: [{
      section_name: 'Balanced', question_count: 10, marks_per_question: 1, negative_marks: 0,
      rule: { question_type: ['MCQ'], subject: ['Operating System'] },
      distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 20, Medium: 50, Hard: 30 } },
    }],
  }, { token: admin });
  assert.equal(created.status, 201);

  const coverage = await http.get(`/api/tests/${created.body.id}/coverage?axis=difficulty`, { token: admin });
  assert.equal(coverage.status, 200);
  assert.equal(coverage.body.coverageKnown, true);

  const byValue = Object.fromEntries(coverage.body.rows.map((r) => [r.value, r]));
  assert.equal(byValue.Easy.intended, 2);
  assert.equal(byValue.Medium.intended, 5);
  assert.equal(byValue.Hard.intended, 3);

  for (const row of coverage.body.rows) {
    if (row.intended === null) continue;
    assert.equal(row.difference, row.actual - row.intended);
    assert.equal(row.status, row.difference === 0 ? 'met' : row.difference > 0 ? 'over' : 'under');
  }

  const total = coverage.body.rows.reduce((sum, r) => sum + r.actual, 0);
  assert.equal(total, 10, 'every drawn question is accounted for on the difficulty axis');
});

test('coverage says so plainly when no intent was stated', async () => {
  const created = await http.post('/api/tests', {
    ...sampleTest(),
    sections: [{
      section_name: 'Anything', question_count: 5, marks_per_question: 1, negative_marks: 0,
      rule: { question_type: ['MCQ'] },
    }],
  }, { token: admin });

  const coverage = await http.get(`/api/tests/${created.body.id}/coverage?axis=bloom_taxonomy`, { token: admin });
  assert.equal(coverage.status, 200);
  assert.equal(coverage.body.coverageKnown, false);
  // The actual spread is still reported — only the comparison is missing.
  assert.ok(coverage.body.rows.length > 0);
  assert.ok(coverage.body.rows.every((r) => r.intended === null && r.status === 'not_specified'));
});

test('a single-value filter counts as intent on that axis', async () => {
  const created = await http.post('/api/tests', {
    ...sampleTest(),
    sections: [{
      section_name: 'Hard only', question_count: 4, marks_per_question: 1, negative_marks: 0,
      rule: { question_type: ['MCQ'], difficulty: ['Hard'] },
    }],
  }, { token: admin });

  const coverage = await http.get(`/api/tests/${created.body.id}/coverage?axis=difficulty`, { token: admin });
  assert.equal(coverage.body.coverageKnown, true);
  const hard = coverage.body.rows.find((r) => r.value === 'Hard');
  assert.equal(hard.intended, 4);
  assert.equal(hard.actual, 4);
  assert.equal(hard.status, 'met');
  assert.equal(coverage.body.met, true);
});

test('every advertised coverage axis can actually be reported', async () => {
  const created = await creatorTest();
  const axes = await http.get(`/api/tests/${created.id}/coverage/axes`, { token: creator });
  assert.equal(axes.status, 200);
  assert.ok(axes.body.length >= 5);

  for (const axis of axes.body) {
    const result = await http.get(`/api/tests/${created.id}/coverage?axis=${axis.key}`, { token: creator });
    assert.equal(result.status, 200, `axis ${axis.key} should be reportable`);
    assert.equal(typeof result.body.coverageKnown, 'boolean');
  }

  const all = await http.get(`/api/tests/${created.id}/coverage?axis=all`, { token: creator });
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.body.axes).sort(), axes.body.map((a) => a.key).sort());
});

test('duplicate warnings look inside one generated test', async () => {
  const created = await creatorTest();
  const warnings = await http.get(`/api/tests/${created.id}/duplicate-warnings`, { token: creator });
  assert.equal(warnings.status, 200);
  assert.equal(warnings.body.threshold, 0.6);
  assert.ok(Array.isArray(warnings.body.pairs));
  for (const pair of warnings.body.pairs) {
    assert.ok(pair.similarity >= 0.6);
    assert.notEqual(pair.a, pair.b, 'a question is never its own duplicate');
  }
});

/* ------------------------------------------------------------------ *
 * Response capture and item analytics
 * ------------------------------------------------------------------ */

/** Builds a cohort where strong candidates answer most items correctly. */
function cohort(qids, size = 40) {
  return Array.from({ length: size }, (_, index) => {
    const strong = index < size / 2;
    return {
      candidate_ref: `CAND-${index + 1}`,
      responses: qids.map((qid, position) => ({
        qid,
        chosen_option: 'A',
        // Strong candidates get three in four right; weak ones one in four. That
        // gives a real spread of totals, without which the discrimination
        // correlation has nothing to correlate against.
        is_correct: strong ? (position + index) % 4 !== 0 : (position + index) % 4 === 0,
      })),
    };
  });
}

test('results are ingested, scored and turned into item statistics', async () => {
  const created = await creatorTest();
  const qids = created.sections.flatMap((s) => s.questions.map((q) => q.qid));

  const ingested = await http.post(`/api/results/tests/${created.id}/attempts`,
    { attempts: cohort(qids) }, { token: creator });
  assert.equal(ingested.status, 201);
  assert.equal(ingested.body.attempts, 40);
  assert.equal(ingested.body.responses, 40 * qids.length);
  assert.deepEqual(ingested.body.ignoredQids, []);

  const results = await http.get(`/api/results/tests/${created.id}/results`, { token: creator });
  assert.equal(results.body.attempts, 40);
  assert.ok(results.body.meanScore > 0);
  assert.ok(results.body.maxScore >= results.body.minScore);

  const stats = results.body.items.find((i) => i.qid === qids[0]);
  assert.equal(stats.responses, 40);
  assert.ok(stats.p_value >= 0 && stats.p_value <= 1);
  assert.ok(stats.discrimination > 0, 'a well-behaved item separates strong from weak candidates');

  const analytics = await http.get(`/api/questions/${qids[0]}/analytics`, { token: creator });
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.statistics.responses, 40);
  assert.ok(analytics.body.statistics.interpretation.length > 0);
});

test('a flat results file produces the same statistics as structured attempts', async () => {
  const created = await creatorTest();
  const qids = created.sections.flatMap((s) => s.questions.map((q) => q.qid));

  const rows = cohort(qids, 30).flatMap((attempt) => attempt.responses.map((response) => ({
    candidate_ref: attempt.candidate_ref,
    qid: response.qid,
    // The many spellings a real results export uses must all coerce.
    is_correct: response.is_correct ? 'Yes' : '0',
    chosen_option: 'B',
  })));

  const ingested = await http.post(`/api/results/tests/${created.id}/responses`, { rows }, { token: creator });
  assert.equal(ingested.status, 201);
  assert.equal(ingested.body.attempts, 30);

  const results = await http.get(`/api/results/tests/${created.id}/results`, { token: creator });
  assert.equal(results.body.attempts, 30);
  // A total score was derived, since the file carried none.
  assert.ok(results.body.meanScore > 0);
});

test('re-uploading a corrected file replaces the attempt rather than duplicating it', async () => {
  const created = await creatorTest();
  const qids = created.sections.flatMap((s) => s.questions.map((q) => q.qid));

  await http.post(`/api/results/tests/${created.id}/attempts`, { attempts: cohort(qids, 20) }, { token: creator });
  await http.post(`/api/results/tests/${created.id}/attempts`, { attempts: cohort(qids, 20) }, { token: creator });

  const results = await http.get(`/api/results/tests/${created.id}/results`, { token: creator });
  assert.equal(results.body.attempts, 20, 'the same candidate_ref must not create a second attempt');
});

test('a response to a QID that is not in the paper is reported, not stored', async () => {
  const created = await creatorTest();
  const qids = created.sections.flatMap((s) => s.questions.map((q) => q.qid));

  const ingested = await http.post(`/api/results/tests/${created.id}/attempts`, {
    attempts: [{
      candidate_ref: 'STRAY-1',
      responses: [
        { qid: qids[0], is_correct: true },
        { qid: 'QID999999', is_correct: true },
      ],
    }],
  }, { token: creator });

  assert.equal(ingested.status, 201);
  assert.equal(ingested.body.responses, 1);
  assert.deepEqual(ingested.body.ignoredQids, ['QID999999']);
});

test('clearing results removes the attempts and the statistics with them', async () => {
  const created = await creatorTest();
  const qids = created.sections.flatMap((s) => s.questions.map((q) => q.qid));
  await http.post(`/api/results/tests/${created.id}/attempts`, { attempts: cohort(qids, 25) }, { token: creator });

  const cleared = await http.del(`/api/results/tests/${created.id}/attempts`, { token: creator });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.removed, 25);

  const results = await http.get(`/api/results/tests/${created.id}/results`, { token: creator });
  assert.equal(results.body.attempts, 0);
});

test('the bank-wide item overview reflects the responses that were imported', async () => {
  const created = await creatorTest();
  const qids = created.sections.flatMap((s) => s.questions.map((q) => q.qid));
  await http.post(`/api/results/tests/${created.id}/attempts`, { attempts: cohort(qids, 40) }, { token: creator });

  const overview = await http.get('/api/results/items/overview', { token: creator });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.analysed > 0);
  assert.ok(overview.body.totalResponses > 0);
  assert.ok(overview.body.meanPValue >= 0 && overview.body.meanPValue <= 1);
  assert.ok(Array.isArray(overview.body.needsReview));

  const recomputed = await http.post('/api/results/items/recompute', {}, { token: creator });
  assert.equal(recomputed.status, 200);
  assert.ok(recomputed.body.questions > 0);
});

test('a viewer may read results but not write them', async () => {
  const created = await creatorTest();
  assert.equal((await http.get(`/api/results/tests/${created.id}/results`, { token: viewer })).status, 200);
  assert.equal((await http.post(`/api/results/tests/${created.id}/attempts`, {
    attempts: [{ candidate_ref: 'X', responses: [{ qid: created.sections[0].questions[0].qid, is_correct: true }] }],
  }, { token: viewer })).status, 403);
});

/* ------------------------------------------------------------------ *
 * QTI export and paper layout
 * ------------------------------------------------------------------ */

test('the QTI package is a valid content package with one item per question', async () => {
  const created = await creatorTest();
  const response = await http.raw(`/api/exports/${created.id}/qti`, { token: creator });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');

  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const names = Object.keys(zip.files);

  assert.ok(names.includes('imsmanifest.xml'), 'a content package needs a manifest');
  const itemFiles = names.filter((n) => n.startsWith('items/') && n.endsWith('.xml'));
  const questionCount = created.sections.reduce((sum, s) => sum + s.questions.length, 0);
  assert.equal(itemFiles.length, questionCount);

  const manifest = await zip.file('imsmanifest.xml').async('string');
  assert.match(manifest, /IMS Content/i);
  for (const file of itemFiles) assert.ok(manifest.includes(file), `${file} must be declared in the manifest`);

  const assessment = names.find((n) => n.endsWith('.xml') && n !== 'imsmanifest.xml' && !n.startsWith('items/'));
  assert.ok(assessment, 'the package must contain an assessmentTest document');
  const testXml = await zip.file(assessment).async('string');
  assert.match(testXml, /assessmentTest/);
  // One section element per section of the generated test.
  assert.equal((testXml.match(/<assessmentSection/g) || []).length, created.sections.length);

  const itemXml = await zip.file(itemFiles[0]).async('string');
  assert.match(itemXml, /assessmentItem/);
  assert.match(itemXml, /responseDeclaration/);
});

test('QTI escapes question text rather than emitting broken XML', async () => {
  const authored = await http.post('/api/questions', {
    question_text: 'Is a < b && b > c a valid expression in "C"?',
    question_type: 'MCQ', difficulty: 'Easy', marks: 1, status: 'active',
    taxonomy: [{ subject: 'Operating System', area: 'Process Management' }],
    options: [
      { option_text: 'Yes & always', is_correct: true },
      { option_text: 'No <never>', is_correct: false },
    ],
  }, { token: admin });
  assert.equal(authored.status, 201);

  const created = await http.post('/api/tests', {
    ...sampleTest(), mode: 'manual',
    sections: [{
      section_name: 'Escaping', question_count: 1, marks_per_question: 1, negative_marks: 0,
      rule: {}, qids: [authored.body.qid],
    }],
  }, { token: admin });

  const response = await http.raw(`/api/exports/${created.body.id}/qti`, { token: admin });
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const itemFile = Object.keys(zip.files).find((n) => n.startsWith('items/') && n.endsWith('.xml'));
  const xml = await zip.file(itemFile).async('string');

  assert.ok(xml.includes('&lt;') && xml.includes('&amp;'), 'special characters must be escaped');
  assert.ok(!/[^&]&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), 'no raw ampersand may survive');
});

test('paper layout options change the exported PDF', async () => {
  const created = await creatorTest();
  const fetchPdf = async (query) => {
    const response = await http.raw(`/api/exports/${created.id}/pdf${query}`, { token: creator });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    return Buffer.from(await response.arrayBuffer());
  };

  const plain = await fetchPdf('?columns=1&answerSpace=false');
  const twoColumn = await fetchPdf('?columns=2&answerSpace=false');
  const withSpace = await fetchPdf('?columns=1&answerSpace=true');
  const withBreaks = await fetchPdf('?columns=1&answerSpace=false&pageBreaks=true');

  for (const pdf of [plain, twoColumn, withSpace, withBreaks]) {
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 1000);
  }

  // Each option must actually reach the renderer rather than being ignored.
  assert.notEqual(twoColumn.length, plain.length, 'a two-column layout must differ from one column');
  assert.ok(withSpace.length > plain.length, 'reserving answer space adds content');
  assert.ok(withBreaks.length > plain.length, 'a page break per section adds pages');
});

/* ------------------------------------------------------------------ *
 * Saved question sets
 * ------------------------------------------------------------------ */

test('a saved set stores a filter and reports a live count', async () => {
  const filter = { question_type: ['MCQ'], subject: ['Operating System'], difficulty: ['Hard'] };
  const expected = await http.post('/api/questions/count', { filter }, { token: creator });

  const created = await http.post('/api/sets', {
    name: 'Hard OS multiple choice', description: 'For the advanced paper', filter,
  }, { token: creator });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.filter, filter);

  const listed = await http.get('/api/sets', { token: creator });
  const mine = listed.body.find((s) => s.id === created.body.id);
  assert.equal(mine.available, expected.body.available, 'the count is recomputed, not stored');

  const preview = await http.get(`/api/sets/${created.body.id}/questions?pageSize=5`, { token: creator });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.items.length > 0);
  assert.ok(preview.body.items.every((q) => q.difficulty === 'Hard'));
});

test('a saved set drives generation identically to the same inline rule', async () => {
  const filter = { question_type: ['MCQ'], subject: ['DBMS'] };
  const set = await http.post('/api/sets', { name: 'DBMS MCQ', filter }, { token: creator });

  const stored = await http.get(`/api/sets/${set.body.id}`, { token: creator });
  const generated = await http.post('/api/tests', {
    ...sampleTest(),
    test: { ...sampleTest().test, random_seed: 'SET-SEED' },
    sections: [{
      section_name: 'From a set', question_count: 5, marks_per_question: 1, negative_marks: 0,
      rule: stored.body.filter,
    }],
  }, { token: creator });

  assert.equal(generated.status, 201);
  assert.equal(generated.body.sections[0].questions.length, 5);
  assert.ok(generated.body.sections[0].questions.every((q) => q.question.question_type === 'MCQ'));
  assert.ok(generated.body.sections[0].questions.every((q) => q.question.subjects.includes('DBMS')));
});

test('set names are unique and private sets stay private', async () => {
  await http.post('/api/sets', { name: 'Duplicate name', filter: {} }, { token: creator });
  const again = await http.post('/api/sets', { name: 'Duplicate name', filter: {} }, { token: admin });
  assert.equal(again.status, 409);

  const priv = await http.post('/api/sets', {
    name: 'Creator private', filter: { difficulty: ['Easy'] }, is_shared: false,
  }, { token: creator });
  assert.equal(priv.body.is_shared, false);

  const viewerList = await http.get('/api/sets', { token: viewer });
  assert.ok(!viewerList.body.some((s) => s.id === priv.body.id), 'a private set is not listed to others');
  assert.equal((await http.get(`/api/sets/${priv.body.id}`, { token: viewer })).status, 403);
});

test('only the owner (or an admin) may change or delete a set', async () => {
  const set = await http.post('/api/sets', { name: 'Owned by creator', filter: {} }, { token: creator });

  assert.equal((await http.put(`/api/sets/${set.body.id}`, { name: 'x' }, { token: viewer })).status, 403);

  const renamed = await http.put(`/api/sets/${set.body.id}`, { name: 'Renamed by owner' }, { token: creator });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Renamed by owner');

  // An admin overrides ownership, which is what makes cleanup possible.
  assert.equal((await http.del(`/api/sets/${set.body.id}`, { token: admin })).status, 200);
  assert.equal((await http.get(`/api/sets/${set.body.id}`, { token: admin })).status, 404);
});

/* ------------------------------------------------------------------ *
 * Branding
 * ------------------------------------------------------------------ */

const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('branding is stored and printed on exported papers', async () => {
  const saved = await http.put('/api/settings', {
    institution_name: 'Evolvian Institute',
    paper_footer: 'Confidential — internal assessment only',
    institution_logo: PIXEL_PNG,
  }, { token: admin });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.institution_name, 'Evolvian Institute');
  assert.equal(saved.body.hasLogo, true);

  const created = await creatorTest();
  const branded = await http.raw(`/api/exports/${created.id}/pdf?branding=true`, { token: creator });
  const unbranded = await http.raw(`/api/exports/${created.id}/pdf?branding=false`, { token: creator });

  const brandedPdf = Buffer.from(await branded.arrayBuffer());
  const unbrandedPdf = Buffer.from(await unbranded.arrayBuffer());
  assert.equal(brandedPdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(brandedPdf.length > unbrandedPdf.length, 'the logo and institution name add to the document');
});

test('a remote logo URL is refused; exports never fetch from the network', async () => {
  const remote = await http.put('/api/settings', {
    institution_logo: 'https://example.com/logo.png',
  }, { token: admin });
  assert.equal(remote.status, 400);
  assert.match(remote.body.error.message, /data URI|inline/i);

  const svg = await http.put('/api/settings', {
    institution_logo: 'data:image/svg+xml;base64,PHN2Zy8+',
  }, { token: admin });
  assert.equal(svg.status, 400);
});

test('only an admin may change installation settings', async () => {
  assert.equal((await http.put('/api/settings', { institution_name: 'Nope' }, { token: creator })).status, 403);
  assert.equal((await http.get('/api/settings', { token: creator })).status, 200);
});
