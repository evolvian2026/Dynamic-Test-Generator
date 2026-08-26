/**
 * Application settings.
 *
 * A small key/value store for the handful of values that are genuinely
 * installation-wide rather than per-test — currently the branding printed on
 * exported papers.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { badRequest } from '../middleware/errors.js';
import { audit } from '../services/testService.js';

const router = Router();
router.use(requireAuth);

/** Only these keys are writable; the table is not a free-form bucket. */
const ALLOWED = {
  institution_name: z.string().max(200).nullable(),
  institution_logo: z.string().max(1_500_000).nullable(),
  paper_footer: z.string().max(300).nullable(),
};

const LOGO_PATTERN = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/i;

router.get('/', requirePermission('tests:read'), (req, res) => {
  const rows = getDb().prepare('SELECT key, value FROM app_settings').all();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json({
    institution_name: settings.institution_name ?? null,
    // The logo can be large; the listing reports only whether one is set.
    institution_logo: settings.institution_logo ?? null,
    hasLogo: Boolean(settings.institution_logo),
    paper_footer: settings.paper_footer ?? null,
  });
});

router.put('/', requirePermission('settings:write'), validateBody(z.object({
  institution_name: z.string().max(200).nullish(),
  institution_logo: z.string().nullish(),
  paper_footer: z.string().max(300).nullish(),
})), (req, res, next) => {
  const db = getDb();

  if (req.body.institution_logo) {
    // Only inline images are accepted: exports must never fetch a remote URL.
    if (!LOGO_PATTERN.test(req.body.institution_logo)) {
      return next(badRequest('The logo must be an inline PNG or JPEG data URI (data:image/png;base64,...).'));
    }
    if (req.body.institution_logo.length > 1_500_000) {
      return next(badRequest('The logo is too large; keep it under about 1 MB.'));
    }
  }

  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  const run = db.transaction(() => {
    for (const key of Object.keys(ALLOWED)) {
      if (req.body[key] === undefined) continue;
      upsert.run(key, req.body[key] === null ? null : String(req.body[key]));
    }
  });
  run();

  audit(req.user.id, 'settings.update', 'settings', null, Object.keys(req.body));
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json({
    institution_name: settings.institution_name ?? null,
    institution_logo: settings.institution_logo ?? null,
    hasLogo: Boolean(settings.institution_logo),
    paper_footer: settings.paper_footer ?? null,
  });
});

export default router;
