/**
 * Taxonomy service.
 *
 * The classification hierarchy is
 *
 *     Subject  ->  Area (Topic)  ->  Sub-Area (Sub-Topic, optional)  ->  Tags
 *
 * and a QID maps to one or more branches of it. This module owns:
 *
 *   * loading the shipped taxonomy into the database (idempotent),
 *   * a small in-memory index so the filter engine can turn names into ids
 *     without a join on every query,
 *   * the cascading lookups the pickers use (areas of a subject, sub-areas of
 *     an area, tags suggested for a branch).
 *
 * The tree is tiny (35 subjects / 293 areas / 18 sub-areas in the supplied
 * workbook), so caching it whole costs nothing and removes the taxonomy from
 * the hot path of every filter compilation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TAXONOMY_FILE = path.join(here, '..', 'db', 'taxonomy', 'taxonomy.json');

let cache = null;

/** Drops the cached index; call after any write to the taxonomy tables. */
export function invalidateTaxonomyCache() {
  cache = null;
}

/** Reads the shipped taxonomy definition from disk. */
export function readTaxonomyFile(file = TAXONOMY_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Taxonomy definition not found at ${file}. ` +
      'Regenerate it with: node scripts/import-taxonomy.mjs <workbook.xlsx>',
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Loads the taxonomy into the database. Idempotent: re-running updates
 * positions and adds anything new without disturbing existing QID mappings.
 *
 * Returns a summary plus a list of nodes that exist in the database but are no
 * longer in the file — these are reported rather than deleted, because
 * questions may still be mapped to them.
 */
export function loadTaxonomy({ file = TAXONOMY_FILE, quiet = false } = {}) {
  const db = getDb();
  const definition = readTaxonomyFile(file);

  const upsertSubject = db.prepare(
    `INSERT INTO taxonomy_subjects (name, position) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET position = excluded.position
     RETURNING id`,
  );
  const upsertArea = db.prepare(
    `INSERT INTO taxonomy_areas (subject_id, name, position) VALUES (?, ?, ?)
       ON CONFLICT (subject_id, name) DO UPDATE SET position = excluded.position
     RETURNING id`,
  );
  const upsertSubArea = db.prepare(
    `INSERT INTO taxonomy_sub_areas (area_id, name, position) VALUES (?, ?, ?)
       ON CONFLICT (area_id, name) DO UPDATE SET position = excluded.position
     RETURNING id`,
  );
  const upsertTag = db.prepare(
    `INSERT INTO taxonomy_tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = excluded.name
     RETURNING id`,
  );
  const linkAreaTag = db.prepare(
    `INSERT INTO taxonomy_area_tags (area_id, tag_id, position) VALUES (?, ?, ?)
       ON CONFLICT (area_id, tag_id) DO UPDATE SET position = excluded.position`,
  );

  const counts = { subjects: 0, areas: 0, subAreas: 0, tags: 0, links: 0 };
  const seenAreas = new Set();

  const run = db.transaction(() => {
    for (const subject of definition.subjects) {
      const subjectId = upsertSubject.get(subject.name, subject.position ?? 0).id;
      counts.subjects += 1;

      for (const area of subject.areas) {
        const areaId = upsertArea.get(subjectId, area.name, area.position ?? 0).id;
        counts.areas += 1;
        seenAreas.add(areaId);

        for (const subArea of area.subAreas || []) {
          upsertSubArea.run(areaId, subArea.name, subArea.position ?? 0);
          counts.subAreas += 1;
        }

        (area.tags || []).forEach((tagName, index) => {
          const tagId = upsertTag.get(tagName).id;
          linkAreaTag.run(areaId, tagId, index + 1);
          counts.links += 1;
        });
      }
    }
    counts.tags = db.prepare('SELECT COUNT(*) AS n FROM taxonomy_tags').get().n;

    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('taxonomy_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(definition.version ?? 1));
  });

  run();
  invalidateTaxonomyCache();

  // Nodes still referenced by questions but absent from the new file.
  const orphans = db
    .prepare(
      `SELECT a.id, s.name AS subject, a.name AS area,
              (SELECT COUNT(*) FROM question_taxonomy qt WHERE qt.area_id = a.id) AS questions
         FROM taxonomy_areas a JOIN taxonomy_subjects s ON s.id = a.subject_id
        ORDER BY s.position, a.position`,
    )
    .all()
    .filter((row) => !seenAreas.has(row.id) && row.questions > 0);

  if (!quiet) {
    console.log(
      `Taxonomy loaded: ${counts.subjects} subjects, ${counts.areas} areas, ` +
      `${counts.subAreas} sub-areas, ${counts.tags} tags.`,
    );
    if (orphans.length) {
      console.warn(
        `${orphans.length} area(s) are no longer in the taxonomy file but still have questions mapped to them:`,
      );
      for (const row of orphans) console.warn(`  ${row.subject} > ${row.area} (${row.questions} questions)`);
    }
  }

  return { ...counts, orphans, stats: definition.stats };
}

/* ------------------------------------------------------------------ *
 * In-memory index
 * ------------------------------------------------------------------ */

/**
 * Builds (once) an index of the taxonomy for name<->id resolution.
 * Names are matched case-insensitively and whitespace-insensitively, so a
 * filter saved as "operating system" still resolves.
 */
export function getTaxonomyIndex() {
  if (cache) return cache;

  const db = getDb();
  const subjects = db.prepare('SELECT id, name, position FROM taxonomy_subjects ORDER BY position, name').all();
  const areas = db.prepare('SELECT id, subject_id, name, position FROM taxonomy_areas ORDER BY position, name').all();
  const subAreas = db.prepare('SELECT id, area_id, name, position FROM taxonomy_sub_areas ORDER BY position, name').all();

  const normalise = (value) => String(value ?? '').trim().toLowerCase();

  const subjectByName = new Map();
  const subjectById = new Map();
  for (const subject of subjects) {
    subjectByName.set(normalise(subject.name), subject);
    subjectById.set(subject.id, subject);
  }

  // Area names are only unique within a subject, so index both the bare name
  // (first match wins, which is what a bare filter value means) and the
  // qualified "Subject > Area" form.
  const areaByName = new Map();
  const areaById = new Map();
  for (const area of areas) {
    areaById.set(area.id, area);
    const key = normalise(area.name);
    if (!areaByName.has(key)) areaByName.set(key, []);
    areaByName.get(key).push(area);
    const subject = subjectById.get(area.subject_id);
    if (subject) areaByName.set(`${normalise(subject.name)} > ${key}`, [area]);
  }

  const subAreaByName = new Map();
  const subAreaById = new Map();
  for (const subArea of subAreas) {
    subAreaById.set(subArea.id, subArea);
    const key = normalise(subArea.name);
    if (!subAreaByName.has(key)) subAreaByName.set(key, []);
    subAreaByName.get(key).push(subArea);
    const area = areaById.get(subArea.area_id);
    if (area) subAreaByName.set(`${normalise(area.name)} > ${key}`, [subArea]);
  }

  cache = {
    subjects, areas, subAreas,
    subjectByName, subjectById,
    areaByName, areaById,
    subAreaByName, subAreaById,
    normalise,
  };
  return cache;
}

/**
 * Resolves filter values (names, or numeric ids) to node ids.
 * Unknown names resolve to nothing, which correctly yields a zero-match filter
 * rather than silently ignoring the constraint.
 */
export function resolveIds(level, values) {
  const index = getTaxonomyIndex();
  const out = new Set();

  for (const raw of values) {
    if (raw === null || raw === undefined || raw === '') continue;

    // Numeric values are treated as ids so the UI can pass either form.
    if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
      out.add(Number(raw));
      continue;
    }

    const key = index.normalise(raw);
    if (level === 'subject') {
      const subject = index.subjectByName.get(key);
      if (subject) out.add(subject.id);
    } else if (level === 'area') {
      for (const area of index.areaByName.get(key) || []) out.add(area.id);
    } else if (level === 'sub_area') {
      for (const subArea of index.subAreaByName.get(key) || []) out.add(subArea.id);
    }
  }

  return [...out];
}

/** Areas belonging to the given subjects (names or ids); all areas when empty. */
export function areasFor(subjects = []) {
  const index = getTaxonomyIndex();
  if (!subjects.length) return index.areas.map(decorateArea);
  const ids = new Set(resolveIds('subject', subjects));
  return index.areas.filter((a) => ids.has(a.subject_id)).map(decorateArea);
}

/** Sub-areas belonging to the given areas; all sub-areas when empty. */
export function subAreasFor(areas = []) {
  const index = getTaxonomyIndex();
  if (!areas.length) return index.subAreas.map(decorateSubArea);
  const ids = new Set(resolveIds('area', areas));
  return index.subAreas.filter((s) => ids.has(s.area_id)).map(decorateSubArea);
}

function decorateArea(area) {
  const index = getTaxonomyIndex();
  const subject = index.subjectById.get(area.subject_id);
  return { id: area.id, name: area.name, subject: subject?.name ?? null, subjectId: area.subject_id };
}

function decorateSubArea(subArea) {
  const index = getTaxonomyIndex();
  const area = index.areaById.get(subArea.area_id);
  const subject = area ? index.subjectById.get(area.subject_id) : null;
  return {
    id: subArea.id,
    name: subArea.name,
    area: area?.name ?? null,
    areaId: subArea.area_id,
    subject: subject?.name ?? null,
  };
}

/**
 * Tags suggested by the taxonomy for a branch. With no branch selected this is
 * the whole vocabulary, ordered by how many areas use each tag.
 */
export function tagsFor({ subjects = [], areas = [], search = '', limit = 200 } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];

  const areaIds = areas.length ? resolveIds('area', areas) : [];
  const subjectIds = subjects.length ? resolveIds('subject', subjects) : [];

  if (areaIds.length) {
    clauses.push(`at.area_id IN (${areaIds.map(() => '?').join(',')})`);
    params.push(...areaIds);
  } else if (subjectIds.length) {
    clauses.push(`a.subject_id IN (${subjectIds.map(() => '?').join(',')})`);
    params.push(...subjectIds);
  }

  if (search) {
    clauses.push(`t.name LIKE ? ESCAPE '\\'`);
    params.push(`%${String(search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT t.name AS value, COUNT(DISTINCT at.area_id) AS areas
         FROM taxonomy_area_tags at
         JOIN taxonomy_tags t ON t.id = at.tag_id
         JOIN taxonomy_areas a ON a.id = at.area_id
         ${where}
        GROUP BY t.id
        ORDER BY areas DESC, t.name
        LIMIT ?`,
    )
    .all(...params, Math.min(Number(limit) || 200, 500));
}

/** The full tree, used by the taxonomy browser and the filter builder. */
export function getTaxonomyTree({ withCounts = false } = {}) {
  const db = getDb();
  const index = getTaxonomyIndex();

  const counts = withCounts
    ? new Map(
        db
          .prepare(
            `SELECT area_id, COUNT(DISTINCT question_id) AS n FROM question_taxonomy GROUP BY area_id`,
          )
          .all()
          .map((r) => [r.area_id, r.n]),
      )
    : new Map();

  const subAreasByArea = new Map();
  for (const subArea of index.subAreas) {
    if (!subAreasByArea.has(subArea.area_id)) subAreasByArea.set(subArea.area_id, []);
    subAreasByArea.get(subArea.area_id).push({ id: subArea.id, name: subArea.name });
  }

  const areasBySubject = new Map();
  for (const area of index.areas) {
    if (!areasBySubject.has(area.subject_id)) areasBySubject.set(area.subject_id, []);
    areasBySubject.get(area.subject_id).push({
      id: area.id,
      name: area.name,
      subAreas: subAreasByArea.get(area.id) || [],
      ...(withCounts ? { questionCount: counts.get(area.id) || 0 } : {}),
    });
  }

  return index.subjects.map((subject) => {
    const areas = areasBySubject.get(subject.id) || [];
    return {
      id: subject.id,
      name: subject.name,
      areas,
      ...(withCounts ? { questionCount: areas.reduce((a, x) => a + (x.questionCount || 0), 0) } : {}),
    };
  });
}

/** Resolves a "Subject > Area > Sub-Area" path to ids, for mapping a QID. */
export function resolvePath({ subject, area, subArea = null }) {
  const index = getTaxonomyIndex();
  const subjectRow = index.subjectByName.get(index.normalise(subject));
  if (!subjectRow) return null;

  const areaRow = (index.areaByName.get(index.normalise(area)) || [])
    .find((a) => a.subject_id === subjectRow.id);
  if (!areaRow) return null;

  let subAreaRow = null;
  if (subArea) {
    subAreaRow = (index.subAreaByName.get(index.normalise(subArea)) || [])
      .find((s) => s.area_id === areaRow.id);
    if (!subAreaRow) return null;
  }

  return {
    subjectId: subjectRow.id,
    areaId: areaRow.id,
    subAreaId: subAreaRow ? subAreaRow.id : null,
    subject: subjectRow.name,
    area: areaRow.name,
    subArea: subAreaRow ? subAreaRow.name : null,
  };
}
