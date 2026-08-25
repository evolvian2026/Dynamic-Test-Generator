/**
 * Taxonomy: the Subject / Area / Sub-Area hierarchy, many-to-many QID mapping,
 * cascading lookups and the upgrade path from the pre-taxonomy schema.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';

const { getDb } = await import('../server/db/index.js');
const {
  readTaxonomyFile, getTaxonomyIndex, getTaxonomyTree, resolveIds,
  areasFor, subAreasFor, tagsFor, resolvePath,
} = await import('../server/core/taxonomy.js');
const { countMatching, getAreas, getSubAreas, bankStatistics, getQuestionsByQids } = await import('../server/core/questions.js');
const { compileFilter, explainMatch } = await import('../server/core/filterEngine.js');
const { matchClassification } = await import('../server/db/backfill.js');
const { splitList, buildTaxonomy } = await import('../scripts/import-taxonomy.mjs');

/* ------------------------- workbook parsing ------------------------- */

test('list splitting respects commas inside brackets', () => {
  // A naive split shreds 265 tags in the supplied workbook.
  assert.deepEqual(
    splitList('Paging, Page Replacement (FIFO, LRU, Optimal, LFU), Thrashing'),
    ['Paging', 'Page Replacement (FIFO, LRU, Optimal, LFU)', 'Thrashing'],
  );
  assert.deepEqual(splitList('A, B , ,C'), ['A', 'B', 'C']);
  assert.deepEqual(splitList(null), []);
  assert.deepEqual(splitList('Nested (a, (b, c)), d'), ['Nested (a, (b, c))', 'd']);
});

test('buildTaxonomy nests areas and sub-areas under their subject', () => {
  const taxonomy = buildTaxonomy([
    { Subject: 'OS', Area: 'Memory', 'Sub Areas': 'Paging, Segmentation', Tags: 'TLB, Page Table (L1, L2)' },
    { Subject: 'OS', Area: 'Deadlocks', 'Sub Areas': null, Tags: 'Bankers Algorithm' },
    { Subject: 'DBMS', Area: 'Normalization', 'Sub Areas': null, Tags: '1NF, 2NF' },
  ]);

  assert.equal(taxonomy.stats.subjects, 2);
  assert.equal(taxonomy.stats.areas, 3);
  assert.equal(taxonomy.stats.subAreas, 2);
  // Leaf categories: the area itself when it has no sub-areas, else each sub-area.
  assert.equal(taxonomy.stats.leafCategories, 4);
  assert.deepEqual(taxonomy.subjects[0].areas[0].subAreas.map((s) => s.name), ['Paging', 'Segmentation']);
  assert.deepEqual(taxonomy.subjects[0].areas[0].tags, ['TLB', 'Page Table (L1, L2)']);
});

test('the shipped taxonomy matches the workbook it was generated from', () => {
  const definition = readTaxonomyFile();
  // These are the totals the workbook's own Summary sheet reports.
  assert.equal(definition.stats.subjects, 35);
  assert.equal(definition.stats.areas, 293);
  assert.equal(definition.stats.areasWithSubAreas, 9);
  assert.equal(definition.stats.subAreas, 18);
  assert.equal(definition.stats.leafCategories, 302);

  const rebuilt = definition.subjects.reduce((acc, s) => acc + s.areas.length, 0);
  assert.equal(rebuilt, definition.stats.areas, 'the tree and the stats must agree');
});

/* --------------------------- loading -------------------------------- */

test('the taxonomy is loaded into the database by migration', () => {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM taxonomy_subjects) AS subjects,
              (SELECT COUNT(*) FROM taxonomy_areas) AS areas,
              (SELECT COUNT(*) FROM taxonomy_sub_areas) AS subAreas,
              (SELECT COUNT(*) FROM taxonomy_area_tags) AS links`,
    )
    .get();

  assert.equal(counts.subjects, 35);
  assert.equal(counts.areas, 293);
  assert.equal(counts.subAreas, 18);
  assert.ok(counts.links > 2000, 'the tag vocabulary should be linked to areas');
});

test('loading the taxonomy again is idempotent', async () => {
  const { loadTaxonomy } = await import('../server/core/taxonomy.js');
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM taxonomy_areas').get().n;
  loadTaxonomy({ quiet: true });
  const after = getDb().prepare('SELECT COUNT(*) AS n FROM taxonomy_areas').get().n;
  assert.equal(after, before, 're-loading must not duplicate the tree');
});

/* --------------------------- structure ------------------------------ */

test('every question is mapped to at least one branch', () => {
  const db = getDb();
  const orphans = db
    .prepare('SELECT COUNT(*) AS n FROM questions q WHERE NOT EXISTS (SELECT 1 FROM question_taxonomy qt WHERE qt.question_id = q.id)')
    .get().n;
  assert.equal(orphans, 0);
});

test('a QID can be mapped to more than one branch', () => {
  const db = getDb();
  const multi = db
    .prepare('SELECT COUNT(*) AS n FROM (SELECT question_id FROM question_taxonomy GROUP BY question_id HAVING COUNT(*) > 1)')
    .get().n;
  assert.ok(multi > 0, 'the seeded bank should exercise multi-mapping');

  const [example] = db
    .prepare('SELECT question_id FROM question_taxonomy GROUP BY question_id HAVING COUNT(*) > 1 LIMIT 1')
    .all();
  const qid = db.prepare('SELECT qid FROM questions WHERE id = ?').get(example.question_id).qid;
  const [question] = getQuestionsByQids([qid]);

  assert.ok(question.taxonomy.length > 1);
  assert.ok(question.subjects.length >= 1);
  assert.equal(question.taxonomy.filter((b) => b.isPrimary).length, 1, 'exactly one branch is primary');
});

test('the same question cannot be mapped to one branch twice', () => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM question_taxonomy LIMIT 1').get();
  assert.throws(
    () => db
      .prepare('INSERT INTO question_taxonomy (question_id, subject_id, area_id, sub_area_id) VALUES (?, ?, ?, ?)')
      .run(row.question_id, row.subject_id, row.area_id, row.sub_area_id),
    /UNIQUE constraint failed/,
  );
});

/* ---------------------------- filtering ----------------------------- */

test('each taxonomy level filters and narrows correctly', () => {
  const subject = countMatching({ subject: ['Operating System'] });
  const area = countMatching({ subject: ['Operating System'], area: ['Memory Management'] });
  const subArea = countMatching({
    subject: ['Operating System'],
    area: ['Memory Management'],
    sub_area: ['Virtual Memory and Paging'],
  });

  assert.ok(subject > 0);
  assert.ok(area > 0 && area <= subject);
  assert.ok(subArea > 0 && subArea <= area);
});

test('taxonomy names resolve case-insensitively', () => {
  assert.equal(
    countMatching({ subject: ['operating system'] }),
    countMatching({ subject: ['Operating System'] }),
  );
  assert.deepEqual(resolveIds('subject', ['OPERATING SYSTEM']), resolveIds('subject', ['Operating System']));
});

test('an unknown taxonomy name matches nothing rather than being ignored', () => {
  assert.equal(countMatching({ subject: ['No Such Subject'] }), 0);
  assert.equal(countMatching({ area: ['No Such Area'] }), 0);
  // Crucially it must not silently widen to the unfiltered count.
  assert.notEqual(countMatching({ subject: ['No Such Subject'] }), countMatching({}));
});

test('subject and area must be satisfied by the SAME branch', () => {
  // 19 area names are shared between subjects in this taxonomy — for example
  // "Process Management" exists under both Operating System and Linux.
  const index = getTaxonomyIndex();
  const shared = index.areas.filter((a) => a.name === 'Process Management');
  assert.equal(shared.length, 2, 'this test relies on a genuinely ambiguous area name');

  const os = countMatching({ subject: ['Operating System'], area: ['Process Management'] });
  const linux = countMatching({ subject: ['Linux'], area: ['Process Management'] });
  const either = countMatching({ area: ['Process Management'] });

  assert.ok(os > 0 && linux > 0);
  // Every match of the unscoped filter belongs to one subject or the other,
  // and a question mapped to both is counted once by the union.
  assert.ok(os + linux >= either);

  // The decisive case: a question whose branches are A>X and B>Y must not
  // match "subject = A AND area = Y".
  const db = getDb();
  // Two genuine branches of one active question: the pairs must come from the
  // same rows, so this self-joins rather than aggregating each column apart.
  const row = db
    .prepare(
      `SELECT q.qid,
              s1.name AS s1, a1.name AS a1,
              s2.name AS s2, a2.name AS a2
         FROM question_taxonomy x
         JOIN question_taxonomy y ON y.question_id = x.question_id AND y.id <> x.id
         JOIN questions q ON q.id = x.question_id
         JOIN taxonomy_subjects s1 ON s1.id = x.subject_id
         JOIN taxonomy_areas a1 ON a1.id = x.area_id
         JOIN taxonomy_subjects s2 ON s2.id = y.subject_id
         JOIN taxonomy_areas a2 ON a2.id = y.area_id
        WHERE q.status = 'active' AND s1.id <> s2.id AND a1.id <> a2.id
        LIMIT 1`,
    )
    .get();
  assert.ok(row, 'the bank should contain a question spanning two subjects');

  assert.equal(countMatching({ qid: [row.qid], subject: [row.s1], area: [row.a1] }), 1, 'same-branch must match');
  assert.equal(countMatching({ qid: [row.qid], subject: [row.s1], area: [row.a2] }), 0, 'cross-branch must not match');
});

test('taxonomy levels compile to a single indexed subquery', () => {
  const { where } = compileFilter({ subject: ['Operating System'], area: ['Memory Management'] });
  const probes = where.match(/SELECT qt\.question_id FROM question_taxonomy/g) || [];
  assert.equal(probes.length, 1, 'levels must share one mapping-row lookup');
  assert.ok(where.includes('qt.subject_id IN') && where.includes('qt.area_id IN'));
  // Driving from the mapping table, not a correlated per-row probe.
  assert.ok(!where.includes('qt.question_id = q.id'));
});

test('tag filters combine with taxonomy filters', () => {
  const base = countMatching({ subject: ['Operating System'] });
  const tagged = countMatching({ subject: ['Operating System'], includeTags: ['advanced'] });
  const excluded = countMatching({ subject: ['Operating System'], excludeTags: ['advanced'] });
  assert.equal(tagged + excluded, base, 'include and exclude must partition the set');
});

/* ---------------------------- cascades ------------------------------ */

test('areas cascade from subjects and sub-areas from areas', () => {
  const osAreas = getAreas(['Operating System']);
  assert.equal(osAreas.length, 8);
  assert.ok(osAreas.every((a) => a.subject === 'Operating System'));
  assert.ok(osAreas.some((a) => a.value === 'Memory Management'));
  assert.ok(!osAreas.some((a) => a.value === 'Normalization'), 'DBMS areas must not leak in');

  const subAreas = getSubAreas(['Memory Management']);
  assert.deepEqual(
    subAreas.map((s) => s.value).sort(),
    ['Address Spaces and Allocation', 'Virtual Memory and Paging'],
  );

  // Most areas have no sub-areas; the area itself is then the finest level.
  assert.equal(getSubAreas(['Deadlocks']).length, 0);
});

test('unscoped cascades return the whole level', () => {
  assert.equal(areasFor([]).length, 293);
  assert.equal(subAreasFor([]).length, 18);
});

test('tag suggestions are scoped to the selected branch', () => {
  const scoped = tagsFor({ areas: ['Memory Management'] }).map((t) => t.value);
  assert.ok(scoped.includes('Page Replacement (FIFO, LRU, Optimal, LFU)'));
  assert.ok(scoped.includes('Demand Paging'));
  assert.ok(!scoped.includes('Bankers Algorithm'), 'tags from a sibling area must not appear');

  const everything = tagsFor({ limit: 500 });
  assert.ok(everything.length > scoped.length);

  const searched = tagsFor({ search: 'Paging' }).map((t) => t.value);
  assert.ok(searched.every((t) => t.toLowerCase().includes('paging')));
});

test('the taxonomy tree carries question counts', () => {
  const tree = getTaxonomyTree({ withCounts: true });
  assert.equal(tree.length, 35);
  assert.equal(tree.reduce((a, s) => a + s.areas.length, 0), 293);

  const os = tree.find((s) => s.name === 'Operating System');
  assert.equal(os.areas.length, 8);
  assert.equal(os.questionCount, os.areas.reduce((a, x) => a + x.questionCount, 0));

  const memory = os.areas.find((a) => a.name === 'Memory Management');
  assert.equal(memory.subAreas.length, 2);
});

test('resolvePath maps a full path to ids and rejects a broken one', () => {
  const ok = resolvePath({ subject: 'Operating System', area: 'Memory Management', subArea: 'Virtual Memory and Paging' });
  assert.ok(ok && ok.subjectId && ok.areaId && ok.subAreaId);

  // "Normalization" is a DBMS area, not an Operating System one.
  assert.equal(resolvePath({ subject: 'Operating System', area: 'Normalization' }), null);
  assert.equal(resolvePath({ subject: 'Nope', area: 'Memory Management' }), null);
});

/* -------------------------- statistics ------------------------------ */

test('bank statistics report every taxonomy level', () => {
  const stats = bankStatistics();
  assert.equal(stats.totalSubjects, 35);
  assert.ok(stats.totalAreas > 200);
  assert.equal(stats.mappedQuestions, stats.total, 'every question is classified');
  assert.ok(stats.bySubject.length > 0);
  assert.ok(stats.byArea.every((a) => a.parent), 'area facets carry their subject');
});

/* ------------------------ explainability ---------------------------- */

test('explain reports each taxonomy level against the question', () => {
  const [question] = getQuestionsByQids(
    getDb().prepare(
      `SELECT q.qid FROM questions q
         JOIN question_taxonomy qt ON qt.question_id = q.id
         JOIN taxonomy_subjects s ON s.id = qt.subject_id
        WHERE s.name = 'Operating System' LIMIT 1`,
    ).all().map((r) => r.qid),
  );

  const { matched, criteria } = explainMatch({ subject: ['Operating System'] }, question);
  assert.equal(matched, true);
  assert.ok(criteria.some((c) => c.field === 'subject' && c.passed));
  assert.ok(criteria[0].actual.includes('Operating System'));

  const failed = explainMatch({ subject: ['Flutter'] }, question);
  assert.equal(failed.matched, false);
});

/* --------------------- legacy classification ------------------------ */

test('legacy topics are matched to the new taxonomy', () => {
  const cases = [
    ['Arrays', 'Traversal', 'Data Structures and Algorithms', 'Arrays and Matrices'],
    ['Graph', 'Shortest Path', 'Data Structures and Algorithms', 'Graphs'],
    ['Linked List', 'Reversal', 'Data Structures and Algorithms', 'Linked Lists'],
    ['Operating Systems', 'Deadlocks', 'Operating System', 'Deadlocks'],
    ['Operating Systems', 'Memory Management', 'Operating System', 'Memory Management'],
    ['SQL & Databases', 'Joins', 'SQL', 'Joins and Set Operations'],
  ];

  for (const [topic, subtopic, expectedSubject, expectedArea] of cases) {
    const match = matchClassification(topic, subtopic);
    assert.ok(match, `"${topic}" should map somewhere`);
    assert.equal(match.subject.name, expectedSubject, `${topic} -> subject`);
    assert.equal(match.area.name, expectedArea, `${topic} -> area`);
  }
});

test('legacy matching does not match across word boundaries', () => {
  // "Crypto-graph-y" contains "graph" as a substring; matching on raw
  // substrings filed every graph question under Blockchain and Cryptography.
  const match = matchClassification('Graph', 'Shortest Path');
  assert.notEqual(match.subject.name, 'Blockchain and Cryptography');
  assert.equal(match.area.name, 'Graphs');
});

test('a legacy topic with no counterpart is left unmapped, not guessed', () => {
  assert.equal(matchClassification('Quantum Basketry', 'Nonsense'), null);
  assert.equal(matchClassification('', null), null);
});

test('legacy sub-topics resolve to sub-areas where one exists', () => {
  const match = matchClassification('Trees', 'Binary Search Tree');
  assert.equal(match.area.name, 'Trees');
  assert.equal(match.subArea?.name, 'Binary Trees and BST');

  // An area without sub-areas simply yields none.
  assert.equal(matchClassification('Deadlocks', 'Bankers Algorithm')?.subArea, null);
});
