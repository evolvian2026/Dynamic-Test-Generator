/**
 * Upgrade path from the pre-taxonomy schema.
 *
 * Before the taxonomy release a question carried a single `topic` and
 * `subtopic` string. The taxonomy replaces those with a many-to-many mapping
 * onto Subject / Area / Sub-Area. This module:
 *
 *   1. removes the legacy columns, indexes and triggers that would otherwise
 *      survive `CREATE TABLE IF NOT EXISTS` and break inserts, and
 *   2. rebuilds each question's classification by matching its old topic and
 *      subtopic against the new taxonomy by name.
 *
 * Anything it cannot match confidently is reported rather than guessed at, so
 * an operator can see exactly what needs attention.
 */

import { resolvePath, getTaxonomyIndex } from '../core/taxonomy.js';

/** True when the database still has the pre-taxonomy `questions` shape. */
export function hasLegacyTaxonomyColumns(db) {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'questions'`)
    .get();
  if (!tableExists) return false;
  return db.prepare('PRAGMA table_info(questions)').all().some((c) => c.name === 'topic');
}

/**
 * Drops legacy columns, indexes and triggers so the current schema can apply
 * cleanly. Safe to call only when `hasLegacyTaxonomyColumns` is true.
 */
export function dropLegacyTaxonomySchema(db) {
  // Triggers first: they reference new.topic and would fail on any later write.
  for (const name of ['questions_facets_ai', 'questions_facets_ad', 'questions_facets_au']) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  // Then indexes, which pin the columns in place.
  for (const name of ['idx_questions_selection', 'idx_questions_topic_sub']) {
    db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  // Facet rows for the retired dimensions.
  db.prepare(`DELETE FROM facet_counts WHERE dimension IN ('topic', 'subtopic')`).run();

  const columns = db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
  for (const column of ['topic', 'subtopic']) {
    if (columns.includes(column)) db.exec(`ALTER TABLE questions DROP COLUMN ${column}`);
  }
}

/* ------------------------------------------------------------------ *
 * Name matching
 * ------------------------------------------------------------------ */

/** Normalises a label for comparison: case, punctuation and plurals. */
function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .join(' ');
}

const tokens = (value) => new Set(normalise(value).split(' ').filter(Boolean));

/**
 * Scores how well two labels match.
 * 1 is an exact match; below the caller's threshold counts as no match.
 */
function score(label, candidate) {
  const a = normalise(label);
  const b = normalise(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const ta = tokens(label);
  const tb = tokens(candidate);

  // Containment is checked on whole words, never on raw substrings: plain
  // `includes` would match "Graph" inside "Crypto-graph-y" and file every
  // graph question under Blockchain and Cryptography.
  const covers = (small, large) => small.size > 0 && [...small].every((t) => large.has(t));
  if (covers(ta, tb) || covers(tb, ta)) return 0.85;

  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  if (!shared) return 0;
  return (shared / Math.max(1, Math.min(ta.size, tb.size))) * 0.8;
}

/** Best-scoring entry of a list, or null when nothing clears the threshold. */
function best(label, candidates, nameOf, threshold) {
  let winner = null;
  let winnerScore = 0;
  for (const candidate of candidates) {
    const value = score(label, nameOf(candidate));
    if (value > winnerScore) {
      winnerScore = value;
      winner = candidate;
    }
  }
  return winner && winnerScore >= threshold ? { match: winner, score: winnerScore } : null;
}

/**
 * Resolves a legacy (topic, subtopic) pair to a taxonomy branch.
 *
 * Order matters. The old model had one flat "topic", which in practice held
 * sometimes a subject ("Operating Systems") and sometimes an area ("Arrays").
 * Trying the subject level first, then resolving the subtopic inside it,
 * recovers far more mappings than area matching alone — and avoids the trap of
 * matching "SQL & Databases" to "Big Data Analytics > NoSQL Databases" on the
 * strength of one shared word.
 *
 * @returns {{subject, area, subArea, score, via}|null}
 */
export function matchClassification(topic, subtopic = null, { threshold = 0.6 } = {}) {
  const index = getTaxonomyIndex();
  const areasOf = (subjectId) => index.areas.filter((a) => a.subject_id === subjectId);
  const subAreasOf = (areaId) => index.subAreas.filter((s) => s.area_id === areaId);

  // All strategies compete on confidence rather than the first one winning:
  // an exact area match ("Graph" -> "Graphs") must beat a merely plausible
  // subject match, whichever order they are tried in.
  const candidates = [];

  // 1. The legacy topic names a subject — resolve the area from the subtopic,
  //    falling back to the topic itself.
  const subjectHit = best(topic, index.subjects, (s) => s.name, threshold);
  if (subjectHit) {
    const subject = subjectHit.match;
    const areas = areasOf(subject.id);
    const areaHit =
      (subtopic && best(subtopic, areas, (a) => a.name, threshold)) ||
      best(topic, areas, (a) => a.name, threshold);
    if (areaHit) {
      candidates.push({
        subject,
        area: areaHit.match,
        via: 'subject+area',
        score: Math.min(subjectHit.score, areaHit.score),
      });
    }
  }

  // 2. The legacy topic names an area directly.
  const areaHit = best(topic, index.areas, (a) => a.name, threshold);
  if (areaHit) {
    candidates.push({
      subject: index.subjectById.get(areaHit.match.subject_id),
      area: areaHit.match,
      via: 'area',
      score: areaHit.score,
    });
  }

  // 3. The subtopic names an area and the topic was too vague. Held to a
  //    stricter bar and discounted, since this is the weakest evidence.
  if (subtopic) {
    const viaSub = best(subtopic, index.areas, (a) => a.name, 0.85);
    if (viaSub) {
      candidates.push({
        subject: index.subjectById.get(viaSub.match.subject_id),
        area: viaSub.match,
        via: 'subtopic',
        score: viaSub.score * 0.9,
      });
    }
  }

  if (!candidates.length) return null;

  const winner = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const subArea = subtopic ? best(subtopic, subAreasOf(winner.area.id), (s) => s.name, 0.5) : null;
  return { ...winner, subArea: subArea ? subArea.match : null };
}

/** Single-label helper, for callers that only have a topic. */
export function matchArea(topic, options = {}) {
  const result = matchClassification(topic, null, options);
  return result ? { area: result.area, subject: result.subject, score: result.score } : null;
}

/* ------------------------------------------------------------------ *
 * Backfill
 * ------------------------------------------------------------------ */

/**
 * Rebuilds `question_taxonomy` from a snapshot of the legacy classification.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{id:number,qid:string,topic:string,subtopic:string|null}>} legacy
 */
export function backfillLegacyTaxonomy(db, legacy, { quiet = false } = {}) {
  const insert = db.prepare(
    `INSERT INTO question_taxonomy (question_id, subject_id, area_id, sub_area_id, is_primary)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT DO NOTHING`,
  );

  // Legacy (topic, subtopic) pairs repeat heavily, so resolve each once.
  const cache = new Map();
  const unmatched = new Map();
  let mapped = 0;

  const run = db.transaction(() => {
    for (const row of legacy) {
      if (!row.topic) continue;

      const key = `${row.topic}\u0000${row.subtopic ?? ''}`;
      if (!cache.has(key)) cache.set(key, matchClassification(row.topic, row.subtopic));
      const match = cache.get(key);

      if (!match) {
        unmatched.set(row.topic, (unmatched.get(row.topic) || 0) + 1);
        continue;
      }

      insert.run(row.id, match.subject.id, match.area.id, match.subArea ? match.subArea.id : null);
      mapped += 1;
    }
  });

  run();

  const report = {
    total: legacy.length,
    mapped,
    unmatched: legacy.length - mapped,
    unmatchedTopics: [...unmatched.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count),
    matches: [...cache.entries()]
      .filter(([, match]) => match)
      .map(([key, match]) => ({
        topic: key.split('\u0000')[0],
        subtopic: key.split('\u0000')[1] || null,
        subject: match.subject.name,
        area: match.area.name,
        subArea: match.subArea ? match.subArea.name : null,
        via: match.via,
        confidence: Number(match.score.toFixed(2)),
      })),
  };

  if (!quiet && report.unmatchedTopics.length) {
    console.warn('These legacy topics had no confident match in the new taxonomy:');
    for (const row of report.unmatchedTopics) {
      console.warn(`  "${row.topic}" (${row.count} questions) — classify these manually or re-seed.`);
    }
  }

  return report;
}

export { resolvePath };
