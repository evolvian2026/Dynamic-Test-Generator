/** Test templates (spec §16) and the blueprint-driven smart generator (spec §26). */

import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePermission, can } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { notFound, forbidden, conflict } from '../middleware/errors.js';
import { audit } from '../services/testService.js';
import { buildBlueprintSections, BLUEPRINTS } from '../services/blueprint.js';

const router = Router();
router.use(requireAuth);

const configurationSchema = z.object({
  test: z.record(z.string(), z.any()).default({}),
  sections: z.array(z.record(z.string(), z.any())).default([]),
});

const templateSchema = z.object({
  template_name: z.string().min(1),
  description: z.string().nullish(),
  configuration: configurationSchema,
});

const parse = (row) => ({ ...row, configuration: safeJson(row.configuration) });
const safeJson = (v) => { try { return JSON.parse(v || '{}'); } catch { return {}; } };

router.get('/', requirePermission('templates:read'), (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT t.*, u.name AS created_by_name FROM test_templates t
         LEFT JOIN users u ON u.id = t.created_by
        ORDER BY t.template_name`,
    )
    .all();
  res.json(rows.map(parse));
});

/** Predefined blueprints for the smart generator (spec §26). */
router.get('/blueprints', requirePermission('templates:read'), (req, res) => {
  res.json(BLUEPRINTS);
});

/**
 * Turns a blueprint — total questions, difficulty mix and taxonomy scope —
 * into concrete sections. The question content itself always comes from the
 * bank; nothing is invented (spec §26).
 */
router.post('/blueprints/expand', requirePermission('tests:write'), validateBody(z.object({
  blueprintId: z.string().optional(),
  totalQuestions: z.coerce.number().int().min(1).max(500).default(50),
  difficultyMix: z.record(z.string(), z.coerce.number()).optional(),
  subjects: z.array(z.string()).default([]),
  areas: z.array(z.string()).default([]),
  questionTypeMix: z.record(z.string(), z.coerce.number()).optional(),
  marksPerQuestion: z.coerce.number().min(0).default(1),
  excludeTags: z.array(z.string()).default([]),
  includeTags: z.array(z.string()).default([]),
})), (req, res) => {
  res.json(buildBlueprintSections(req.body));
});

router.get('/:id', requirePermission('templates:read'), (req, res, next) => {
  const row = getDb().prepare('SELECT * FROM test_templates WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Template not found'));
  res.json(parse(row));
});

router.post('/', requirePermission('templates:write'), validateBody(templateSchema), (req, res, next) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM test_templates WHERE template_name = ?').get(req.body.template_name);
  if (existing) return next(conflict(`A template named "${req.body.template_name}" already exists.`));

  const info = db
    .prepare('INSERT INTO test_templates (template_name, description, configuration, created_by) VALUES (?, ?, ?, ?)')
    .run(req.body.template_name, req.body.description ?? null, JSON.stringify(req.body.configuration), req.user.id);
  audit(req.user.id, 'template.create', 'template', String(info.lastInsertRowid), null);
  res.status(201).json(parse(db.prepare('SELECT * FROM test_templates WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/:id', requirePermission('templates:write'), validateBody(templateSchema.partial()), (req, res, next) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM test_templates WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Template not found'));
  if (row.created_by !== req.user.id && !can(req.user.role, 'users:write')) {
    return next(forbidden('You can only edit templates that you created.'));
  }

  db.prepare(
    `UPDATE test_templates
        SET template_name = COALESCE(?, template_name),
            description = COALESCE(?, description),
            configuration = COALESCE(?, configuration),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    req.body.template_name ?? null,
    req.body.description ?? null,
    req.body.configuration ? JSON.stringify(req.body.configuration) : null,
    row.id,
  );
  audit(req.user.id, 'template.update', 'template', String(row.id), null);
  res.json(parse(db.prepare('SELECT * FROM test_templates WHERE id = ?').get(row.id)));
});

router.delete('/:id', requirePermission('templates:write'), (req, res, next) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM test_templates WHERE id = ?').get(Number(req.params.id));
  if (!row) return next(notFound('Template not found'));
  if (row.created_by !== req.user.id && !can(req.user.role, 'users:write')) {
    return next(forbidden('You can only delete templates that you created.'));
  }
  db.prepare('DELETE FROM test_templates WHERE id = ?').run(row.id);
  audit(req.user.id, 'template.delete', 'template', String(row.id), null);
  res.json({ deleted: true });
});

export default router;
