/**
 * In-place upgrades for databases created by an earlier release.
 *
 * `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so it never alters a table
 * that already exists. Anything that changes the shape of an existing table has
 * to happen here, before the schema is applied.
 */

/** Column names of an existing table, or [] when the table is absent. */
function columnsOf(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

const tableSql = (db, table) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '';

/** Adds a nullable column when it is missing. Safe to re-run. */
function addColumn(db, table, column, definition, added) {
  if (!columnsOf(db, table).length) return;
  if (columnsOf(db, table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  added.push(`${table}.${column}`);
}

/**
 * Widens `tests.status` to include the review states.
 *
 * A CHECK constraint cannot be altered in SQLite, so the table is rebuilt:
 * create the new shape, copy the rows, swap the names. Child rows reference
 * `tests.id`, which is preserved, and foreign keys are deferred for the
 * swap so the copy does not trip them.
 */
function widenTestStatus(db, notes) {
  const sql = tableSql(db, 'tests');
  if (!sql || sql.includes("'review'")) return;

  const existing = columnsOf(db, 'tests');
  // Only columns present in both shapes can be copied across.
  const carried = existing.filter((c) => !['submitted_at', 'submitted_by', 'reviewed_at', 'reviewed_by', 'review_notes'].includes(c));
  const columnList = carried.join(', ');

  db.exec(`
    CREATE TABLE tests_upgraded (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id                 TEXT NOT NULL UNIQUE,
      test_name               TEXT NOT NULL,
      description             TEXT,
      course                  TEXT,
      duration_minutes        INTEGER NOT NULL DEFAULT 60,
      total_marks             REAL NOT NULL DEFAULT 0,
      instructions            TEXT,
      starts_at               TEXT,
      ends_at                 TEXT,
      status                  TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'review', 'approved', 'published', 'archived')),
      submitted_at            TEXT,
      submitted_by            INTEGER REFERENCES users (id) ON DELETE SET NULL,
      reviewed_at             TEXT,
      reviewed_by             INTEGER REFERENCES users (id) ON DELETE SET NULL,
      review_notes            TEXT,
      generation_mode         TEXT NOT NULL DEFAULT 'automatic'
                                CHECK (generation_mode IN ('automatic', 'manual', 'hybrid')),
      randomize_questions     INTEGER NOT NULL DEFAULT 1,
      randomize_options       INTEGER NOT NULL DEFAULT 1,
      prevent_duplicates      INTEGER NOT NULL DEFAULT 1,
      include_qid_in_student  INTEGER NOT NULL DEFAULT 0,
      random_seed             TEXT,
      template_id             INTEGER REFERENCES test_templates (id) ON DELETE SET NULL,
      parent_test_id          INTEGER REFERENCES tests (id) ON DELETE SET NULL,
      version_label           TEXT,
      created_by              INTEGER REFERENCES users (id) ON DELETE SET NULL,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

  db.exec(`INSERT INTO tests_upgraded (${columnList}) SELECT ${columnList} FROM tests`);
  db.exec('DROP TABLE tests');
  db.exec('ALTER TABLE tests_upgraded RENAME TO tests');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tests_created_by ON tests (created_by, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tests_status ON tests (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tests_parent ON tests (parent_test_id);
  `);
  notes.push('tests.status widened to include the review states');
}

/**
 * Applies every pending in-place upgrade. Returns what it changed so the
 * migration can report it.
 */
export function upgradeSchema(db) {
  const added = [];
  const notes = [];

  const run = db.transaction(() => {
    addColumn(db, 'questions', 'created_by', 'INTEGER REFERENCES users (id) ON DELETE SET NULL', added);
    addColumn(db, 'questions', 'updated_by', 'INTEGER REFERENCES users (id) ON DELETE SET NULL', added);
    addColumn(db, 'questions', 'text_fingerprint', 'TEXT', added);
    widenTestStatus(db, notes);
  });

  // The table rebuild has to run with foreign keys off; better-sqlite3 refuses
  // to change the pragma inside a transaction, so it is toggled around it.
  const hadForeignKeys = db.pragma('foreign_keys', { simple: true });
  if (hadForeignKeys) db.pragma('foreign_keys = OFF');
  try {
    run();
  } finally {
    if (hadForeignKeys) db.pragma('foreign_keys = ON');
  }

  return { added, notes };
}

export { columnsOf };
