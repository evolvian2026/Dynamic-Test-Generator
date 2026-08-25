/** User administration (spec §29) — admin only. */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePermission, ROLES, PERMISSIONS } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { notFound, conflict, badRequest } from '../middleware/errors.js';
import { audit } from '../services/testService.js';

const router = Router();
router.use(requireAuth);

const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(ROLES),
});

router.get('/roles', requirePermission('tests:read'), (req, res) => {
  res.json(ROLES.map((role) => ({ role, permissions: [...PERMISSIONS[role]] })));
});

router.get('/', requirePermission('users:read'), (req, res) => {
  res.json(
    getDb()
      .prepare('SELECT id, email, name, role, is_active, created_at FROM users ORDER BY role, name')
      .all()
      .map((u) => ({ ...u, is_active: !!u.is_active })),
  );
});

router.post('/', requirePermission('users:write'), validateBody(userSchema), (req, res, next) => {
  const db = getDb();
  const email = req.body.email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return next(conflict('A user with that email already exists.'));
  }
  const info = db
    .prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(email, req.body.name, bcrypt.hashSync(req.body.password, 10), req.body.role);
  audit(req.user.id, 'user.create', 'user', String(info.lastInsertRowid), { role: req.body.role });
  res.status(201).json(db.prepare('SELECT id, email, name, role, is_active, created_at FROM users WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/:id', requirePermission('users:write'), validateBody(z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(8).optional(),
})), (req, res, next) => {
  const db = getDb();
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return next(notFound('User not found'));

  // Never let the last active admin lock the platform out of itself.
  if ((req.body.role && req.body.role !== 'admin') || req.body.is_active === false) {
    if (user.role === 'admin') {
      const otherAdmins = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?`)
        .get(id).n;
      if (otherAdmins === 0) return next(badRequest('This is the last active administrator; the change was refused.'));
    }
  }

  db.prepare(
    `UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role),
                      is_active = COALESCE(?, is_active),
                      password_hash = COALESCE(?, password_hash),
                      updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    req.body.name ?? null,
    req.body.role ?? null,
    req.body.is_active === undefined ? null : req.body.is_active ? 1 : 0,
    req.body.password ? bcrypt.hashSync(req.body.password, 10) : null,
    id,
  );
  audit(req.user.id, 'user.update', 'user', String(id), Object.keys(req.body));
  res.json(db.prepare('SELECT id, email, name, role, is_active, created_at FROM users WHERE id = ?').get(id));
});

export default router;
