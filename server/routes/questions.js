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

router.get('/:qid', requirePermission('questions:read'), (req, res, next) => {
  // Answers are never sent to viewers.
  const withAnswers = req.query.withAnswers === 'true' && req.user.role !== 'viewer';
  const question = getQuestionByQid(req.params.qid, { withAnswers });
  if (!question) return next(notFound(`No question with QID ${req.params.qid}`));
  res.json(question);
});

export default router;
