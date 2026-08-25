/**
 * Question-bank data access (spec §21).
 *
 * Everything here is server-side and index-driven: the browser never receives
 * the bank, only counts and pages. Random selection never materialises the
 * whole matching set — see `sampleQuestions`.
 */

import { getDb } from '../db/index.js';
import config from '../config.js';
import { compileFilter, toFtsQuery } from './filterEngine.js';
import { createRng, shuffle } from './rng.js';

const SORTABLE = new Set(['qid', 'question_type', 'topic', 'subtopic', 'difficulty', 'marks', 'status', 'created_at']);

/** Number of questions matching a filter. */
export function countMatching(filter, options = {}) {
  const { where, params } = compileFilter(filter, options);
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${where}`).get(...params);
  return row.n;
}

/** Paginated listing for the bank explorer and manual selection mode. */
export function listMatching(filter, options = {}) {
  const { page = 1, pageSize = 25, sort = 'qid', direction = 'asc', withDetails = false } = options;
  const size = Math.min(Math.max(1, Number(pageSize) || 25), config.maxPageSize);
  const pageNo = Math.max(1, Number(page) || 1);
  const sortCol = SORTABLE.has(sort) ? sort : 'qid';
  const dir = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const { where, params } = compileFilter(filter, options);
  const db = getDb();

  const total = db.prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT q.id, q.qid, q.question_type, q.question_text, q.topic, q.subtopic,
              q.difficulty, q.marks, q.expected_seconds, q.status, q.created_at
         FROM questions q
        WHERE ${where}
        ORDER BY q.${sortCol} ${dir}, q.id ${dir}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, size, (pageNo - 1) * size);

  const items = withDetails ? hydrate(rows) : attachTags(rows);
  return { items, total, page: pageNo, pageSize: size, pageCount: Math.max(1, Math.ceil(total / size)) };
}

/* ------------------------------------------------------------------ *
 * Random selection
 * ------------------------------------------------------------------ */

/**
 * Picks `count` distinct questions matching `filter`.
 *
 * Two strategies, chosen by match size, so the cost never scales with the
 * size of the bank:
 *
 *  1. Match set within `SELECTION_POOL_THRESHOLD` — order by the SQLite-side
 *     `seeded_hash(seed, qid)` and take the top N. Exact, uniform and
 *     reproducible, with no pool materialised in Node.
 *  2. Larger match set — seeded window sampling: jump to random anchor IDs
 *     and read short runs from the covering index. Each draw is an index
 *     seek rather than a scan, so a million-row match set costs the same as
 *     a thousand-row one.
 *
 * Passing a `seed` makes the result reproducible (spec §10).
 */
export function sampleQuestions(filter, options = {}) {
  const { count, seed = null, excludeQids = [] } = options;
  if (!count || count <= 0) return [];

  const db = getDb();
  const { where, params } = compileFilter(filter, { ...options, excludeQids });
  const total = db.prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${where}`).get(...params).n;
  if (total === 0) return [];

  const effectiveSeed = seed ?? `rnd-${Date.now()}-${Math.random()}`;
  const wanted = Math.min(count, total);

  if (total <= config.selection.poolThreshold) {
    return db
      .prepare(
        `SELECT q.id, q.qid FROM questions q
          WHERE ${where}
          ORDER BY seeded_hash(?, q.qid)
          LIMIT ?`,
      )
      .all(...params, String(effectiveSeed), wanted);
  }

  return windowSample({ where, params, total, wanted, seed: effectiveSeed });
}

/** Seeded window sampling for very large match sets. */
function windowSample({ where, params, total, wanted, seed }) {
  const db = getDb();
  const bounds = db
    .prepare(`SELECT MIN(q.id) AS lo, MAX(q.id) AS hi FROM questions q WHERE ${where}`)
    .get(...params);
  if (bounds.lo === null) return [];

  const stmtForward = db.prepare(
    `SELECT q.id, q.qid FROM questions q WHERE ${where} AND q.id >= ? ORDER BY q.id LIMIT ?`,
  );
  const stmtWrap = db.prepare(
    `SELECT q.id, q.qid FROM questions q WHERE ${where} ORDER BY q.id LIMIT ?`,
  );

  const rng = createRng(seed);
  const picked = new Map();
  const span = bounds.hi - bounds.lo + 1;
  // Read a few rows per probe and keep one at random: cheap, and it avoids
  // the clustering bias of always taking the first row after the anchor.
  const window = 8;
  const maxProbes = wanted * 12 + 64;

  for (let probe = 0; probe < maxProbes && picked.size < wanted; probe += 1) {
    const anchor = bounds.lo + Math.floor(rng() * span);
    let rows = stmtForward.all(...params, anchor, window);
    if (!rows.length) rows = stmtWrap.all(...params, window);
    if (!rows.length) break;
    const candidate = rows[Math.floor(rng() * rows.length)];
    if (!picked.has(candidate.qid)) picked.set(candidate.qid, candidate);
  }

  // Deterministic top-up if probing under-delivered on a sparse match set.
  if (picked.size < wanted) {
    const fill = db
      .prepare(`SELECT q.id, q.qid FROM questions q WHERE ${where} ORDER BY seeded_hash(?, q.qid) LIMIT ?`)
      .all(...params, String(seed), wanted * 3);
    for (const row of fill) {
      if (picked.size >= wanted) break;
      if (!picked.has(row.qid)) picked.set(row.qid, row);
    }
  }

  return shuffle([...picked.values()], createRng(`${seed}:order`)).slice(0, wanted);
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export function getQuestionByQid(qid, { withAnswers = false } = {}) {
  const row = getDb().prepare('SELECT * FROM questions WHERE qid = ?').get(qid);
  if (!row) return null;
  const [full] = hydrate([row], { withAnswers });
  return full;
}

export function getQuestionsByQids(qids, { withAnswers = false } = {}) {
  if (!qids.length) return [];
  const db = getDb();
  const rows = [];
  for (let i = 0; i < qids.length; i += 400) {
    const chunk = qids.slice(i, i + 400);
    rows.push(...db.prepare(`SELECT * FROM questions WHERE qid IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  const hydrated = hydrate(rows, { withAnswers });
  const byQid = new Map(hydrated.map((q) => [q.qid, q]));
  return qids.map((qid) => byQid.get(qid)).filter(Boolean);
}

/** Attaches tags to a set of rows in one query. */
function attachTags(rows) {
  if (!rows.length) return rows;
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const tagMap = new Map(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const tagRows = db
      .prepare(`SELECT question_id, tag FROM question_tags WHERE question_id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk);
    for (const t of tagRows) tagMap.get(t.question_id)?.push(t.tag);
  }
  return rows.map((r) => ({ ...r, tags: tagMap.get(r.id) || [] }));
}

/** Attaches tags, attributes and options; strips answers unless requested. */
export function hydrate(rows, { withAnswers = false } = {}) {
  if (!rows.length) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);

  const tagMap = new Map(ids.map((id) => [id, []]));
  const attrMap = new Map(ids.map((id) => [id, {}]));
  const optMap = new Map(ids.map((id) => [id, []]));

  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const t of db.prepare(`SELECT question_id, tag FROM question_tags WHERE question_id IN (${ph})`).all(...chunk)) {
      tagMap.get(t.question_id)?.push(t.tag);
    }
    for (const a of db
      .prepare(`SELECT question_id, attr_key, attr_value, num_value FROM question_attributes WHERE question_id IN (${ph})`)
      .all(...chunk)) {
      const bag = attrMap.get(a.question_id);
      if (!bag) continue;
      const value = a.num_value !== null ? a.num_value : a.attr_value;
      if (bag[a.attr_key] === undefined) bag[a.attr_key] = value;
      else if (Array.isArray(bag[a.attr_key])) bag[a.attr_key].push(value);
      else bag[a.attr_key] = [bag[a.attr_key], value];
    }
    for (const o of db
      .prepare(`SELECT id, question_id, position, option_text, is_correct FROM question_options WHERE question_id IN (${ph}) ORDER BY position`)
      .all(...chunk)) {
      optMap.get(o.question_id)?.push(o);
    }
  }

  return rows.map((r) => {
    const options = (optMap.get(r.id) || []).map((o) => ({
      id: o.id,
      position: o.position,
      option_text: o.option_text,
      ...(withAnswers ? { is_correct: !!o.is_correct } : {}),
    }));
    const base = {
      ...r,
      metadata: safeJson(r.metadata),
      tags: tagMap.get(r.id) || [],
      attributes: attrMap.get(r.id) || {},
      options,
    };
    if (!withAnswers) {
      delete base.answer_text;
      delete base.explanation;
    }
    return base;
  });
}

function safeJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

/* ------------------------------------------------------------------ *
 * Facets & statistics (spec §13)
 * ------------------------------------------------------------------ */

export function getFacet(dimension, parent = '') {
  return getDb()
    .prepare(
      `SELECT value, count FROM facet_counts
        WHERE dimension = ? AND parent = ? AND count > 0
        ORDER BY count DESC, value ASC`,
    )
    .all(dimension, parent);
}

export function getSubtopics(topic) {
  if (!topic) {
    return getDb()
      .prepare(
        `SELECT value, SUM(count) AS count FROM facet_counts
          WHERE dimension = 'subtopic' AND count > 0 AND value <> ''
          GROUP BY value ORDER BY count DESC, value ASC`,
      )
      .all();
  }
  return getFacet('subtopic', topic).filter((r) => r.value !== '');
}

export function bankStatistics() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.value, r.count]));
  return {
    total,
    byType: toMap(getFacet('question_type')),
    byDifficulty: toMap(getFacet('difficulty')),
    byStatus: toMap(getFacet('status')),
    byTopic: getFacet('topic'),
    byTag: getFacet('tag').slice(0, 60),
    totalTopics: getFacet('topic').length,
    totalTags: getFacet('tag').length,
  };
}

/** Suggests tags for autocomplete without scanning the tag table. */
export function searchTags(query = '', limit = 30) {
  const db = getDb();
  if (!query) return getFacet('tag').slice(0, limit);
  return db
    .prepare(
      `SELECT value, count FROM facet_counts
        WHERE dimension = 'tag' AND count > 0 AND value LIKE ? ESCAPE '\\'
        ORDER BY count DESC LIMIT ?`,
    )
    .all(`%${String(query).replace(/[\\%_]/g, (m) => `\\${m}`)}%`, limit);
}

export { toFtsQuery };
