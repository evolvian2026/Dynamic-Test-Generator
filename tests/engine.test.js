/** Selection engine: filters, distribution, determinism, deduplication. */

import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';

const { countMatching, sampleQuestions, getQuestionsByQids } = await import('../server/core/questions.js');
const { compileFilter, explainMatch, FilterError } = await import('../server/core/filterEngine.js');
const { allocate, expandBuckets } = await import('../server/core/distribution.js');
const { generateSelection, generateVersions, GenerationError } = await import('../server/core/generator.js');
const { checkSection } = await import('../server/core/availability.js');
const { validateTestDefinition } = await import('../server/core/validation.js');
const { createRng, shuffle, seededHash } = await import('../server/core/rng.js');

test('filter engine binds values instead of interpolating them', () => {
  const injected = "Arrays' OR 1=1--";
  const { where, params } = compileFilter({ question_type: [injected] });
  assert.ok(!where.includes('OR 1=1'), 'user input must never reach the SQL string');
  assert.ok(params.includes(injected));
  assert.equal(countMatching({ question_type: [injected] }), 0);
  // Unresolvable taxonomy names must exclude everything, never widen the query.
  assert.equal(countMatching({ subject: [injected] }), 0);
});

test('filter engine rejects unknown fields', () => {
  assert.throws(
    () => compileFilter({ advanced: { field: 'drop_table', operator: 'eq', value: 'x' } }),
    FilterError,
  );
});

test('quick filters narrow the result set monotonically', () => {
  const all = countMatching({});
  const mcq = countMatching({ question_type: ['MCQ'] });
  const mcqOs = countMatching({ question_type: ['MCQ'], subject: ['Operating System'] });
  const mcqOsHard = countMatching({ question_type: ['MCQ'], subject: ['Operating System'], difficulty: ['Hard'] });

  assert.ok(all > mcq && mcq > mcqOs && mcqOs >= mcqOsHard);
  assert.ok(mcqOsHard > 0, 'the seeded bank should contain hard OS MCQs');
});

test('tag include and exclude behave as set operations', () => {
  const withTag = countMatching({ includeTags: ['advanced'] });
  const withoutTag = countMatching({ excludeTags: ['advanced'] });
  const total = countMatching({});
  assert.equal(withTag + withoutTag, total);
});

test('AND / OR / NOT trees compile and evaluate correctly', () => {
  const os = countMatching({ subject: ['Operating System'] });
  const osHard = countMatching({ subject: ['Operating System'], difficulty: ['Hard'] });

  const orTree = {
    op: 'AND',
    children: [
      { field: 'subject', operator: 'in', value: ['Operating System'] },
      { op: 'OR', children: [
        { field: 'difficulty', operator: 'eq', value: 'Hard' },
        { field: 'tags', operator: 'has_any', value: ['advanced'] },
      ] },
    ],
  };
  const orCount = countMatching(orTree);
  assert.ok(orCount >= osHard && orCount <= os, 'OR widens within the AND branch');

  const notTree = {
    op: 'AND',
    children: [
      { field: 'subject', operator: 'in', value: ['Operating System'] },
      { op: 'NOT', children: [{ field: 'difficulty', operator: 'eq', value: 'Hard' }] },
    ],
  };
  assert.equal(countMatching(notTree), os - osHard);
});

test('extensible attribute fields are filterable without schema changes', () => {
  const google = countMatching({ attributes: { company: ['Google'] } });
  assert.ok(google > 0);
  const highQuality = countMatching({ advanced: { field: 'quality_score', operator: 'gte', value: 4.5 } });
  assert.ok(highQuality > 0, 'numeric attribute comparison should work');
});

test('largest-remainder allocation always sums to the requested total', () => {
  assert.deepEqual(allocate(20, { Easy: 20, Medium: 50, Hard: 30 }), { Easy: 4, Medium: 10, Hard: 6 });
  for (const total of [7, 13, 33, 50, 101]) {
    const result = allocate(total, { Easy: 20, Medium: 50, Hard: 30 });
    assert.equal(Object.values(result).reduce((a, b) => a + b, 0), total, `total ${total}`);
  }
});

test('a percentage distribution that does not total 100 is rejected', () => {
  assert.throws(
    () => expandBuckets({ section_name: 'S', question_count: 10, distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 30, Hard: 40 } } }),
    /must total 100%/,
  );
});

test('the same seed reproduces the same test', () => {
  const sections = [{ section_name: 'S', question_count: 8, marks_per_question: 1, rule: { subject: ['Operating System'] } }];
  const first = generateSelection({ sections, seed: 'DSA2026' });
  const second = generateSelection({ sections, seed: 'DSA2026' });
  const third = generateSelection({ sections, seed: 'DIFFERENT' });

  const qids = (result) => result.sections[0].questions.map((q) => q.qid);
  assert.deepEqual(qids(first), qids(second), 'same seed must be reproducible');
  assert.notDeepEqual(qids(first), qids(third), 'a different seed must produce a different test');
});

test('a QID never appears twice in one test when deduplication is on', () => {
  const sections = Array.from({ length: 4 }, (_, i) => ({
    section_name: `S${i}`,
    question_count: 12,
    marks_per_question: 1,
    // Deliberately overlapping filters.
    rule: { subject: ['Operating System'] },
  }));
  const result = generateSelection({ sections, seed: 'DEDUPE', preventDuplicates: true });
  const qids = result.sections.flatMap((s) => s.questions.map((q) => q.qid));

  assert.equal(qids.length, 48);
  assert.equal(new Set(qids).size, 48, 'every QID must be unique across sections');
});

test('generation refuses to silently under-deliver', () => {
  const sections = [{
    section_name: 'Impossible',
    question_count: 99999,
    marks_per_question: 1,
    rule: { question_type: ['Coding'], subject: ['Operating System'], difficulty: ['Hard'] },
  }];
  assert.throws(() => generateSelection({ sections, seed: 'X' }), GenerationError);

  // With allowPartial the shortfall is reported rather than hidden.
  const partial = generateSelection({ sections, seed: 'X', allowPartial: true });
  assert.ok(partial.sections[0].shortfall > 0);
  assert.ok(partial.warnings.length > 0);
  assert.match(partial.warnings[0].message, /Only \d+ of 99999/);
});

test('availability reports a shortfall with workable suggestions', () => {
  const section = {
    section_name: 'Hard OS MCQs',
    question_count: 9999,
    marks_per_question: 1,
    rule: { question_type: ['MCQ'], subject: ['Operating System'], difficulty: ['Hard'] },
  };
  const result = checkSection(section);

  assert.equal(result.sufficient, false);
  assert.ok(result.available > 0 && result.available < 9999);
  const reduce = result.suggestions.find((s) => s.action === 'reduce_count');
  assert.ok(reduce, 'a reduce-count option must be offered');

  // The offered count must actually be achievable.
  const retry = checkSection({ ...section, question_count: reduce.value });
  assert.equal(retry.sufficient, true, 'the suggested count must resolve the shortfall');
});

test('a suggested reduction respects an active difficulty distribution', () => {
  const section = {
    section_name: 'Distributed',
    question_count: 900,
    marks_per_question: 1,
    rule: { question_type: ['MCQ'], subject: ['Operating System'] },
    distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 20, Medium: 50, Hard: 30 } },
  };
  const result = checkSection(section);
  const reduce = result.suggestions.find((s) => s.action === 'reduce_count');

  // Reducing a distributed section re-splits it, so the naive "sum of bucket
  // maxima" answer would still be short.
  const retry = checkSection({ ...section, question_count: reduce.value });
  assert.equal(retry.sufficient, true);
  assert.ok(retry.buckets.every((b) => b.available >= b.requested));
});

test('distribution buckets are honoured exactly during generation', () => {
  const sections = [{
    section_name: 'Mixed',
    question_count: 20,
    marks_per_question: 1,
    rule: { question_type: ['MCQ'] },
    distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 20, Medium: 50, Hard: 30 } },
  }];
  const result = generateSelection({ sections, seed: 'DIST' });
  const qids = result.sections[0].questions.map((q) => q.qid);
  const loaded = getQuestionsByQids(qids);

  const counts = loaded.reduce((acc, q) => ({ ...acc, [q.difficulty]: (acc[q.difficulty] || 0) + 1 }), {});
  assert.deepEqual(counts, { Easy: 4, Medium: 10, Hard: 6 });
});

test('versions keep the distribution but change the questions', () => {
  const sections = [{
    section_name: 'S', question_count: 10, marks_per_question: 1,
    rule: { question_type: ['MCQ'], subject: ['Operating System'] },
    distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 20, Medium: 50, Hard: 30 } },
  }];
  const { versions } = generateVersions({ sections, count: 3, seed: 'VER', uniqueAcrossVersions: true });

  assert.equal(versions.length, 3);
  const perVersion = versions.map((v) => v.sections[0].questions.map((q) => q.qid));

  // Distribution identical across versions…
  for (const qids of perVersion) {
    const counts = getQuestionsByQids(qids).reduce((acc, q) => ({ ...acc, [q.difficulty]: (acc[q.difficulty] || 0) + 1 }), {});
    assert.deepEqual(counts, { Easy: 2, Medium: 5, Hard: 3 });
  }
  // …but no QID shared between them.
  const all = perVersion.flat();
  assert.equal(new Set(all).size, all.length, 'versions must not share QIDs');
});

test('disjoint versions fail honestly when the bank is too small', () => {
  const sections = [{
    section_name: 'Narrow', question_count: 10, marks_per_question: 1,
    rule: { question_type: ['Coding'], subject: ['Operating System'], difficulty: ['Hard'] },
  }];
  // Asking for many disjoint versions of a narrow slice must raise rather than
  // quietly hand back short versions.
  assert.throws(
    () => generateVersions({ sections, count: 20, seed: 'NARROW', uniqueAcrossVersions: true }),
    GenerationError,
  );
});

test('explainMatch reports each criterion for the audit view', () => {
  const [question] = getQuestionsByQids(
    sampleQuestions({ question_type: ['MCQ'], subject: ['Operating System'] }, { count: 1, seed: 'E' }).map((r) => r.qid),
  );
  const { matched, criteria } = explainMatch(
    { question_type: ['MCQ'], subject: ['Operating System'], excludeTags: ['nonexistent-tag'] },
    question,
  );
  assert.equal(matched, true);
  assert.ok(criteria.length >= 3);
  assert.ok(criteria.every((c) => c.passed));

  const failing = explainMatch({ subject: ['Flutter'] }, question);
  assert.equal(failing.matched, false);
  assert.equal(failing.criteria[0].passed, false);
});

test('validation catches every rule the specification requires', () => {
  const report = validateTestDefinition(
    { test_name: '', duration_minutes: 0 },
    [],
    { checkAvailability: false },
  );
  assert.equal(report.valid, false);
  const rules = report.errors.map((e) => e.rule);
  assert.ok(rules.includes('test_name'));
  assert.ok(rules.includes('duration'));
  assert.ok(rules.includes('sections'));

  const duplicates = validateTestDefinition(
    { test_name: 'T', duration_minutes: 30 },
    [
      { section_name: 'A', question_count: 5, marks_per_question: 1 },
      { section_name: 'A', question_count: 0, marks_per_question: 0 },
    ],
    { checkAvailability: false },
  );
  const dupRules = duplicates.errors.map((e) => e.rule);
  assert.ok(dupRules.includes('section_name'));
  assert.ok(dupRules.includes('question_count'));
  assert.ok(dupRules.includes('marks'));
});

test('turning duplicate prevention off allows repeats instead of blocking the save', () => {
  const selection = {
    sections: [
      { sectionName: 'A', delivered: 1, marks: 1, questions: [{ qid: 'QID1' }] },
      { sectionName: 'B', delivered: 1, marks: 1, questions: [{ qid: 'QID1' }] },
    ],
  };
  const sections = [{ section_name: 'A', question_count: 1, marks_per_question: 1 }];

  // Spec §9 makes duplicate prevention configurable. With it off, a repeated
  // QID is the user's explicit choice, so it must not make the test unsavable.
  const off = validateTestDefinition(
    { test_name: 'T', duration_minutes: 30, prevent_duplicates: false },
    sections, { checkAvailability: false, selection },
  );
  assert.equal(off.valid, true, 'a test with duplicates must save when prevention is off');
  assert.ok(off.warnings.some((w) => w.rule === 'duplicates'), 'the repeat is still surfaced as a warning');

  // Default (unset) and explicit-on both still block.
  for (const test of [{ test_name: 'T', duration_minutes: 30 }, { test_name: 'T', duration_minutes: 30, prevent_duplicates: true }]) {
    const on = validateTestDefinition(test, sections, { checkAvailability: false, selection });
    assert.equal(on.valid, false);
    assert.ok(on.errors.some((e) => e.rule === 'duplicates'));
  }
});

test('duplicate QIDs in a selection are reported by validation', () => {
  const selection = {
    sections: [
      { sectionName: 'A', delivered: 1, marks: 1, questions: [{ qid: 'QID1' }] },
      { sectionName: 'B', delivered: 1, marks: 1, questions: [{ qid: 'QID1' }] },
    ],
  };
  const report = validateTestDefinition(
    { test_name: 'T', duration_minutes: 30 },
    [{ section_name: 'A', question_count: 1, marks_per_question: 1 }],
    { checkAvailability: false, selection },
  );
  assert.ok(report.errors.some((e) => e.rule === 'duplicates'));
});

test('seeded RNG is stable across processes', () => {
  assert.equal(seededHash('DSA2026', 'QID1001'), seededHash('DSA2026', 'QID1001'));
  assert.notEqual(seededHash('DSA2026', 'QID1001'), seededHash('OTHER', 'QID1001'));

  const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], createRng('seed'));
  const b = shuffle([1, 2, 3, 4, 5, 6, 7, 8], createRng('seed'));
  assert.deepEqual(a, b);
});

test('sampling never returns duplicates or excluded QIDs', () => {
  const first = sampleQuestions({ subject: ['Operating System'] }, { count: 15, seed: 'S1' });
  const qids = first.map((r) => r.qid);
  assert.equal(new Set(qids).size, qids.length);

  const second = sampleQuestions({ subject: ['Operating System'] }, { count: 15, seed: 'S2', excludeQids: qids });
  assert.ok(second.every((r) => !qids.includes(r.qid)), 'excluded QIDs must not reappear');
});
