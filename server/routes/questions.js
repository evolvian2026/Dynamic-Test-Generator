/** Question bank API (spec §13, §14, §21). */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  listMatching, countMatching, getQuestionByQid, getQuestionsByQids,
  bankStatistics, getFacet, getFacetAcrossParents, getAreas, getSubAreas, searchTags,
} from '../core/questions.js';
import { getTaxonomyTree, tagsFor } from '../core/taxonomy.js';
import { createQuestion, updateQuestion, retireQuestion } from '../services/questionService.js';
import { previewImport, commitImport } from '../services/importService.js';
import { findSimilar, duplicateReport, backfillFingerprints } from '../core/similarity.js';
import { usageForQuestion, exposureOverview } from '../core/exposure.js';
import { questionAnalytics } from '../core/itemAnalytics.js';
import { getDb } from '../db/index.js';
import { listFields, primaryFields, OPERATORS, KNOWN_QUESTION_TYPES, DIFFICULTY_LEVELS, QUESTION_STATUSES } from '../core/metadata.js';
import { notFound } from '../middleware/errors.js';

const router = Router();
router.use(requireAuth);

const ruleSchema = z.record(z.string(), z.any()).default({});

const searchSchema = z.object({
  filter: ruleSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  direction: z.enum(['asc', 'desc']).default('asc'),
  withDetails: z.boolean().default(false),
  activeOnly: z.boolean().default(true),
  excludeQids: z.array(z.string()).default([]),
});

/** Field registry + facet vocabularies that drive the filter builder UI. */
router.get('/metadata', requirePermission('questions:read'), (req, res) => {
  const seenTypes = getFacet('question_type').map((r) => r.value);
  res.json({
    fields: listFields(),
    primaryFields: primaryFields().map((f) => f.key),
    operators: OPERATORS,
    questionTypes: seenTypes.length ? seenTypes : KNOWN_QUESTION_TYPES,
    difficulties: DIFFICULTY_LEVELS,
    statuses: QUESTION_STATUSES,
    subjects: getFacet('subject'),
    tags: getFacet('tag').slice(0, 100),
  });
});

/** The whole Subject > Area > Sub-Area tree, for the taxonomy browser. */
router.get('/taxonomy', requirePermission('questions:read'), (req, res) => {
  res.json({
    tree: getTaxonomyTree({ withCounts: req.query.withCounts !== 'false' }),
  });
});

/**
 * Facet values for one dimension.
 *
 * The taxonomy levels cascade: `area` is scoped by the selected subject(s) and
 * `sub_area` by the selected area(s), passed as a comma-separated `parent`.
 */
router.get('/facets/:dimension', requirePermission('questions:read'), (req, res) => {
  const { dimension } = req.params;
  const raw = String(req.query.parent ?? '');
  const parents = raw ? raw.split(',').map((v) => v.trim()).filter(Boolean) : [];

  if (dimension === 'area') return res.json(getAreas(parents));
  if (dimension === 'sub_area') return res.json(getSubAreas(parents));
  if (dimension === 'subject') return res.json(getFacet('subject'));
  // Everything else is a flat, parent-less dimension.
  return res.json(raw ? getFacet(dimension, raw) : getFacetAcrossParents(dimension));
});

/**
 * Tag suggestions.
 *
 * `source=taxonomy` returns the vocabulary the taxonomy defines for the given
 * branch — the tags a question in that area is *expected* to carry. The default
 * returns tags actually present in the bank, with usage counts.
 */
router.get('/tags', requirePermission('questions:read'), (req, res) => {
  const search = String(req.query.q ?? '');
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const listOf = (value) => (value ? String(value).split(',').map((v) => v.trim()).filter(Boolean) : []);
  const subjects = listOf(req.query.subject);
  const areas = listOf(req.query.area);

  if (req.query.source === 'taxonomy' || subjects.length || areas.length) {
    return res.json(tagsFor({ subjects, areas, search, limit }));
  }
  return res.json(searchTags(search, limit));
});

router.get('/statistics', requirePermission('questions:read'), (req, res) => {
  res.json(bankStatistics());
});

/** Server-side filtered, paginated listing — the browser never gets the bank. */
router.post('/search', requirePermission('questions:read'), validateBody(searchSchema), (req, res) => {
  const { filter = {}, ...options } = req.body;
  res.json(listMatching(filter, options));
});

/** Live availability count for the current filter (spec §24). */
router.post('/count', requirePermission('questions:read'), validateBody(z.object({
  filter: ruleSchema.optional(),
  excludeQids: z.array(z.string()).default([]),
  activeOnly: z.boolean().default(true),
})), (req, res) => {
  const { filter = {}, excludeQids, activeOnly } = req.body;
  res.json({ available: countMatching(filter, { excludeQids, activeOnly }) });
});

/** Batch lookup used by the manual picker. */
router.post('/lookup', requirePermission('questions:read'), validateBody(z.object({
  qids: z.array(z.string()).max(500),
  withAnswers: z.boolean().default(false),
})), (req, res) => {
  const withAnswers = req.body.withAnswers && req.user.role !== 'viewer';
  res.json(getQuestionsByQids(req.body.qids, { withAnswers }));
});

/* ------------------------------------------------------------------ *
 * Authoring
 * ------------------------------------------------------------------ */

const taxonomyBranchSchema = z.object({
  subject: z.string().min(1),
  area: z.string().min(1),
  subArea: z.string().nullish(),
  isPrimary: z.boolean().optional(),
});

const optionSchema = z.object({
  option_text: z.string().min(1),
  is_correct: z.boolean().default(false),
});

// Field shapes without defaults. `.partial()` does not suppress a `.default()`
// — a PATCH omitting `tags` would otherwise arrive as `tags: []` and wipe them —
// so the update schema is built from these bare shapes and the create schema
// layers its defaults on top.
const questionFields = {
  qid: z.string().optional(),
  question_text: z.string().min(1),
  question_type: z.string().min(1),
  difficulty: z.string().min(1),
  marks: z.coerce.number().min(0),
  expected_seconds: z.coerce.number().int().min(1),
  status: z.string(),
  answer_text: z.string().nullish(),
  explanation: z.string().nullish(),
  tags: z.array(z.string()),
  attributes: z.record(z.string(), z.any()),
  options: z.array(optionSchema),
  metadata: z.record(z.string(), z.any()),
  taxonomy: z.array(taxonomyBranchSchema).min(1),
};

const questionSchema = z.object({
  ...questionFields,
  marks: questionFields.marks.default(1),
  expected_seconds: questionFields.expected_seconds.default(60),
  status: questionFields.status.default('draft'),
  tags: questionFields.tags.default([]),
  attributes: questionFields.attributes.default({}),
  options: questionFields.options.default([]),
  metadata: questionFields.metadata.default({}),
});

/** Every field optional, and genuinely absent when omitted. */
const questionUpdateSchema = z.object(questionFields).partial();

router.post('/', requirePermission('questions:write'), validateBody(questionSchema), (req, res) => {
  res.status(201).json(createQuestion(req.body, req.user));
});

router.patch('/:qid', requirePermission('questions:write'), validateBody(questionUpdateSchema), (req, res) => {
  res.json(updateQuestion(req.params.qid, req.body, req.user));
});

/**
 * Retires a question by default. `?hard=true` deletes it outright, which is
 * refused while any generated test still references it.
 */
router.delete('/:qid', requirePermission('questions:write'), (req, res) => {
  res.json(retireQuestion(req.params.qid, req.user, { hard: req.query.hard === 'true' }));
});

/* ------------------------------------------------------------------ *
 * Bulk import
 * ------------------------------------------------------------------ */

const importRowsSchema = z.object({
  rows: z.array(z.record(z.string(), z.any())).min(1).max(20000),
  detectDuplicates: z.boolean().default(true),
  defaultStatus: z.string().default('draft'),
});

/** Analyses a parsed file and reports what would happen. Writes nothing. */
router.post('/import/preview', requirePermission('questions:import'), validateBody(importRowsSchema), (req, res) => {
  res.json(previewImport(req.body.rows, {
    detectDuplicates: req.body.detectDuplicates,
    defaultStatus: req.body.defaultStatus,
  }));
});

/** Writes the rows the operator accepted. */
router.post('/import/commit', requirePermission('questions:import'), validateBody(z.object({
  items: z.array(z.record(z.string(), z.any())).min(1).max(20000),
  skipInvalid: z.boolean().default(true),
})), (req, res) => {
  res.json(commitImport(req.body.items, req.user, { skipInvalid: req.body.skipInvalid }));
});

/** Template describing the columns an import file may contain. */
router.get('/import/template', requirePermission('questions:import'), (req, res) => {
  res.json({
    required: ['question_text', 'subject', 'area'],
    recommended: ['qid', 'question_type', 'difficulty', 'marks', 'sub_area', 'tags'],
    optional: ['expected_seconds', 'status', 'answer_text', 'explanation', 'option_a..option_h', 'correct_option'],
    notes: [
      'Any column we do not recognise is imported as an extensible attribute.',
      'Subject and area are matched against the taxonomy; close spellings are resolved automatically and anything uncertain is flagged for review.',
      'Tags may be separated by commas, semicolons or pipes; commas inside brackets are preserved.',
    ],
    example: {
      qid: 'QID90001',
      question_text: 'Which page replacement policy evicts the least recently used page?',
      question_type: 'MCQ',
      difficulty: 'Medium',
      marks: 1,
      subject: 'Operating System',
      area: 'Memory Management',
      sub_area: 'Virtual Memory and Paging',
      tags: 'Page Replacement (FIFO, LRU, Optimal, LFU), Demand Paging',
      option_a: 'FIFO', option_b: 'LRU', option_c: 'Optimal', option_d: 'LFU',
      correct_option: 'B',
    },
  });
});

/* ------------------------------------------------------------------ *
 * Near-duplicate detection
 * ------------------------------------------------------------------ */

/** Bank-wide duplicate groups. */
router.get('/duplicates', requirePermission('questions:read'), (req, res) => {
  res.json({
    threshold: Number(req.query.threshold) || 0.6,
    groups: duplicateReport(getDb(), {
      threshold: Number(req.query.threshold) || 0.6,
      limit: Math.min(Number(req.query.limit) || 50, 200),
    }),
  });
});

/** Recomputes fingerprints for rows that lack one. */
router.post('/duplicates/reindex', requirePermission('questions:write'), (req, res) => {
  res.json({ updated: backfillFingerprints(getDb()) });
});

/* ------------------------------------------------------------------ *
 * Exposure
 * ------------------------------------------------------------------ */

router.get('/exposure/overview', requirePermission('questions:read'), (req, res) => {
  res.json(exposureOverview({ limit: Math.min(Number(req.query.limit) || 20, 100) }));
});

router.get('/:qid', requirePermission('questions:read'), (req, res, next) => {
  // Answers are never sent to viewers.
  const withAnswers = req.query.withAnswers === 'true' && req.user.role !== 'viewer';
  const question = getQuestionByQid(req.params.qid, { withAnswers });
  if (!question) return next(notFound(`No question with QID ${req.params.qid}`));
  res.json(question);
});

/** Questions that look like near-duplicates of this one. */
router.get('/:qid/similar', requirePermission('questions:read'), (req, res, next) => {
  const row = getDb().prepare('SELECT id FROM questions WHERE qid = ?').get(req.params.qid);
  if (!row) return next(notFound(`No question with QID ${req.params.qid}`));
  res.json(findSimilar(getDb(), row.id, {
    threshold: Number(req.query.threshold) || 0.6,
    limit: Math.min(Number(req.query.limit) || 20, 100),
  }));
});

/** Where this question has actually been used. */
router.get('/:qid/usage', requirePermission('questions:read'), (req, res, next) => {
  const usage = usageForQuestion(req.params.qid);
  if (!usage) return next(notFound(`No question with QID ${req.params.qid}`));
  res.json(usage);
});

/** Observed performance: p-value, discrimination and distractor behaviour. */
router.get('/:qid/analytics', requirePermission('results:read'), (req, res, next) => {
  const analytics = questionAnalytics(req.params.qid);
  if (!analytics) return next(notFound(`No question with QID ${req.params.qid}`));
  res.json(analytics);
});

export default router;
