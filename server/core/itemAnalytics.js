/**
 * Item analytics — the feedback loop that lets a question bank improve.
 *
 * The application does not deliver tests to candidates, so responses are
 * ingested from whatever does. From them it derives the two statistics that
 * actually govern item quality:
 *
 *   p-value        proportion answering correctly. This is *observed*
 *                  difficulty, as opposed to the label an author assigned.
 *   discrimination point-biserial correlation between getting the item right
 *                  and scoring well overall. A good item is answered correctly
 *                  more often by strong candidates than by weak ones; a
 *                  negative value usually means a miskeyed answer.
 *
 * Distractor analysis then shows how the wrong options performed: an option
 * nobody picks is dead weight, and one picked mainly by strong candidates
 * suggests the key is wrong or the item is ambiguous.
 *
 * Everything here is derived from `attempt_responses` and recomputed, never
 * trusted as stored input.
 */

import { getDb } from '../db/index.js';

/** Conventional interpretation bands, used for flagging. */
export const P_VALUE_BANDS = {
  tooEasy: 0.9,
  tooHard: 0.2,
};
export const DISCRIMINATION_BANDS = {
  poor: 0.1,
  acceptable: 0.2,
  good: 0.3,
};

/** Pearson correlation of two equal-length numeric series. */
export function correlation(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }

  const denominator = Math.sqrt(sumSqX * sumSqY);
  // Zero variance on either side: everyone answered the same way, or every
  // candidate scored identically. No correlation is defined.
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Compares an author's difficulty label against observed performance and
 * reports a mismatch. This is the flag that makes the bank self-correcting.
 */
export function difficultyFlag({ pValue, labelled, responses }) {
  if (pValue === null || responses < 20) return null; // too little evidence

  // Where each label is expected to sit, roughly.
  const expected = { Easy: [0.65, 1], Medium: [0.4, 0.85], Hard: [0, 0.6] }[labelled];
  if (!expected) return null;

  if (pValue > P_VALUE_BANDS.tooEasy) return 'too_easy';
  if (pValue < P_VALUE_BANDS.tooHard) return 'too_hard';
  if (pValue < expected[0]) return 'harder_than_labelled';
  if (pValue > expected[1]) return 'easier_than_labelled';
  return null;
}

/* ------------------------------------------------------------------ *
 * Computation
 * ------------------------------------------------------------------ */

/**
 * Recomputes `question_statistics` from the response data.
 *
 * @param {object} [options]
 * @param {number[]} [options.questionIds] limit the recompute to these questions
 * @returns {{questions:number, responses:number}}
 */
export function recomputeStatistics({ questionIds = null } = {}) {
  const db = getDb();

  // Each candidate's overall score, needed for the discrimination correlation.
  const attemptScores = new Map(
    db.prepare('SELECT id, COALESCE(total_score, 0) AS score FROM test_attempts').all().map((r) => [r.id, r.score]),
  );

  const scope = questionIds?.length
    ? `WHERE r.question_id IN (${questionIds.map(() => '?').join(',')})`
    : '';
  const rows = db
    .prepare(
      `SELECT r.question_id, r.attempt_id, r.is_correct, r.time_taken
         FROM attempt_responses r ${scope}`,
    )
    .all(...(questionIds || []));

  const byQuestion = new Map();
  for (const row of rows) {
    if (!byQuestion.has(row.question_id)) byQuestion.set(row.question_id, []);
    byQuestion.get(row.question_id).push(row);
  }

  const labels = new Map(
    db.prepare('SELECT id, difficulty FROM questions').all().map((r) => [r.id, r.difficulty]),
  );

  const upsert = db.prepare(
    `INSERT INTO question_statistics
       (question_id, responses, correct_responses, p_value, discrimination, avg_time_taken, difficulty_flag, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (question_id) DO UPDATE SET
       responses = excluded.responses,
       correct_responses = excluded.correct_responses,
       p_value = excluded.p_value,
       discrimination = excluded.discrimination,
       avg_time_taken = excluded.avg_time_taken,
       difficulty_flag = excluded.difficulty_flag,
       computed_at = excluded.computed_at`,
  );

  const run = db.transaction(() => {
    for (const [questionId, responses] of byQuestion) {
      const scored = responses.filter((r) => r.is_correct !== null);
      const total = scored.length;
      const correct = scored.filter((r) => r.is_correct === 1).length;
      const pValue = total ? correct / total : null;

      // Point-biserial: item outcome against total score on the attempt.
      const outcomes = scored.map((r) => r.is_correct);
      const totals = scored.map((r) => attemptScores.get(r.attempt_id) ?? 0);
      const discrimination = correlation(outcomes, totals);

      const times = responses.map((r) => r.time_taken).filter((t) => typeof t === 'number');
      const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;

      upsert.run(
        questionId,
        total,
        correct,
        pValue === null ? null : Number(pValue.toFixed(4)),
        discrimination === null ? null : Number(discrimination.toFixed(4)),
        avgTime === null ? null : Number(avgTime.toFixed(1)),
        difficultyFlag({ pValue, labelled: labels.get(questionId), responses: total }),
      );
    }
  });

  run();
  return { questions: byQuestion.size, responses: rows.length };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/** Full analytics for one question, including distractor behaviour. */
export function questionAnalytics(qid) {
  const db = getDb();
  const question = db
    .prepare('SELECT id, qid, question_type, difficulty, question_text FROM questions WHERE qid = ?')
    .get(qid);
  if (!question) return null;

  const stats = db.prepare('SELECT * FROM question_statistics WHERE question_id = ?').get(question.id) || null;

  // Distractor analysis: who chose each option, and how well those candidates
  // did overall. A wrong option chosen by strong candidates is a warning sign.
  const options = db
    .prepare('SELECT id, position, option_text, is_correct FROM question_options WHERE question_id = ? ORDER BY position')
    .all(question.id);

  const chosen = db
    .prepare(
      `SELECT r.chosen_option AS option_text, COUNT(*) AS picks,
              AVG(COALESCE(a.total_score, 0)) AS mean_total_score
         FROM attempt_responses r JOIN test_attempts a ON a.id = r.attempt_id
        WHERE r.question_id = ? AND r.chosen_option IS NOT NULL
        GROUP BY r.chosen_option`,
    )
    .all(question.id);

  const pickMap = new Map(chosen.map((c) => [c.option_text, c]));
  const totalPicks = chosen.reduce((a, c) => a + c.picks, 0);

  const distractors = options.map((option) => {
    const pick = pickMap.get(option.option_text);
    return {
      option: option.option_text,
      isCorrect: !!option.is_correct,
      picks: pick?.picks ?? 0,
      share: totalPicks ? Number(((pick?.picks ?? 0) / totalPicks).toFixed(3)) : 0,
      meanTotalScore: pick?.mean_total_score != null ? Number(pick.mean_total_score.toFixed(2)) : null,
      // A distractor nobody picks contributes nothing to the item.
      dead: !option.is_correct && (pick?.picks ?? 0) === 0 && totalPicks > 0,
    };
  });

  return {
    qid: question.qid,
    questionType: question.question_type,
    labelledDifficulty: question.difficulty,
    statistics: stats && {
      responses: stats.responses,
      correctResponses: stats.correct_responses,
      pValue: stats.p_value,
      discrimination: stats.discrimination,
      avgTimeTaken: stats.avg_time_taken,
      difficultyFlag: stats.difficulty_flag,
      computedAt: stats.computed_at,
      interpretation: interpret(stats),
    },
    distractors,
    deadDistractors: distractors.filter((d) => d.dead).length,
  };
}

/** Plain-language reading of the numbers. */
function interpret(stats) {
  const notes = [];
  if (stats.p_value !== null) {
    if (stats.p_value > P_VALUE_BANDS.tooEasy) notes.push('Nearly everyone answers this correctly — it separates almost no one.');
    else if (stats.p_value < P_VALUE_BANDS.tooHard) notes.push('Very few answer this correctly — check the key and the wording.');
  }
  if (stats.discrimination !== null) {
    if (stats.discrimination < 0) notes.push('Negative discrimination: stronger candidates do worse on this item, which usually means a miskeyed answer.');
    else if (stats.discrimination < DISCRIMINATION_BANDS.poor) notes.push('Discrimination is poor — the item barely distinguishes strong from weak candidates.');
    else if (stats.discrimination >= DISCRIMINATION_BANDS.good) notes.push('Discriminates well.');
  }
  if (stats.difficulty_flag === 'harder_than_labelled') notes.push('Performs harder than its label suggests.');
  if (stats.difficulty_flag === 'easier_than_labelled') notes.push('Performs easier than its label suggests.');
  return notes;
}

/** Bank-wide item quality report, for the analytics dashboard. */
export function itemQualityOverview({ limit = 20 } = {}) {
  const db = getDb();

  const summary = db
    .prepare(
      `SELECT COUNT(*) AS analysed,
              AVG(p_value) AS mean_p,
              AVG(discrimination) AS mean_discrimination,
              SUM(CASE WHEN discrimination < 0 THEN 1 ELSE 0 END) AS negative_discrimination,
              SUM(CASE WHEN difficulty_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged
         FROM question_statistics WHERE responses > 0`,
    )
    .get();

  const round = (v) => (v === null || v === undefined ? null : Number(v.toFixed(3)));

  const needsReview = db
    .prepare(
      `SELECT q.qid, q.question_type, q.difficulty AS labelled, s.responses,
              s.p_value, s.discrimination, s.difficulty_flag
         FROM question_statistics s JOIN questions q ON q.id = s.question_id
        WHERE s.responses >= 20
          AND (s.discrimination < ? OR s.difficulty_flag IS NOT NULL)
        ORDER BY s.discrimination ASC
        LIMIT ?`,
    )
    .all(DISCRIMINATION_BANDS.poor, limit);

  const flagCounts = db
    .prepare(
      `SELECT difficulty_flag AS flag, COUNT(*) AS n FROM question_statistics
        WHERE difficulty_flag IS NOT NULL GROUP BY difficulty_flag`,
    )
    .all();

  return {
    analysed: summary.analysed || 0,
    meanPValue: round(summary.mean_p),
    meanDiscrimination: round(summary.mean_discrimination),
    negativeDiscrimination: summary.negative_discrimination || 0,
    flagged: summary.flagged || 0,
    flagCounts: Object.fromEntries(flagCounts.map((r) => [r.flag, r.n])),
    needsReview,
    totalResponses: db.prepare('SELECT COUNT(*) AS n FROM attempt_responses').get().n,
    totalAttempts: db.prepare('SELECT COUNT(*) AS n FROM test_attempts').get().n,
  };
}

/** Attempt-level summary for one test. */
export function testResults(testDbId) {
  const db = getDb();
  const attempts = db
    .prepare(
      `SELECT COUNT(*) AS attempts, AVG(total_score) AS mean_score,
              MIN(total_score) AS min_score, MAX(total_score) AS max_score
         FROM test_attempts WHERE test_id = ?`,
    )
    .get(testDbId);

  const items = db
    .prepare(
      `SELECT q.qid, q.difficulty, s.p_value, s.discrimination, s.responses, s.difficulty_flag
         FROM test_questions tq
         JOIN questions q ON q.id = tq.question_id
         LEFT JOIN question_statistics s ON s.question_id = q.id
        WHERE tq.test_id = ?
        ORDER BY tq.question_order`,
    )
    .all(testDbId);

  return {
    attempts: attempts.attempts || 0,
    meanScore: attempts.mean_score != null ? Number(attempts.mean_score.toFixed(2)) : null,
    minScore: attempts.min_score,
    maxScore: attempts.max_score,
    items,
  };
}
