/**
 * Authentication and role-based access control (spec §29).
 *
 * Every permission decision is made here, on the server. The client's role is
 * used only to hide controls — it is never trusted for authorisation.
 */

import jwt from 'jsonwebtoken';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { unauthorized, forbidden } from './errors.js';

export const ROLES = ['admin', 'creator', 'viewer'];

/** Capability matrix — the single source of truth for what each role may do. */
export const PERMISSIONS = {
  admin: new Set([
    'questions:read', 'questions:write',
    'tests:read', 'tests:write', 'tests:delete', 'tests:read:all',
    'templates:read', 'templates:write',
    'exports:read', 'analytics:read',
    'users:read', 'users:write',
  ]),
  creator: new Set([
    'questions:read',
    'tests:read', 'tests:write', 'tests:delete',
    'templates:read', 'templates:write',
    'exports:read', 'analytics:read',
  ]),
  viewer: new Set([
    'questions:read', 'tests:read', 'exports:read', 'analytics:read',
  ]),
};

export function can(role, permission) {
  return PERMISSIONS[role]?.has(permission) ?? false;
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );
}

function readToken(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[config.jwt.cookieName] || null;
}

/** Populates req.user, or 401s. */
export function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch {
    return next(unauthorized('Your session has expired. Please sign in again.'));
  }

  // Re-read the user so a deactivated account or a role change takes effect
  // immediately, rather than lingering until the token expires.
  const user = getDb()
    .prepare('SELECT id, email, name, role, is_active FROM users WHERE id = ?')
    .get(payload.sub);

  if (!user || !user.is_active) return next(unauthorized('This account is no longer active.'));

  req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  next();
}

/** Guards a route by capability. */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user.role, permission)) {
      return next(forbidden(`Your role (${req.user.role}) cannot perform this action.`));
    }
    next();
  };
}

/**
 * Ownership check for tests: creators manage their own tests, admins manage
 * every test, viewers modify nothing.
 */
export function assertCanModifyTest(user, test) {
  if (!test) return;
  if (can(user.role, 'tests:read:all')) return;
  if (test.created_by !== user.id) {
    throw forbidden('You can only modify tests that you created.');
  }
}
