/**
 * Saved question sets.
 *
 * Templates save a whole test; this saves a *filter* on its own. Users rebuild
 * the same complex rule repeatedly — "active Hard coding items in DSA, not used
 * in the last 90 days" — and a named set makes that reusable from both the bank
 * explorer and a section rule.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePermission, can } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { notFound, forbidden, conflict } from '../middleware/errors.js';
import { countMatching, listMatching } from '../core/questions.js';
import { audit } from '../services/testService.js';

const router = Router();
router.use(requireAuth);

const setSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullish(),
  filter: z.record(z.string(), z.any()).default({}),
  is_shared: z.boolean().default(true),
});

const shape = (row) => ({
  ...row,
  filter: safeJson(row.filter),
  is_shared: !!row.is_shared,
});

function safeJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

/** Sets the caller may see: their own, plus everything shared. */
router.get('/', requirePermission('sets:read'), (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT s.*, u.name AS created_by_name
         FROM question_sets s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.is_shared = 1 OR s.created_by = ?
        ORDER BY s.name`,
    )
    .all(req.user.id);

  // The live count is what makes a saved set useful — a set that matched 300
  // questions last month may match 40 today.
  res.json(rows.map((row) => {
    const set = shape(row);
    let available = null;
    try { available = countMatching(set.filter); } catch { available = null; }
    return { ...set, available };
  }));
});

router.get('/:id', requirePermission('sets:read'), (req, res, next) => {
  const row = getDb().prepare('SELECT * FROM question_sets WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Question set not found'));
  if (!row.is_shared && row.created_by !== req.user.id && !can(req.user.role, 'users:write')) {
    return next(forbidden('That question set is private.'));
  }
  const set = shape(row);
  res.json({ ...set, available: safeCount(set.filter) });
});

/** A preview of what a set currently matches. */
router.get('/:id/questions', requirePermission('sets:read'), (req, res, next) => {
  const row = getDb().prepare('SELECT * FROM question_sets WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Question set not found'));
  const set = shape(row);
  res.json(listMatching(set.filter, {
    page: Number(req.query.page) || 1,
    pageSize: Math.min(Number(req.query.pageSize) || 25, 200),
  }));
});

router.post('/', requirePermission('sets:write'), validateBody(setSchema), (req, res, next) => {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM question_sets WHERE name = ?').get(req.body.name)) {
    return next(conflict(`A question set named "${req.body.name}" already exists.`));
  }
  const info = db
    .prepare('INSERT INTO question_sets (name, description, filter, is_shared, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(req.body.name, req.body.description ?? null, JSON.stringify(req.body.filter), req.body.is_shared ? 1 : 0, req.user.id);
  audit(req.user.id, 'set.create', 'question_set', String(info.lastInsertRowid), { name: req.body.name });
  res.status(201).json(shape(db.prepare('SELECT * FROM question_sets WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/:id', requirePermission('sets:write'), validateBody(setSchema.partial()), (req, res, next) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM question_sets WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Question set not found'));
  if (row.created_by !== req.user.id && !can(req.user.role, 'users:write')) {
    return next(forbidden('You can only edit question sets that you created.'));
  }

  db.prepare(
    `UPDATE question_sets
        SET name = COALESCE(?, name), description = COALESCE(?, description),
            filter = COALESCE(?, filter), is_shared = COALESCE(?, is_shared),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    req.body.name ?? null,
    req.body.description ?? null,
    req.body.filter ? JSON.stringify(req.body.filter) : null,
    req.body.is_shared === undefined ? null : req.body.is_shared ? 1 : 0,
    row.id,
  );
  audit(req.user.id, 'set.update', 'question_set', String(row.id), null);
  res.json(shape(db.prepare('SELECT * FROM question_sets WHERE id = ?').get(row.id)));
});

router.delete('/:id', requirePermission('sets:write'), (req, res, next) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM question_sets WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Question set not found'));
  if (row.created_by !== req.user.id && !can(req.user.role, 'users:write')) {
    return next(forbidden('You can only delete question sets that you created.'));
  }
  db.prepare('DELETE FROM question_sets WHERE id = ?').run(row.id);
  audit(req.user.id, 'set.delete', 'question_set', String(row.id), null);
  res.json({ deleted: true });
});

function safeCount(filter) {
  try { return countMatching(filter); } catch { return null; }
}

export default router;
