/**
 * Deterministic question-bank seeder.
 *
 *   npm run seed                 # 5,000 questions
 *   npm run seed -- --count 250000 --seed DSA2026
 *   npm run seed -- --fresh      # wipe the bank first
 *
 * The generated bank is realistic enough to exercise every filter, every
 * distribution and the large-bank code paths: multiple types, topics,
 * subtopics, difficulties, tag vocabularies and extended metadata.
 */

import bcrypt from 'bcryptjs';
import { getDb, closeDb } from './index.js';
import { migrate } from './migrate.js';
import { createRng } from '../core/rng.js';
import { KNOWN_QUESTION_TYPES, DIFFICULTY_LEVELS } from '../core/metadata.js';

const TAXONOMY = {
  Arrays: ['Traversal', 'Searching', 'Sorting', 'Prefix Sum', 'Two Pointer', 'Sliding Window', 'Matrix'],
  Strings: ['Pattern Matching', 'Palindromes', 'Anagrams', 'Parsing', 'String Builder', 'Tries'],
  'Linked List': ['Singly Linked', 'Doubly Linked', 'Cycle Detection', 'Reversal', 'Merging'],
  Stack: ['Monotonic Stack', 'Expression Evaluation', 'Balanced Parentheses', 'Min Stack'],
  Queue: ['Circular Queue', 'Deque', 'Priority Queue', 'BFS Applications'],
  Trees: ['Binary Tree', 'Binary Search Tree', 'Traversals', 'Lowest Common Ancestor', 'Segment Tree', 'AVL'],
  Graph: ['BFS', 'DFS', 'Shortest Path', 'Minimum Spanning Tree', 'Topological Sort', 'Union Find'],
  'Dynamic Programming': ['1D DP', '2D DP', 'Knapsack', 'Longest Subsequence', 'Bitmask DP', 'Memoisation'],
  Hashing: ['Hash Maps', 'Collision Handling', 'Frequency Counting', 'Set Operations'],
  Recursion: ['Backtracking', 'Divide and Conquer', 'Tail Recursion', 'Permutations'],
  Greedy: ['Interval Scheduling', 'Huffman Coding', 'Activity Selection', 'Exchange Argument'],
  'Bit Manipulation': ['Bit Masks', 'XOR Tricks', 'Bit Counting', 'Power of Two'],
  Sorting: ['Quick Sort', 'Merge Sort', 'Counting Sort', 'Custom Comparators', 'Stability'],
  Searching: ['Binary Search', 'Ternary Search', 'Search on Answer', 'Rotated Arrays'],
  Heap: ['Min Heap', 'Max Heap', 'Heapify', 'Top K Elements'],
  'SQL & Databases': ['Joins', 'Aggregations', 'Window Functions', 'Indexes', 'Normalisation', 'Transactions'],
  'Operating Systems': ['Processes', 'Threads', 'Deadlocks', 'Memory Management', 'Scheduling'],
  'Object Oriented Design': ['Inheritance', 'Polymorphism', 'Design Patterns', 'SOLID Principles'],
};

const TAG_POOL = [
  'two-pointer', 'sliding-window', 'binary-search', 'recursion', 'dynamic-programming', 'greedy',
  'hashmap', 'sorting', 'graph-traversal', 'in-place', 'optimisation', 'edge-cases', 'beginner',
  'intermediate', 'advanced', 'interview-favourite', 'placement', 'faang', 'time-complexity',
  'space-complexity', 'implementation', 'maths', 'string-manipulation', 'tree-traversal', 'bitwise',
];

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

function buildQuestionText(rng, type, topic, subtopic, difficulty, index) {
  const complexity = pick(rng, ['O(n)', 'O(n log n)', 'O(log n)', 'O(n²)', 'O(1)']);
  switch (type) {
    case 'MCQ':
      return `Which of the following statements about ${subtopic.toLowerCase()} in ${topic} is correct when the input size is large? (Reference set ${index})`;
    case 'Multiple Select':
      return `Select all approaches that correctly solve the ${subtopic.toLowerCase()} problem on ${topic} within ${complexity} time. (Reference set ${index})`;
    case 'Coding':
      return `Write a function that solves the following ${difficulty.toLowerCase()} ${topic} problem using ${subtopic.toLowerCase()}. Your solution should run in ${complexity} time and handle empty input. (Problem ${index})`;
    case 'Fill in the Blank':
      return `In ${topic}, the ${subtopic.toLowerCase()} technique achieves a worst-case time complexity of ________ for the standard implementation. (Item ${index})`;
    case 'True/False':
      return `True or False: every ${subtopic.toLowerCase()} problem in ${topic} can be solved in ${complexity} time without additional space. (Item ${index})`;
    case 'Subjective':
      return `Explain, with an example, how ${subtopic.toLowerCase()} is applied to ${topic} problems and discuss the trade-offs against the brute-force approach. (Item ${index})`;
    case 'SQL':
      return `Given the tables employees(id, name, dept_id, salary) and departments(id, name), write a query that demonstrates ${subtopic.toLowerCase()}. (Query ${index})`;
    case 'Output-based':
      return `What is the output of the following program that applies ${subtopic.toLowerCase()} to a ${topic} structure? (Snippet ${index})`;
    case 'Debugging':
      return `The following ${topic} implementation of ${subtopic.toLowerCase()} fails on certain inputs. Identify the defect and describe the fix. (Snippet ${index})`;
    default:
      return `Question about ${subtopic} in ${topic}. (Item ${index})`;
  }
}

function buildOptions(rng, type, topic, subtopic) {
  if (type === 'True/False') {
    const correct = rng() > 0.5;
    return [
      { option_text: 'True', is_correct: correct ? 1 : 0 },
      { option_text: 'False', is_correct: correct ? 0 : 1 },
    ];
  }
  if (type !== 'MCQ' && type !== 'Multiple Select') return [];

  const stems = [
    `It always runs in linear time for ${subtopic.toLowerCase()}`,
    `It requires the input to be sorted first`,
    `It uses O(1) auxiliary space`,
    `It degrades to quadratic time in the worst case`,
    `It is the standard approach for ${topic}`,
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
    db.exec('DELETE FROM test_questions; DELETE FROM test_sections; DELETE FROM tests; DELETE FROM questions; DELETE FROM facet_counts;');
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
  const topics = Object.keys(TAXONOMY);

  const insertQuestion = db.prepare(
    `INSERT INTO questions (qid, question_type, question_text, topic, subtopic, difficulty, marks,
                            expected_seconds, status, answer_text, explanation, metadata)
     VALUES (@qid, @question_type, @question_text, @topic, @subtopic, @difficulty, @marks,
             @expected_seconds, @status, @answer_text, @explanation, @metadata)`,
  );
  const insertOption = db.prepare(
    'INSERT INTO question_options (question_id, position, option_text, is_correct) VALUES (?, ?, ?, ?)',
  );
  const insertTag = db.prepare('INSERT OR IGNORE INTO question_tags (question_id, tag) VALUES (?, ?)');
  const insertAttr = db.prepare(
    'INSERT OR IGNORE INTO question_attributes (question_id, attr_key, attr_value, num_value) VALUES (?, ?, ?, ?)',
  );

  const insertBatch = db.transaction((from, to) => {
    for (let i = from; i < to; i += 1) {
      const n = startIndex + i + 1;
      const qid = `QID${n}`;
      const topic = pick(rng, topics);
      const subtopic = pick(rng, TAXONOMY[topic]);
      const type = weightedPick(rng, TYPE_WEIGHTS);
      const difficulty = weightedPick(rng, [['Easy', 0.3], ['Medium', 0.45], ['Hard', 0.25]]);
      const status = weightedPick(rng, STATUS_WEIGHTS);

      const info = insertQuestion.run({
        qid,
        question_type: type,
        question_text: buildQuestionText(rng, type, topic, subtopic, difficulty, n),
        topic,
        subtopic,
        difficulty,
        marks: marksFor(rng, type, difficulty),
        expected_seconds: secondsFor(type, difficulty),
        status,
        answer_text:
          type === 'Coding' || type === 'Subjective' || type === 'SQL' || type === 'Debugging'
            ? `Model answer for ${qid}: apply ${subtopic.toLowerCase()} and justify the complexity.`
            : null,
        explanation: `The ${subtopic.toLowerCase()} approach is preferred here because it avoids re-scanning the input.`,
        metadata: JSON.stringify({ generated: true, seedBatch: seedValue }),
      });
      const questionId = info.lastInsertRowid;

      for (const [position, option] of buildOptions(rng, type, topic, subtopic).entries()) {
        insertOption.run(questionId, position + 1, option.option_text, option.is_correct);
      }

      const tagCount = 1 + Math.floor(rng() * 4);
      const tags = new Set();
      tags.add(difficulty === 'Easy' ? 'beginner' : difficulty === 'Hard' ? 'advanced' : 'intermediate');
      while (tags.size < tagCount + 1) tags.add(pick(rng, TAG_POOL));
      for (const tag of tags) insertTag.run(questionId, tag);

      const attrs = [
        ['company', pick(rng, COMPANIES), null],
        ['language', pick(rng, LANGUAGES), null],
        ['bloom_taxonomy', pick(rng, BLOOM), null],
        ['cognitive_level', pick(rng, COGNITIVE), null],
        ['source', pick(rng, SOURCES), null],
        ['author', pick(rng, AUTHORS), null],
        ['course', pick(rng, COURSES), null],
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
  const templates = [
    {
      template_name: 'DSA Placement Test',
      description: '50-question placement blueprint across the core DSA topics.',
      configuration: {
        test: { test_name: 'DSA Placement Test', duration_minutes: 90, course: 'Placement Prep', randomize_questions: 1, prevent_duplicates: 1 },
        sections: [
          {
            section_name: 'Concepts', question_count: 35, marks_per_question: 1, negative_marks: 0.25,
            rule: { question_type: ['MCQ'], topic: ['Arrays', 'Strings', 'Linked List', 'Trees'] },
            distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 29, Medium: 43, Hard: 28 } },
          },
          {
            section_name: 'Coding', question_count: 5, marks_per_question: 10, negative_marks: 0,
            rule: { question_type: ['Coding'], topic: ['Arrays', 'Strings', 'Dynamic Programming'], difficulty: ['Medium', 'Hard'] },
          },
          {
            section_name: 'Applied Reasoning', question_count: 10, marks_per_question: 2, negative_marks: 0.5,
            rule: { question_type: ['Multiple Select', 'Output-based'], topic: ['Graph', 'Trees', 'Dynamic Programming'] },
          },
        ],
      },
    },
    {
      template_name: 'Weekly Arrays Quiz',
      description: 'Short 15-question quiz focused on arrays.',
      configuration: {
        test: { test_name: 'Weekly Arrays Quiz', duration_minutes: 25, course: 'Data Structures', randomize_questions: 1, prevent_duplicates: 1 },
        sections: [
          {
            section_name: 'Arrays', question_count: 15, marks_per_question: 2, negative_marks: 0.5,
            rule: { question_type: ['MCQ'], topic: ['Arrays'], excludeTags: ['advanced'] },
            distribution: { field: 'difficulty', mode: 'percentage', values: { Easy: 40, Medium: 40, Hard: 20 } },
          },
        ],
      },
    },
    {
      template_name: 'SQL Screening',
      description: 'Database screening round mixing MCQs and query writing.',
      configuration: {
        test: { test_name: 'SQL Screening', duration_minutes: 45, course: 'Database Systems', randomize_questions: 1, prevent_duplicates: 1 },
        sections: [
          { section_name: 'SQL Concepts', question_count: 10, marks_per_question: 1, negative_marks: 0,
            rule: { question_type: ['MCQ'], topic: ['SQL & Databases'] } },
          { section_name: 'Query Writing', question_count: 5, marks_per_question: 4, negative_marks: 0,
            rule: { question_type: ['SQL'], topic: ['SQL & Databases'] } },
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
