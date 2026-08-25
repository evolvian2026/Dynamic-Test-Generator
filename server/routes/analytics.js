/** Analytics dashboard (spec §13, §23). */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { bankStatistics, getFacet } from '../core/questions.js';

const router = Router();
router.use(requireAuth);

router.get('/overview', requirePermission('analytics:read'), (req, res) => {
  const db = getDb();
  const bank = bankStatistics();

  const tests = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
              SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
              SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
         FROM tests`,
    )
    .get();

  const recentTests = db
    .prepare(
      `SELECT t.id, t.test_id, t.test_name, t.status, t.created_at, u.name AS created_by_name,
              (SELECT COUNT(*) FROM test_questions tq WHERE tq.test_id = t.id) AS question_count
         FROM tests t LEFT JOIN users u ON u.id = t.created_by
        ORDER BY t.created_at DESC, t.id DESC LIMIT 8`,
    )
    .all();

  // Which questions are being reused most across generated tests.
  const mostUsed = db
    .prepare(
      `SELECT tq.qid, COUNT(*) AS uses, q.topic, q.difficulty, q.question_type
         FROM test_questions tq JOIN questions q ON q.id = tq.question_id
        GROUP BY tq.qid ORDER BY uses DESC, tq.qid LIMIT 10`,
    )
    .all();

  const coverage = db
    .prepare(
      `SELECT q.topic,
              COUNT(DISTINCT q.id) AS bank_questions,
              COUNT(DISTINCT tq.qid) AS used_questions
         FROM questions q LEFT JOIN test_questions tq ON tq.question_id = q.id
        GROUP BY q.topic ORDER BY bank_questions DESC LIMIT 20`,
    )
    .all();

  const testsPerDay = db
    .prepare(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
         FROM tests WHERE created_at >= datetime('now', '-30 days')
        GROUP BY day ORDER BY day`,
    )
    .all();

  res.json({
    bank,
    tests: {
      total: tests.total || 0,
      drafts: tests.drafts || 0,
      published: tests.published || 0,
      archived: tests.archived || 0,
    },
    recentTests,
    mostUsed,
    coverage,
    testsPerDay,
    templates: db.prepare('SELECT COUNT(*) AS n FROM test_templates').get().n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get().n,
  });
});

/** Difficulty / type / topic mix for one generated test. */
router.get('/tests/:id', requirePermission('analytics:read'), (req, res) => {
  const db = getDb();
  const test = db.prepare('SELECT id FROM tests WHERE id = ? OR test_id = ?').get(Number(req.params.id) || -1, req.params.id);
  if (!test) return res.status(404).json({ error: { message: 'Test not found' } });

  const rows = db
    .prepare(
      `SELECT q.difficulty, q.question_type, q.topic, q.subtopic, q.expected_seconds, tq.marks
         FROM test_questions tq JOIN questions q ON q.id = tq.question_id
        WHERE tq.test_id = ?`,
    )
    .all(test.id);

  const tally = (key) => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {});
  res.json({
    totalQuestions: rows.length,
    totalMarks: rows.reduce((a, r) => a + r.marks, 0),
    estimatedMinutes: Math.round(rows.reduce((a, r) => a + r.expected_seconds, 0) / 60),
    byDifficulty: tally('difficulty'),
    byType: tally('question_type'),
    byTopic: tally('topic'),
    bankTopics: getFacet('topic').length,
  });
});

/** Recent audit trail (admins only). */
router.get('/audit', requirePermission('users:read'), (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    )
    .all(Math.min(Number(req.query.limit) || 100, 500));
  res.json(rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
});

export default router;
