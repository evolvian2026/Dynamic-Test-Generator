import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';
import { seededHash } from '../core/rng.js';

let db = null;

/** Opens (once) the SQLite connection with production-oriented pragmas. */
export function getDb() {
  if (db) return db;

  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  }

  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');       // concurrent readers during writes
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');      // ~64 MB page cache
  db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped I/O

  // Deterministic, seed-driven ordering used by reproducible test generation.
  // Registering it in SQL lets the engine shuffle inside the database instead
  // of pulling a large candidate pool into Node.
  db.function('seeded_hash', { deterministic: true }, (seed, value) =>
    seededHash(String(seed ?? ''), String(value ?? '')),
  );

  return db;
}

/** Wraps a function in a transaction (better-sqlite3 transactions are sync). */
export function transaction(fn) {
  return getDb().transaction(fn);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export default getDb;
