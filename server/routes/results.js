/**
 * Response capture.
 *
 * This application generates tests; it does not deliver them to candidates.
 * That boundary is deliberate — but without response data the bank can never
 * tell a good item from a bad one, so results are ingested from whatever does
 * the delivery: an LMS, a proctoring platform, or an OMR scanner.
 *
 * Two shapes are accepted, both landing in the same tables:
 *   structured  one JSON object per attempt with its responses
 *   flat        one row per response, the shape a results CSV usually has
 */

import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { notFound, badRequest } from '../middleware/errors.js';
import { recomputeStatistics, itemQualityOverview, testResults } from '../core/itemAnalytics.js';
import { audit } from '../services/testService.js';

const router = Router();
router.use(requireAuth);

const responseSchema = z.object({
  qid: z.string().min(1),
  chosen_option: z.string().nullish(),
  is_correct: z.boolean().nullish(),
  score: z.coerce.number().nullish(),
  time_taken: z.coerce.number().int().nullish(),
});

const attemptSchema = z.object({
  candidate_ref: z.string().min(1),
  started_at: z.string().nullish(),
  submitted_at: z.string().nullish(),
  total_score: z.coerce.number().nullish(),
  max_score: z.coerce.number().nullish(),
  responses: z.array(responseSchema).min(1),
});

const flatRowSchema = z.object({
  candidate_ref: z.string().min(1),
  qid: z.string().min(1),
  chosen_option: z.string().nullish(),
  is_correct: z.union([z.boolean(), z.coerce.number(), z.string()]).nullish(),
  score: z.coerce.number().nullish(),
  time_taken: z.coerce.number().int().nullish(),
  total_score: z.coerce.number().nullish(),
});

/** Coerces the many ways a results file spells a boolean. */
function toBool(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'y', 'yes', 'correct', 't'].includes(text)) return true;
  if (['0', 'false', 'n', 'no', 'incorrect', 'wrong', 'f'].includes(text)) return false;
  return null;
}

/** Groups flat rows into attempts. */
function groupFlatRows(rows) {
  const byCandidate = new Map();
  for (const row of rows) {
    if (!byCandidate.has(row.candidate_ref)) {
      byCandidate.set(row.candidate_ref, {
        candidate_ref: row.candidate_ref,
        total_score: row.total_score ?? null,
        responses: [],
      });
    }
    const attempt = byCandidate.get(row.candidate_ref);
    if (row.total_score !== null && row.total_score !== undefined) attempt.total_score = row.total_score;
    attempt.responses.push({
      qid: row.qid,
      chosen_option: row.chosen_option ?? null,
      is_correct: toBool(row.is_correct),
      score: row.score ?? null,
      time_taken: row.time_taken ?? null,
    });
  }
  return [...byCandidate.values()];
}

/**
 * Ingests attempts for one test.
 *
 * Re-submitting the same candidate replaces that attempt rather than
 * duplicating it, so a corrected results file can simply be re-uploaded.
 */
function ingest(db, testDbId, attempts, user) {
  // Only QIDs that are actually in this test are accepted; a response to
  // something else is a sign the file belongs to a different paper.
  const inTest = new Map(
    db.prepare('SELECT qid, question_id FROM test_questions WHERE test_id = ?').all(testDbId).map((r) => [r.qid, r.question_id]),
  );
  if (!inTest.size) throw badRequest('That test has no questions, so results cannot be attached to it.');

  const upsertAttempt = db.prepare(
    `INSERT INTO test_attempts (test_id, candidate_ref, started_at, submitted_at, total_score, max_score, source)
     VALUES (?, ?, ?, ?, ?, ?, 'import')
     ON CONFLICT (test_id, candidate_ref) DO UPDATE SET
       started_at = excluded.started_at, submitted_at = excluded.submitted_at,
       total_score = excluded.total_score, max_score = excluded.max_score
     RETURNING id`,
  );
  const clearResponses = db.prepare('DELETE FROM attempt_responses WHERE attempt_id = ?');
  const insertResponse = db.prepare(
    `INSERT INTO attempt_responses (attempt_id, question_id, qid, chosen_option, is_correct, score, time_taken)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const unknownQids = new Set();
  let responses = 0;

  const run = db.transaction(() => {
    for (const attempt of attempts) {
      // A total score is needed for the discrimination correlation; derive it
      // when the file does not carry one.
      const derived = attempt.responses.reduce(
        (sum, r) => sum + (r.score ?? (r.is_correct ? 1 : 0)), 0,
      );
      const total = attempt.total_score ?? derived;

      const attemptId = upsertAttempt.get(
        testDbId, attempt.candidate_ref, attempt.started_at ?? null, attempt.submitted_at ?? null,
        total, attempt.max_score ?? null,
      ).id;

      clearResponses.run(attemptId);
      for (const response of attempt.responses) {
        const questionId = inTest.get(response.qid);
        if (!questionId) { unknownQids.add(response.qid); continue; }
        insertResponse.run(
          attemptId, questionId, response.qid, response.chosen_option ?? null,
          response.is_correct === null || response.is_correct === undefined ? null : response.is_correct ? 1 : 0,
          response.score ?? null, response.time_taken ?? null,
        );
        responses += 1;
      }
    }
  });

  run();

  // Statistics are only meaningful once the responses are in.
  const recomputed = recomputeStatistics();
  audit(user?.id, 'results.ingest', 'test', String(testDbId), { attempts: attempts.length, responses });

  return {
    attempts: attempts.length,
    responses,
    ignoredQids: [...unknownQids],
    statisticsRecomputed: recomputed.questions,
  };
}

function loadTest(req, res, next) {
  const id = Number(req.params.id);
  const test = getDb()
    .prepare('SELECT id, test_id FROM tests WHERE id = ? OR test_id = ?')
    .get(Number.isFinite(id) ? id : -1, req.params.id);
  if (!test) return next(notFound('Test not found'));
  req.testRow = test;
  next();
}

/** Structured ingestion: one object per attempt. */
router.post('/tests/:id/attempts', requirePermission('results:write'), loadTest, validateBody(z.object({
  attempts: z.array(attemptSchema).min(1).max(5000),
})), (req, res) => {
  res.status(201).json(ingest(getDb(), req.testRow.id, req.body.attempts, req.user));
});

/** Flat ingestion: one row per response, the usual CSV shape. */
router.post('/tests/:id/responses', requirePermission('results:write'), loadTest, validateBody(z.object({
  rows: z.array(flatRowSchema).min(1).max(100000),
})), (req, res) => {
  res.status(201).json(ingest(getDb(), req.testRow.id, groupFlatRows(req.body.rows), req.user));
});

/** Attempt-level and item-level results for one test. */
router.get('/tests/:id/results', requirePermission('results:read'), loadTest, (req, res) => {
  res.json(testResults(req.testRow.id));
});

router.delete('/tests/:id/attempts', requirePermission('results:write'), loadTest, (req, res) => {
  const removed = getDb().prepare('DELETE FROM test_attempts WHERE test_id = ?').run(req.testRow.id).changes;
  recomputeStatistics();
  audit(req.user.id, 'results.clear', 'test', String(req.testRow.id), { removed });
  res.json({ removed });
});

/** Bank-wide item quality. */
router.get('/items/overview', requirePermission('results:read'), (req, res) => {
  res.json(itemQualityOverview({ limit: Math.min(Number(req.query.limit) || 20, 100) }));
});

/** Forces a recompute — useful after editing keys or importing older data. */
router.post('/items/recompute', requirePermission('results:write'), (req, res) => {
  res.json(recomputeStatistics());
});

export default router;
