/** Question bank API (spec §13, §14, §21). */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  listMatching, countMatching, getQuestionByQid, getQuestionsByQids,
  bankStatistics, getFacet, getSubtopics, searchTags,
} from '../core/questions.js';
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
  res.json({
    fields: listFields(),
    primaryFields: primaryFields().map((f) => f.key),
    operators: OPERATORS,
    questionTypes: getFacet('question_type').map((r) => r.value).length
      ? getFacet('question_type').map((r) => r.value)
      : KNOWN_QUESTION_TYPES,
    difficulties: DIFFICULTY_LEVELS,
    statuses: QUESTION_STATUSES,
    topics: getFacet('topic'),
    tags: getFacet('tag').slice(0, 100),
  });
});

router.get('/facets/:dimension', requirePermission('questions:read'), (req, res) => {
  const { dimension } = req.params;
  const parent = String(req.query.parent ?? '');
  if (dimension === 'subtopic') return res.json(getSubtopics(parent || null));
  res.json(getFacet(dimension, parent));
});

router.get('/tags', requirePermission('questions:read'), (req, res) => {
  res.json(searchTags(String(req.query.q ?? ''), Math.min(Number(req.query.limit) || 30, 100)));
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
