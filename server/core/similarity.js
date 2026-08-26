/**
 * Near-duplicate detection.
 *
 * Duplicate prevention elsewhere in the application works on QID: the same
 * question cannot appear twice in one test. That does not help when the bank
 * holds two *different* QIDs carrying the same question, which is common in
 * banks assembled from several sources. A test drawing both looks correct and
 * is not.
 *
 * The approach is word shingling with a Jaccard estimate:
 *
 *   1. Normalise the text (case, punctuation, whitespace, digits).
 *   2. Break it into overlapping k-word shingles.
 *   3. Keep the smallest N shingle hashes as a fingerprint (a MinHash-style
 *      sketch), stored on the row so tokenisation happens once at write time.
 *   4. Candidates are rows sharing at least one fingerprint hash; only those
 *      get the exact comparison.
 *
 * That last step is what keeps this usable on a large bank: without it, finding
 * duplicates is quadratic in the number of questions.
 */

import { fnv1a } from './rng.js';

const SHINGLE_SIZE = 3;
const SKETCH_SIZE = 12;

/** Lower-cases, strips punctuation, and collapses runs of digits. */
export function normaliseText(text) {
  return String(text ?? '')
    .toLowerCase()
    // Reference numbers and item ids differ between copies of the same
    // question, so they must not make two duplicates look distinct.
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Overlapping k-word shingles. Short texts fall back to the words themselves. */
export function shingles(text, size = SHINGLE_SIZE) {
  const words = normaliseText(text).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  if (words.length < size) return [words.join(' ')];

  const out = [];
  for (let i = 0; i <= words.length - size; i += 1) {
    out.push(words.slice(i, i + size).join(' '));
  }
  return out;
}

/**
 * A compact fingerprint: the smallest SKETCH_SIZE shingle hashes, in hex.
 * Two texts that share content share fingerprint entries with high probability,
 * which is what makes candidate lookup an indexed string match.
 */
export function fingerprint(text) {
  const hashes = [...new Set(shingles(text).map((s) => fnv1a(s)))].sort((a, b) => a - b);
  if (!hashes.length) return '';
  return hashes.slice(0, SKETCH_SIZE).map((h) => h.toString(16).padStart(8, '0')).join(' ');
}

/** Jaccard similarity of two texts' shingle sets, in [0, 1]. */
export function similarity(a, b) {
  const setA = new Set(shingles(a));
  const setB = new Set(shingles(b));
  if (!setA.size || !setB.size) return 0;

  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** Fingerprint hashes as an array, for candidate lookup. */
export function fingerprintParts(value) {
  return String(value ?? '').split(' ').filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Database-backed lookups
 * ------------------------------------------------------------------ */

/** (Re)computes and stores the fingerprint for one question. */
export function storeFingerprint(db, questionId, text) {
  db.prepare('UPDATE questions SET text_fingerprint = ? WHERE id = ?').run(fingerprint(text), questionId);
}

/**
 * Backfills fingerprints for rows that do not have one yet.
 * Returns how many rows were updated.
 */
export function backfillFingerprints(db, { batchSize = 5000 } = {}) {
  const select = db.prepare(
    'SELECT id, question_text FROM questions WHERE text_fingerprint IS NULL LIMIT ?',
  );
  const update = db.prepare('UPDATE questions SET text_fingerprint = ? WHERE id = ?');

  let total = 0;
  for (;;) {
    const rows = select.all(batchSize);
    if (!rows.length) break;
    const run = db.transaction(() => {
      for (const row of rows) update.run(fingerprint(row.question_text), row.id);
    });
    run();
    total += rows.length;
    if (rows.length < batchSize) break;
  }
  return total;
}

/**
 * Questions similar to the given one.
 *
 * Candidates are narrowed by shared fingerprint hashes before any text is
 * compared, so this stays fast on a large bank.
 */
export function findSimilar(db, questionId, { threshold = 0.6, limit = 20 } = {}) {
  const source = db.prepare('SELECT id, qid, question_text, text_fingerprint FROM questions WHERE id = ?').get(questionId);
  if (!source) return [];

  const parts = fingerprintParts(source.text_fingerprint);
  if (!parts.length) return [];

  // Any candidate sharing at least one sketch entry.
  const like = parts.map(() => 'q.text_fingerprint LIKE ?').join(' OR ');
  const params = parts.map((p) => `%${p}%`);

  const candidates = db
    .prepare(
      `SELECT q.id, q.qid, q.question_text, q.question_type, q.difficulty, q.status
         FROM questions q
        WHERE q.id <> ? AND (${like})
        LIMIT 400`,
    )
    .all(questionId, ...params);

  return candidates
    .map((c) => ({ ...c, similarity: Number(similarity(source.question_text, c.question_text).toFixed(3)) }))
    .filter((c) => c.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Bank-wide duplicate report.
 *
 * Groups are built from exact fingerprint collisions first — the cheap signal —
 * then each group is verified with real similarity so a coincidental collision
 * is not reported as a duplicate.
 */
export function duplicateReport(db, { threshold = 0.6, limit = 50 } = {}) {
  const collisions = db
    .prepare(
      `SELECT text_fingerprint, COUNT(*) AS n
         FROM questions
        WHERE text_fingerprint IS NOT NULL AND text_fingerprint <> ''
        GROUP BY text_fingerprint HAVING n > 1
        ORDER BY n DESC LIMIT ?`,
    )
    .all(limit * 2);

  const groups = [];
  for (const collision of collisions) {
    const members = db
      .prepare(
        `SELECT id, qid, question_text, question_type, difficulty, status
           FROM questions WHERE text_fingerprint = ? LIMIT 25`,
      )
      .all(collision.text_fingerprint);
    if (members.length < 2) continue;

    // Verify against the first member so a hash collision alone is not enough.
    const [first, ...rest] = members;
    const verified = rest.filter((m) => similarity(first.question_text, m.question_text) >= threshold);
    if (!verified.length) continue;

    groups.push({
      questions: [first, ...verified].map((m) => ({
        id: m.id, qid: m.qid, question_type: m.question_type,
        difficulty: m.difficulty, status: m.status,
        question_text: m.question_text.slice(0, 240),
      })),
      size: verified.length + 1,
      similarity: Number(similarity(first.question_text, verified[0].question_text).toFixed(3)),
    });
    if (groups.length >= limit) break;
  }

  return groups;
}

/**
 * Checks a set of questions for near-duplicates among themselves.
 * Used at generation time to warn when one test draws two versions of the
 * same question under different QIDs.
 */
export function findDuplicatePairs(questions, { threshold = 0.6 } = {}) {
  const pairs = [];
  for (let i = 0; i < questions.length; i += 1) {
    for (let j = i + 1; j < questions.length; j += 1) {
      const score = similarity(questions[i].question_text, questions[j].question_text);
      if (score >= threshold) {
        pairs.push({ a: questions[i].qid, b: questions[j].qid, similarity: Number(score.toFixed(3)) });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}
