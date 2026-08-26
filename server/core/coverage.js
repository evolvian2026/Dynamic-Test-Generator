/**
 * Blueprint coverage.
 *
 * Availability answers "can this section be filled?". Coverage answers the
 * different question a test designer actually asks: *did the test I generated
 * cover what I intended, in the proportions I intended?*
 *
 * Intent is read from what each section asked for — its distribution when it
 * has one, otherwise its rule and question count — and compared against the
 * questions that were actually selected, along any axis of the taxonomy or
 * question metadata.
 */

import { getDb } from '../db/index.js';
import { expandBuckets } from './distribution.js';
import { getQuestionsByQids } from './questions.js';

/** Axes a coverage report can be built on. */
export const COVERAGE_AXES = {
  difficulty: { label: 'Difficulty', of: (q) => [q.difficulty] },
  question_type: { label: 'Question Type', of: (q) => [q.question_type] },
  subject: { label: 'Subject', of: (q) => q.subjects || [] },
  area: { label: 'Area / Topic', of: (q) => q.areas || [] },
  sub_area: { label: 'Sub-Area / Sub-Topic', of: (q) => q.subAreas || [] },
  bloom_taxonomy: { label: "Bloom's Taxonomy", of: (q) => attrValues(q, 'bloom_taxonomy') },
  cognitive_level: { label: 'Cognitive Level', of: (q) => attrValues(q, 'cognitive_level') },
};

function attrValues(question, key) {
  const value = (question.attributes || {})[key];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * What the sections asked for on the given axis.
 *
 * A section with a matching distribution states its intent exactly. A section
 * that merely filters on the axis intends all of its questions to land in the
 * values it named. Anything else contributes no intent — reported honestly
 * rather than guessed at.
 */
function intendedCounts(sections, axis) {
  const intended = {};
  let stated = 0;
  let unstated = 0;

  for (const section of sections) {
    const rules = section.selection_rules || {};
    const rule = rules.rule || {};
    const distribution = rules.distribution || null;
    const count = section.question_count || 0;

    if (distribution?.field === axis && distribution.values) {
      const buckets = expandBuckets({
        section_name: section.section_name,
        question_count: count,
        rule,
        distribution,
      });
      for (const bucket of buckets) {
        intended[bucket.value] = (intended[bucket.value] || 0) + bucket.count;
      }
      stated += count;
      continue;
    }

    const ruleValues = rule[axis];
    if (Array.isArray(ruleValues) && ruleValues.length === 1) {
      // A single value on this axis means the whole section targets it.
      intended[ruleValues[0]] = (intended[ruleValues[0]] || 0) + count;
      stated += count;
      continue;
    }

    unstated += count;
  }

  return { intended, stated, unstated };
}

/**
 * Coverage of one stored test along one axis.
 *
 * @param {number} testDbId
 * @param {string} axis  key of COVERAGE_AXES
 */
export function testCoverage(testDbId, axis = 'difficulty') {
  const descriptor = COVERAGE_AXES[axis];
  if (!descriptor) {
    const error = new Error(`Unknown coverage axis "${axis}". Available: ${Object.keys(COVERAGE_AXES).join(', ')}`);
    error.status = 400;
    throw error;
  }

  const db = getDb();
  const test = db.prepare('SELECT id, test_id, test_name FROM tests WHERE id = ?').get(testDbId);
  if (!test) return null;

  const sections = db
    .prepare('SELECT id, section_name, question_count, selection_rules FROM test_sections WHERE test_id = ? ORDER BY section_order')
    .all(test.id)
    .map((s) => ({ ...s, selection_rules: safeJson(s.selection_rules) }));

  const qids = db.prepare('SELECT qid FROM test_questions WHERE test_id = ? ORDER BY question_order').all(test.id).map((r) => r.qid);
  const questions = getQuestionsByQids(qids);

  // Actual: a question mapped to two branches counts towards both, which is
  // the honest reading for taxonomy axes.
  const actual = {};
  for (const question of questions) {
    for (const value of descriptor.of(question)) {
      if (value === null || value === undefined || value === '') continue;
      actual[value] = (actual[value] || 0) + 1;
    }
  }

  const { intended, stated, unstated } = intendedCounts(sections, axis);

  const values = [...new Set([...Object.keys(intended), ...Object.keys(actual)])].sort();
  const rows = values.map((value) => {
    const want = intended[value] ?? null;
    const got = actual[value] ?? 0;
    return {
      value,
      intended: want,
      actual: got,
      difference: want === null ? null : got - want,
      status: want === null ? 'not_specified' : got === want ? 'met' : got > want ? 'over' : 'under',
    };
  });

  const totalActual = Object.values(actual).reduce((a, b) => a + b, 0);
  const gaps = rows.filter((r) => r.status === 'under' || r.status === 'over');

  return {
    testId: test.test_id,
    testName: test.test_name,
    axis,
    axisLabel: descriptor.label,
    rows,
    totalQuestions: questions.length,
    totalActual,
    intentStated: stated,
    intentUnstated: unstated,
    // A test can only be judged against intent that was actually expressed.
    coverageKnown: stated > 0,
    met: rows.every((r) => r.status !== 'under' && r.status !== 'over'),
    gaps,
    note: unstated > 0
      ? `${unstated} question(s) come from sections that did not state an intent on this axis, so they are reported as actual only.`
      : null,
  };
}

/** Coverage across every axis at once, for the test detail view. */
export function fullCoverage(testDbId) {
  const out = {};
  for (const axis of Object.keys(COVERAGE_AXES)) {
    const result = testCoverage(testDbId, axis);
    if (result) out[axis] = result;
  }
  return out;
}

function safeJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}
