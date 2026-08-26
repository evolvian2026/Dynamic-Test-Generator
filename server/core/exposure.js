/**
 * Exposure control and question cooldown.
 *
 * Without this, nothing stops the same QID appearing in every test generated
 * this month. For parallel forms, retakes and any bank that is used repeatedly,
 * that is the difference between a usable bank and a leaky one.
 *
 * Usage is measured from `test_questions` — the tests actually generated — not
 * from a stored counter that could drift. The predicates compile into the same
 * filter tree as everything else, so they compose with taxonomy, tags and
 * difficulty rules and take part in availability checking.
 */

import { getDb } from '../db/index.js';

/** Exposure keys understood by a section rule. */
export const EXPOSURE_KEYS = ['usedWithinDays', 'notUsedInTests', 'maxUsageCount', 'neverUsed', 'excludeUsedInTest'];

/** True when a rule carries any exposure constraint. */
export function hasExposureRule(rule = {}) {
  return EXPOSURE_KEYS.some((key) => {
    const value = rule[key];
    if (value === undefined || value === null || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
  });
}

/**
 * Compiles the exposure part of a rule into SQL fragments over `questions q`.
 * Returns `{ clauses, params }`; both are empty when no exposure rule is set.
 *
 * @param {object} rule
 * @param {number} [rule.usedWithinDays]   exclude questions used in the last N days
 * @param {boolean}[rule.neverUsed]        only questions never used in any test
 * @param {number} [rule.maxUsageCount]    exclude questions used more than N times
 * @param {Array}  [rule.notUsedInTests]   exclude questions used by these tests (id or test_id)
 */
export function compileExposure(rule = {}) {
  const clauses = [];
  const params = [];

  const usedInAnyTest = 'SELECT 1 FROM test_questions tq WHERE tq.question_id = q.id';

  if (rule.neverUsed) {
    clauses.push(`NOT EXISTS (${usedInAnyTest})`);
  }

  const days = Number(rule.usedWithinDays);
  if (Number.isFinite(days) && days > 0) {
    // "Cooldown": the question must not have been used by a test created
    // within the window. Tests carry the date; test_questions does not.
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM test_questions tq
                     JOIN tests t ON t.id = tq.test_id
                    WHERE tq.question_id = q.id
                      AND t.created_at >= datetime('now', ?))`,
    );
    params.push(`-${Math.floor(days)} days`);
  }

  const maxUses = Number(rule.maxUsageCount);
  if (Number.isFinite(maxUses) && maxUses >= 0) {
    clauses.push(
      `(SELECT COUNT(*) FROM test_questions tq WHERE tq.question_id = q.id) <= ?`,
    );
    params.push(Math.floor(maxUses));
  }

  // Parallel forms: "nothing that appeared in form A".
  const excluded = [
    ...(Array.isArray(rule.notUsedInTests) ? rule.notUsedInTests : []),
    ...(rule.excludeUsedInTest ? [rule.excludeUsedInTest] : []),
  ].filter((v) => v !== null && v !== undefined && v !== '');

  if (excluded.length) {
    const placeholders = excluded.map(() => '?').join(', ');
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM test_questions tq
                     JOIN tests t ON t.id = tq.test_id
                    WHERE tq.question_id = q.id
                      AND (t.test_id IN (${placeholders}) OR t.id IN (${placeholders})))`,
    );
    // The same values are bound twice: once against the human-facing test_id
    // and once against the numeric id, so either form works.
    params.push(...excluded.map(String), ...excluded.map((v) => Number(v) || -1));
  }

  return { clauses, params };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/** Real usage history for one question. */
export function usageForQuestion(qid) {
  const db = getDb();
  const question = db.prepare('SELECT id FROM questions WHERE qid = ?').get(qid);
  if (!question) return null;

  const tests = db
    .prepare(
      `SELECT t.id, t.test_id, t.test_name, t.status, t.created_at
         FROM test_questions tq JOIN tests t ON t.id = tq.test_id
        WHERE tq.question_id = ?
        ORDER BY t.created_at DESC`,
    )
    .all(question.id);

  return {
    qid,
    timesUsed: tests.length,
    lastUsedAt: tests[0]?.created_at ?? null,
    daysSinceLastUse: tests[0]
      ? db.prepare("SELECT CAST(julianday('now') - julianday(?) AS INTEGER) AS d").get(tests[0].created_at).d
      : null,
    tests,
  };
}

/**
 * Bank-wide exposure summary: how much of the bank is being reused, and which
 * questions carry the most exposure.
 */
export function exposureOverview({ limit = 20 } = {}) {
  const db = getDb();

  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM questions) AS bank,
              (SELECT COUNT(DISTINCT question_id) FROM test_questions) AS used,
              (SELECT COUNT(*) FROM test_questions) AS placements`,
    )
    .get();

  const mostExposed = db
    .prepare(
      `SELECT q.qid, q.question_type, q.difficulty, COUNT(*) AS uses,
              MAX(t.created_at) AS last_used
         FROM test_questions tq
         JOIN questions q ON q.id = tq.question_id
         JOIN tests t ON t.id = tq.test_id
        GROUP BY q.id
        ORDER BY uses DESC, last_used DESC
        LIMIT ?`,
    )
    .all(limit);

  const recentWindow = db
    .prepare(
      `SELECT COUNT(DISTINCT tq.question_id) AS n
         FROM test_questions tq JOIN tests t ON t.id = tq.test_id
        WHERE t.created_at >= datetime('now', '-30 days')`,
    )
    .get().n;

  return {
    bankSize: totals.bank,
    everUsed: totals.used,
    neverUsed: totals.bank - totals.used,
    totalPlacements: totals.placements,
    usedInLast30Days: recentWindow,
    reusePercentage: totals.bank ? Number(((totals.used / totals.bank) * 100).toFixed(2)) : 0,
    mostExposed,
  };
}
