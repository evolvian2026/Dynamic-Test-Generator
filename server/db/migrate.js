import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { getDb, closeDb } from './index.js';
import config from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrate({ quiet = false } = {}) {
  const db = getDb();
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', '1')
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run();

  const admin = ensureBootstrapAdmin(db);
  if (!quiet) {
    console.log(`Schema ready at ${config.databasePath}`);
    if (admin.created) {
      console.log(`Bootstrap admin created: ${admin.email}`);
      console.log('Change this password immediately in any shared environment.');
    }
  }
  return db;
}

/** Creates the first admin so a fresh deployment is usable, exactly once. */
function ensureBootstrapAdmin(db) {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
  if (existing > 0) return { created: false };

  const { email, password, name } = config.bootstrapAdmin;
  db.prepare(
    `INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')
       ON CONFLICT (email) DO NOTHING`,
  ).run(email.toLowerCase(), name, bcrypt.hashSync(password, 10));
  return { created: true, email };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  closeDb();
}
