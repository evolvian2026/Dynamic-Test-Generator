/**
 * Deterministic question-bank seeder.
 *
 *   npm run seed                 # 5,000 questions
 *   npm run seed -- --count 250000 --seed DSA2026
 *   npm run seed -- --fresh      # wipe the bank first
 *
 * Questions are classified against the real taxonomy shipped in
 * `server/db/taxonomy/taxonomy.json` — Subject > Area > Sub-Area, with tags
 * drawn from the vocabulary that taxonomy defines for the chosen area. A share
 * of questions is deliberately mapped to more than one branch, because the
 * taxonomy allows a QID to belong to several, and the filter engine has to
 * handle that honestly.
 */

import bcrypt from 'bcryptjs';
import { getDb, closeDb } from './index.js';
import { migrate } from './migrate.js';
import { createRng } from '../core/rng.js';
import { getTaxonomyIndex, invalidateTaxonomyCache } from '../core/taxonomy.js';
import { fingerprint } from '../core/similarity.js';

// Difficulty-band tags are added alongside the taxonomy's own vocabulary so
// tag-based filtering has something coarse to bite on as well.
const BAND_TAGS = { Easy: 'beginner', Medium: 'intermediate', Hard: 'advanced' };
const EXTRA_TAGS = ['interview-favourite', 'placement', 'faang', 'time-complexity', 'space-complexity'];

const COMPANIES = ['Amazon', 'Google', 'Microsoft', 'Adobe', 'Flipkart', 'Infosys', 'TCS', 'Goldman Sachs', 'Uber'];
const LANGUAGES = ['Python', 'Java', 'C++', 'JavaScript', 'SQL', 'Language Agnostic'];
const BLOOM = ['Remember', 'Understand', 'Apply', 'Analyse', 'Evaluate', 'Create'];
const COGNITIVE = ['Recall', 'Comprehension', 'Application', 'Analysis'];
const SOURCES = ['Internal Bank', 'Campus Drive 2024', 'Mock Series', 'Textbook', 'Contest Archive'];
const AUTHORS = ['R. Iyer', 'S. Kapoor', 'M. Fernandes', 'A. Banerjee', 'P. Nair', 'K. Sharma'];
const COURSES = ['Data Structures', 'Algorithms', 'Database Systems', 'Systems Programming', 'Placement Prep'];
const STATUS_WEIGHTS = [['active', 0.9], ['review', 0.05], ['draft', 0.03], ['retired', 0.02]];

const TYPE_WEIGHTS = [
  ['MCQ', 0.42], ['Multiple Select', 0.13], ['Coding', 0.14], ['Fill in the Blank', 0.07],
  ['True/False', 0.07], ['Subjective', 0.05], ['SQL', 0.05], ['Output-based', 0.04], ['Debugging', 0.03],
];

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function weightedPick(rng, weighted) {
  const roll = rng();
  let acc = 0;
  for (const [value, weight] of weighted) {
    acc += weight;
    if (roll <= acc) return value;
  }
  return weighted[weighted.length - 1][0];
}

function buildQuestionText(rng, type, area, focus, difficulty, index) {
  const complexity = pick(rng, ['O(n)', 'O(n log n)', 'O(log n)', 'O(n²)', 'O(1)']);
  switch (type) {
    case 'MCQ':
      return `Which of the following statements about ${focus.toLowerCase()} in ${area} is correct when the input size is large? (Reference set ${index})`;
    case 'Multiple Select':
      return `Select all approaches that correctly solve the ${focus.toLowerCase()} problem on ${area} within ${complexity} time. (Reference set ${index})`;
    case 'Coding':
      return `Write a function that solves the following ${difficulty.toLowerCase()} ${area} problem using ${focus.toLowerCase()}. Your solution should run in ${complexity} time and handle empty input. (Problem ${index})`;
    case 'Fill in the Blank':
      return `In ${area}, the ${focus.toLowerCase()} technique achieves a worst-case time complexity of ________ for the standard implementation. (Item ${index})`;
    case 'True/False':
      return `True or False: every ${focus.toLowerCase()} problem in ${area} can be solved in ${complexity} time without additional space. (Item ${index})`;
    case 'Subjective':
      return `Explain, with an example, how ${focus.toLowerCase()} is applied to ${area} problems and discuss the trade-offs against the brute-force approach. (Item ${index})`;
    case 'SQL':
      return `Given the tables employees(id, name, dept_id, salary) and departments(id, name), write a query that demonstrates ${focus.toLowerCase()}. (Query ${index})`;
    case 'Output-based':
      return `What is the output of the following program that applies ${focus.toLowerCase()} to a ${area} structure? (Snippet ${index})`;
    case 'Debugging':
      return `The following ${area} implementation of ${focus.toLowerCase()} fails on certain inputs. Identify the defect and describe the fix. (Snippet ${index})`;
    default:
      return `Question about ${focus} in ${area}. (Item ${index})`;
  }
}

function buildOptions(rng, type, area, focus) {
  if (type === 'True/False') {
    const correct = rng() > 0.5;
    return [
      { option_text: 'True', is_correct: correct ? 1 : 0 },
      { option_text: 'False', is_correct: correct ? 0 : 1 },
    ];
  }
  if (type !== 'MCQ' && type !== 'Multiple Select') return [];

  const stems = [
    `It always runs in linear time for ${focus.toLowerCase()}`,
    `It requires the input to be sorted first`,
    `It uses O(1) auxiliary space`,
    `It degrades to quadratic time in the worst case`,
    `It is the standard approach for ${area}`,
    `It cannot handle duplicate values`,
  ];
  const chosen = [...stems].sort(() => rng() - 0.5).slice(0, 4);
  const correctCount = type === 'Multiple Select' ? 2 + Math.floor(rng() * 2) : 1;
  const correctIdx = new Set();
  while (correctIdx.size < correctCount) correctIdx.add(Math.floor(rng() * chosen.length));

  return chosen.map((text, i) => ({ option_text: text, is_correct: correctIdx.has(i) ? 1 : 0 }));
}

function marksFor(rng, type, difficulty) {
  const base = { MCQ: 1, 'Multiple Select': 2, 'True/False': 1, 'Fill in the Blank': 1,
    'Output-based': 2, SQL: 3, Debugging: 3, Subjective: 5, Coding: 10 }[type] ?? 1;
  const bump = { Easy: 0, Medium: 0, Hard: 1 }[difficulty] ?? 0;
  return base + bump;
}

function secondsFor(type, difficulty) {
  const base = { MCQ: 60, 'Multiple Select': 90, 'True/False': 40, 'Fill in the Blank': 60,
    'Output-based': 120, SQL: 240, Debugging: 300, Subjective: 420, Coding: 900 }[type] ?? 60;
  const factor = { Easy: 0.8, Medium: 1, Hard: 1.35 }[difficulty] ?? 1;
  return Math.round(base * factor);
}

export function seed({ count = 5000, seed: seedValue = 'DTG-SEED-V1', fresh = false, quiet = false } = {}) {
  migrate({ quiet: true });
  const db = getDb();

  if (fresh) {
    db.exec('DELETE FROM test_questions; DELETE FROM test_sections; DELETE FROM tests; DELETE FROM question_taxonomy; DELETE FROM questions; DELETE FROM facet_counts;');
    if (!quiet) console.log('Cleared existing question bank and generated tests.');
  }

  seedUsers(db, quiet);

  const existing = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  if (existing >= count) {
    if (!quiet) console.log(`Question bank already holds ${existing} questions (target ${count}); nothing to add.`);
    seedTemplates(db, quiet);
    return { inserted: 0, total: existing };
  }

  const startIndex = db.prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(qid, 4) AS INTEGER)), 1000) AS m FROM questions WHERE qid LIKE 'QID%'`).get().m;
  const toInsert = count - existing;
  const rng = createRng(seedValue);

  // Flatten the taxonomy into the leaf categories a QID can be mapped to:
  // the area itself when it has no sub-areas, otherwise each sub-area.
  const leaves = buildLeafCategories(db);
  if (!leaves.length) {
    throw new Error('The taxonomy is empty — run `npm run migrate` before seeding.');
  }

  const insertQuestion = db.prepare(
    `INSERT INTO questions (qid, question_type, question_text, difficulty, marks,
                            expected_seconds, status, answer_text, explanation, metadata, text_fingerprint)
     VALUES (@qid, @question_type, @question_text, @difficulty, @marks,
             @expected_seconds, @status, @answer_text, @explanation, @metadata, @text_fingerprint)`,
  );
  const insertOption = db.prepare(
    'INSERT INTO question_options (question_id, position, option_text, is_correct) VALUES (?, ?, ?, ?)',
  );
  const insertTag = db.prepare('INSERT OR IGNORE INTO question_tags (question_id, tag) VALUES (?, ?)');
  const insertAttr = db.prepare(
    'INSERT OR IGNORE INTO question_attributes (question_id, attr_key, attr_value, num_value) VALUES (?, ?, ?, ?)',
  );
  const insertMapping = db.prepare(
    `INSERT INTO question_taxonomy (question_id, subject_id, area_id, sub_area_id, is_primary)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  const insertBatch = db.transaction((from, to) => {
    for (let i = from; i < to; i += 1) {
      const n = startIndex + i + 1;
      const qid = `QID${n}`;

      const primary = pick(rng, leaves);
      const type = weightedPick(rng, TYPE_WEIGHTS);
      const difficulty = weightedPick(rng, [['Easy', 0.3], ['Medium', 0.45], ['Hard', 0.25]]);
      const status = weightedPick(rng, STATUS_WEIGHTS);

      // The narrowest label describing the question, used in the generated text.
      const focus = primary.subAreaName || primary.areaName;

      const text = buildQuestionText(rng, type, primary.areaName, focus, difficulty, n);
      const info = insertQuestion.run({
        qid,
        question_type: type,
        question_text: text,
        difficulty,
        marks: marksFor(rng, type, difficulty),
        expected_seconds: secondsFor(type, difficulty),
        status,
        answer_text:
          type === 'Coding' || type === 'Subjective' || type === 'SQL' || type === 'Debugging'
            ? `Model answer for ${qid}: apply ${focus.toLowerCase()} and justify the complexity.`
            : null,
        explanation: `The ${focus.toLowerCase()} approach is preferred here because it avoids re-scanning the input.`,
        metadata: JSON.stringify({ generated: true, seedBatch: seedValue }),
        text_fingerprint: fingerprint(text),
      });
      const questionId = info.lastInsertRowid;

      // Primary mapping, plus a secondary branch for roughly one question in
      // six — a QID may legitimately belong to more than one part of the tree.
      insertMapping.run(questionId, primary.subjectId, primary.areaId, primary.subAreaId, 1);
      if (rng() < 0.17) {
        const secondary = pick(rng, leaves);
        if (secondary.areaId !== primary.areaId) {
          insertMapping.run(questionId, secondary.subjectId, secondary.areaId, secondary.subAreaId, 0);
        }
      }

      for (const [position, option] of buildOptions(rng, type, primary.areaName, focus).entries()) {
        insertOption.run(questionId, position + 1, option.option_text, option.is_correct);
      }

      // Tags come from the vocabulary the taxonomy defines for this area, so
      // tag filtering exercises real values rather than invented ones.
      const tags = new Set([BAND_TAGS[difficulty]]);
      const vocabulary = primary.tags;
      const wanted = 1 + Math.floor(rng() * 3);
      for (let t = 0; t < wanted && vocabulary.length; t += 1) tags.add(pick(rng, vocabulary));
      if (rng() < 0.35) tags.add(pick(rng, EXTRA_TAGS));
      for (const tag of tags) insertTag.run(questionId, tag);

      const attrs = [
        ['company', pick(rng, COMPANIES), null],
        ['language', pick(rng, LANGUAGES), null],
        ['bloom_taxonomy', pick(rng, BLOOM), null],
        ['cognitive_level', pick(rng, COGNITIVE), null],
        ['source', pick(rng, SOURCES), null],
        ['author', pick(rng, AUTHORS), null],
        ['course', primary.subjectName, null],
        ['year', String(2019 + Math.floor(rng() * 7)), 2019 + Math.floor(rng() * 7)],
        ['usage_count', String(Math.floor(rng() * 40)), Math.floor(rng() * 40)],
        ['success_rate', String(Math.round(rng() * 100)), Math.round(rng() * 100)],
        ['quality_score', String(Math.round((3 + rng() * 2) * 10) / 10), Math.round((3 + rng() * 2) * 10) / 10],
        ['avg_time_taken', String(Math.round(secondsFor(type, difficulty) * (0.6 + rng() * 0.8))), Math.round(secondsFor(type, difficulty) * (0.6 + rng() * 0.8))],
      ];
      for (const [key, value, num] of attrs) insertAttr.run(questionId, key, value, num);
    }
  });

  const BATCH = 2000;
  for (let from = 0; from < toInsert; from += BATCH) {
    insertBatch(from, Math.min(from + BATCH, toInsert));
    if (!quiet && toInsert > BATCH) {
      process.stdout.write(`\r  seeded ${Math.min(from + BATCH, toInsert)}/${toInsert} questions`);
    }
  }
  if (!quiet && toInsert > BATCH) process.stdout.write('\n');

  db.exec('ANALYZE');
  seedTemplates(db, quiet);

  const total = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  if (!quiet) console.log(`Question bank ready: ${total} questions (${toInsert} added).`);
  return { inserted: toInsert, total };
}

/**
 * Flattens the loaded taxonomy into the leaf categories a QID can be mapped to,
 * carrying each leaf's tag vocabulary along with it.
 */
function buildLeafCategories(db) {
  invalidateTaxonomyCache();
  const index = getTaxonomyIndex();

  const tagsByArea = new Map();
  for (const row of db
    .prepare(
      `SELECT at.area_id, t.name FROM taxonomy_area_tags at
         JOIN taxonomy_tags t ON t.id = at.tag_id
        ORDER BY at.area_id, at.position`,
    )
    .all()) {
    if (!tagsByArea.has(row.area_id)) tagsByArea.set(row.area_id, []);
    tagsByArea.get(row.area_id).push(row.name);
  }

  const subAreasByArea = new Map();
  for (const subArea of index.subAreas) {
    if (!subAreasByArea.has(subArea.area_id)) subAreasByArea.set(subArea.area_id, []);
    subAreasByArea.get(subArea.area_id).push(subArea);
  }

  const leaves = [];
  for (const area of index.areas) {
    const subject = index.subjectById.get(area.subject_id);
    const tags = tagsByArea.get(area.id) || [];
    const base = {
      subjectId: area.subject_id,
      subjectName: subject?.name ?? 'Unknown',
      areaId: area.id,
      areaName: area.name,
      tags,
    };
    const subAreas = subAreasByArea.get(area.id) || [];
    if (subAreas.length === 0) {
      leaves.push({ ...base, subAreaId: null, subAreaName: null });
    } else {
      for (const subArea of subAreas) {
        leaves.push({ ...base, subAreaId: subArea.id, subAreaName: subArea.name });
      }
    }
  }
  return leaves;
}

function seedUsers(db, quiet) {
  const demo = [
    ['creator@example.com', 'Priya Menon', 'creator', 'Creator@12345'],
    ['viewer@example.com', 'Rahul Verma', 'viewer', 'Viewer@12345'],
  ];
  const insert = db.prepare(
    `INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (email) DO NOTHING`,
  );
  let added = 0;
  for (const [email, name, role, password] of demo) {
    added += insert.run(email, name, bcrypt.hashSync(password, 10), role).changes;
  }
  if (added && !quiet) console.log(`Created ${added} demo user(s). Passwords are in docs/README.`);
}

function seedTemplates(db, quiet) {
  // Templates reference real taxonomy values so they generate straight away.
  const templates = [
    {
      template_name: 'DSA Placement Test',
      description: '50-question placement blueprint across the core DSA areas.',
      configuration: {
        test: { test_name: 'DSA Placement Test', duration_minutes: 90, course: 'Placement Prep', randomize_questions: 1, prevent_duplicates: 1 },
        sections: [
          {
            section_name: 'Concepts', question_count: 35, marks_per_question: 1, negative_marks: 0.25,
            rule: {
              question_type: ['MCQ'],
              subject: ['Data Structures and Algorithms'],
              area: ['Arrays and Matrices', 'Linked Lists', 'Stacks and Queues', 'Trees'],
            },
            distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 29, Medium: 43, Hard: 28 } },
          },
          {
            section_name: 'Coding', question_count: 5, marks_per_question: 10, negative_marks: 0,
            rule: {
              question_type: ['Coding'],
              subject: ['Data Structures and Algorithms'],
              area: ['Arrays and Matrices', 'String Algorithms', 'Dynamic Programming'],
              difficulty: ['Medium', 'Hard'],
            },
          },
          {
            section_name: 'Applied Reasoning', question_count: 10, marks_per_question: 2, negative_marks: 0.5,
            rule: {
              question_type: ['Multiple Select', 'Output-based'],
              subject: ['Data Structures and Algorithms'],
              area: ['Graphs', 'Trees', 'Dynamic Programming'],
            },
          },
        ],
      },
    },
    {
      template_name: 'Operating Systems Quiz',
      description: 'Short 15-question quiz across the Operating System areas.',
      configuration: {
        test: { test_name: 'Operating Systems Quiz', duration_minutes: 25, course: 'Operating System', randomize_questions: 1, prevent_duplicates: 1 },
        sections: [
          {
            section_name: 'Operating System', question_count: 15, marks_per_question: 2, negative_marks: 0.5,
            rule: { question_type: ['MCQ'], subject: ['Operating System'] },
            distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 40, Medium: 40, Hard: 20 } },
          },
        ],
      },
    },
    {
      template_name: 'SQL and DBMS Screening',
      description: 'Database screening round mixing concept MCQs with query writing.',
      configuration: {
        test: { test_name: 'SQL and DBMS Screening', duration_minutes: 45, course: 'Database Systems', randomize_questions: 1, prevent_duplicates: 1 },
        sections: [
          { section_name: 'DBMS Concepts', question_count: 10, marks_per_question: 1, negative_marks: 0,
            rule: { question_type: ['MCQ'], subject: ['DBMS'] } },
          { section_name: 'Query Writing', question_count: 5, marks_per_question: 4, negative_marks: 0,
            rule: { question_type: ['SQL'], subject: ['SQL'] } },
        ],
      },
    },
  ];

  const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  const insert = db.prepare(
    `INSERT INTO test_templates (template_name, description, configuration, created_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (template_name) DO NOTHING`,
  );
  let added = 0;
  for (const t of templates) {
    added += insert.run(t.template_name, t.description, JSON.stringify(t.configuration), admin?.id ?? null).changes;
  }
  if (added && !quiet) console.log(`Seeded ${added} test template(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const readArg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i !== -1 && args[i + 1]) return args[i + 1];
    const inline = args.find((a) => a.startsWith(`--${name}=`));
    return inline ? inline.split('=').slice(1).join('=') : fallback;
  };
  seed({
    count: Number.parseInt(readArg('count', '5000'), 10),
    seed: readArg('seed', 'DTG-SEED-V1'),
    fresh: args.includes('--fresh'),
  });
  closeDb();
}
