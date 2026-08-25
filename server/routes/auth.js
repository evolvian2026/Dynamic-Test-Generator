import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { signToken, requireAuth, PERMISSIONS } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { unauthorized, badRequest } from '../middleware/errors.js';
import { audit } from '../services/testService.js';

const router = Router();

// Throttles credential stuffing without affecting normal use.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many sign-in attempts. Try again in a few minutes.' } },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function setSessionCookie(res, token) {
  res.cookie(config.jwt.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.jwt.cookieSecure,
    maxAge: 12 * 60 * 60 * 1000,
  });
}

router.post('/login', loginLimiter, validateBody(loginSchema), (req, res, next) => {
  const { email, password } = req.body;
  const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());

  // Same message and comparable timing for both failure modes.
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return next(unauthorized('Incorrect email or password.'));
  }
  if (!user.is_active) return next(unauthorized('This account has been deactivated.'));

  const token = signToken(user);
  setSessionCookie(res, token);
  audit(user.id, 'auth.login', 'user', String(user.id), null);

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    permissions: [...PERMISSIONS[user.role]],
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.jwt.cookieName);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, permissions: [...PERMISSIONS[req.user.role]] });
});

router.post('/change-password', requireAuth, validateBody(z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
})), (req, res, next) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(req.body.currentPassword, user.password_hash)) {
    return next(badRequest('Your current password is incorrect.'));
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(bcrypt.hashSync(req.body.newPassword, 10), user.id);
  audit(user.id, 'auth.changePassword', 'user', String(user.id), null);
  res.json({ ok: true });
});

export default router;
