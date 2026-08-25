import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { getDb, closeDb } from './index.js';
import config from '../config.js';
import { loadTaxonomy } from '../core/taxonomy.js';
import { backfillLegacyTaxonomy, hasLegacyTaxonomyColumns, dropLegacyTaxonomySchema } from './backfill.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrate({ quiet = false } = {}) {
  const db = getDb();

  // A database created before the taxonomy release still carries the old
  // single-value topic/subtopic columns. Capture them before the new schema
  // runs so the mappings can be rebuilt rather than lost, then remove the
  // legacy columns, indexes and triggers — `CREATE ... IF NOT EXISTS` would
  // leave them in place, and the old triggers reference `topic`, so any later
  // insert would fail against the new schema.
  const legacy = hasLegacyTaxonomyColumns(db) ? readLegacyClassification(db) : null;
  if (legacy) dropLegacyTaxonomySchema(db);

  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', '2')
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run();

  // The taxonomy is reference data: loading it is part of every migration so a
  // fresh deployment and an upgraded one end up identical.
  const taxonomy = loadTaxonomy({ quiet: true });

  if (legacy) {
    const report = backfillLegacyTaxonomy(db, legacy, { quiet });
    if (!quiet) {
      console.log(
        `Legacy classification migrated: ${report.mapped} of ${report.total} questions matched ` +
        `the new taxonomy (${report.unmatched} unmatched).`,
      );
    }
  }

  const admin = ensureBootstrapAdmin(db);
  if (!quiet) {
    console.log(`Schema ready at ${config.databasePath}`);
    console.log(
      `Taxonomy: ${taxonomy.subjects} subjects, ${taxonomy.areas} areas, ` +
      `${taxonomy.subAreas} sub-areas, ${taxonomy.tags} tags.`,
    );
    if (admin.created) {
      console.log(`Bootstrap admin created: ${admin.email}`);
      console.log('Change this password immediately in any shared environment.');
    }
  }
  return db;
}

/** Snapshot of the pre-taxonomy classification, keyed by question id. */
function readLegacyClassification(db) {
  return db.prepare('SELECT id, qid, topic, subtopic FROM questions').all();
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
