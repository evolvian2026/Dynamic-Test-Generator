-- ===========================================================================
--  Dynamic Test Generator — schema
--
--  Design principles (spec §20, §21, §28, §30):
--    * The question bank, the selection rules, the test sections and the
--      generated test questions are four separate concerns. A generated test
--      never copies question content — it stores QIDs only.
--    * Extensible metadata lives in `question_attributes` (key/value) so new
--      filterable fields can be added with zero schema migrations.
--    * Every dimension the filter engine touches is indexed, and facet counts
--      are maintained incrementally so dashboards and dropdowns never scan
--      the whole bank.
-- ===========================================================================

-- ------------------------------ users --------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'creator', 'viewer')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- --------------------------- question bank ---------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  qid              TEXT NOT NULL UNIQUE,
  question_type    TEXT NOT NULL,
  question_text    TEXT NOT NULL,
  topic            TEXT NOT NULL,
  subtopic         TEXT,
  difficulty       TEXT NOT NULL,
  marks            REAL NOT NULL DEFAULT 1,
  expected_seconds INTEGER NOT NULL DEFAULT 60,
  status           TEXT NOT NULL DEFAULT 'active',
  answer_text      TEXT,
  explanation      TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Composite index ordered from most to least selective for the common
-- "type + topic + difficulty" section rule; SQLite can use any left prefix.
CREATE INDEX IF NOT EXISTS idx_questions_selection
  ON questions (status, question_type, topic, difficulty, subtopic, id);
CREATE INDEX IF NOT EXISTS idx_questions_topic_sub
  ON questions (topic, subtopic, status, id);
CREATE INDEX IF NOT EXISTS idx_questions_difficulty
  ON questions (difficulty, status, id);
CREATE INDEX IF NOT EXISTS idx_questions_type
  ON questions (question_type, status, id);
CREATE INDEX IF NOT EXISTS idx_questions_marks ON questions (marks);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions (status);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions (created_at);

CREATE TABLE IF NOT EXISTS question_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  option_text TEXT NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_options_question ON question_options (question_id, position);

CREATE TABLE IF NOT EXISTS question_tags (
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (question_id, tag)
) WITHOUT ROWID;
-- Tag-first index: "questions carrying tag X" is an index range scan.
CREATE INDEX IF NOT EXISTS idx_tags_tag ON question_tags (tag, question_id);

-- Extensible metadata (spec §28). Any future field — company, bloom level,
-- success rate, year — is stored here and becomes filterable immediately.
CREATE TABLE IF NOT EXISTS question_attributes (
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  attr_key    TEXT NOT NULL,
  attr_value  TEXT NOT NULL,
  num_value   REAL,
  PRIMARY KEY (question_id, attr_key, attr_value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_attr_lookup ON question_attributes (attr_key, attr_value, question_id);
CREATE INDEX IF NOT EXISTS idx_attr_numeric ON question_attributes (attr_key, num_value, question_id);

-- Full-text search over question text (external-content FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5 (
  question_text,
  content='questions',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS questions_fts_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts (rowid, question_text) VALUES (new.id, new.question_text);
END;
CREATE TRIGGER IF NOT EXISTS questions_fts_ad AFTER DELETE ON questions BEGIN
  INSERT INTO questions_fts (questions_fts, rowid, question_text) VALUES ('delete', old.id, old.question_text);
END;
CREATE TRIGGER IF NOT EXISTS questions_fts_au AFTER UPDATE OF question_text ON questions BEGIN
  INSERT INTO questions_fts (questions_fts, rowid, question_text) VALUES ('delete', old.id, old.question_text);
  INSERT INTO questions_fts (rowid, question_text) VALUES (new.id, new.question_text);
END;

-- ---------------------------- facet counts ---------------------------------
-- Incrementally maintained aggregates so the Question Bank dashboard and the
-- filter dropdowns stay O(1) regardless of bank size (spec §13, §21).
CREATE TABLE IF NOT EXISTS facet_counts (
  dimension TEXT NOT NULL,
  parent    TEXT NOT NULL DEFAULT '',
  value     TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dimension, parent, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_facet_dimension ON facet_counts (dimension, count DESC);

CREATE TRIGGER IF NOT EXISTS questions_facets_ai AFTER INSERT ON questions BEGIN
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('question_type', '', new.question_type, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('topic', '', new.topic, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('subtopic', new.topic, COALESCE(new.subtopic, ''), 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('difficulty', '', new.difficulty, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('status', '', new.status, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER IF NOT EXISTS questions_facets_ad AFTER DELETE ON questions BEGIN
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'question_type' AND parent = '' AND value = old.question_type;
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'topic' AND parent = '' AND value = old.topic;
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'subtopic' AND parent = old.topic AND value = COALESCE(old.subtopic, '');
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'difficulty' AND parent = '' AND value = old.difficulty;
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'status' AND parent = '' AND value = old.status;
  DELETE FROM facet_counts WHERE count <= 0;
END;

CREATE TRIGGER IF NOT EXISTS questions_facets_au AFTER UPDATE ON questions BEGIN
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'question_type' AND parent = '' AND value = old.question_type;
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'topic' AND parent = '' AND value = old.topic;
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'subtopic' AND parent = old.topic AND value = COALESCE(old.subtopic, '');
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'difficulty' AND parent = '' AND value = old.difficulty;
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'status' AND parent = '' AND value = old.status;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('question_type', '', new.question_type, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('topic', '', new.topic, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('subtopic', new.topic, COALESCE(new.subtopic, ''), 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('difficulty', '', new.difficulty, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('status', '', new.status, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
  DELETE FROM facet_counts WHERE count <= 0;
END;

CREATE TRIGGER IF NOT EXISTS tags_facets_ai AFTER INSERT ON question_tags BEGIN
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('tag', '', new.tag, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
END;
CREATE TRIGGER IF NOT EXISTS tags_facets_ad AFTER DELETE ON question_tags BEGIN
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'tag' AND parent = '' AND value = old.tag;
  DELETE FROM facet_counts WHERE dimension = 'tag' AND count <= 0;
END;

CREATE TRIGGER IF NOT EXISTS attrs_facets_ai AFTER INSERT ON question_attributes BEGIN
  INSERT INTO facet_counts (dimension, parent, value, count) VALUES ('attribute', new.attr_key, new.attr_value, 1)
    ON CONFLICT (dimension, parent, value) DO UPDATE SET count = count + 1;
END;
CREATE TRIGGER IF NOT EXISTS attrs_facets_ad AFTER DELETE ON question_attributes BEGIN
  UPDATE facet_counts SET count = count - 1 WHERE dimension = 'attribute' AND parent = old.attr_key AND value = old.attr_value;
  DELETE FROM facet_counts WHERE dimension = 'attribute' AND count <= 0;
END;

-- ------------------------------- tests -------------------------------------
CREATE TABLE IF NOT EXISTS tests (
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
                            CHECK (status IN ('draft', 'published', 'archived')),
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
);
CREATE INDEX IF NOT EXISTS idx_tests_created_by ON tests (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tests_status ON tests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tests_parent ON tests (parent_test_id);

CREATE TABLE IF NOT EXISTS test_sections (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id              INTEGER NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  section_name         TEXT NOT NULL,
  section_description  TEXT,
  section_order        INTEGER NOT NULL DEFAULT 1,
  question_count       INTEGER NOT NULL DEFAULT 0,
  marks_per_question   REAL NOT NULL DEFAULT 1,
  negative_marks       REAL NOT NULL DEFAULT 0,
  time_limit_minutes   INTEGER,
  selection_rules      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sections_test ON test_sections (test_id, section_order);

CREATE TABLE IF NOT EXISTS test_questions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id          INTEGER NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  section_id       INTEGER NOT NULL REFERENCES test_sections (id) ON DELETE CASCADE,
  question_id      INTEGER NOT NULL REFERENCES questions (id) ON DELETE RESTRICT,
  qid              TEXT NOT NULL,
  question_order   INTEGER NOT NULL DEFAULT 1,
  marks            REAL NOT NULL DEFAULT 1,
  selection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_test_questions_test ON test_questions (test_id, section_id, question_order);
CREATE INDEX IF NOT EXISTS idx_test_questions_qid ON test_questions (test_id, qid);
CREATE INDEX IF NOT EXISTS idx_test_questions_question ON test_questions (question_id);

CREATE TABLE IF NOT EXISTS test_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL,
  description   TEXT,
  configuration TEXT NOT NULL DEFAULT '{}',
  created_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_name ON test_templates (template_name);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
