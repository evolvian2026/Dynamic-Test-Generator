/** Test lifecycle API (spec §7–§12, §17, §18, §22, §25). */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission, assertCanModifyTest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { notFound } from '../middleware/errors.js';
import {
  createTest, getTest, getTestRow, listTests, updateTestMeta, deleteTest,
  duplicateTest, regenerateTest, createVersions, replacementOptions, replaceQuestion,
  addQuestions, removeQuestion, moveQuestion, reorderSection, explainTestQuestion,
  submitForReview, reviewTest, publishTest, duplicateWarnings,
} from '../services/testService.js';
import { testCoverage, fullCoverage, COVERAGE_AXES } from '../core/coverage.js';
import { checkTest, checkSection } from '../core/availability.js';
import { validateTestDefinition } from '../core/validation.js';
import { generateSelection } from '../core/generator.js';
import { getQuestionsByQids } from '../core/questions.js';

const router = Router();
router.use(requireAuth);

const ruleSchema = z.record(z.string(), z.any()).default({});

const distributionSchema = z.object({
  field: z.string().default('difficulty'),
  mode: z.enum(['percentage', 'count']).default('percentage'),
  values: z.record(z.string(), z.coerce.number()),
}).nullable().optional();

const sectionSchema = z.object({
  section_name: z.string().min(1),
  section_description: z.string().nullish(),
  section_order: z.coerce.number().int().optional(),
  question_count: z.coerce.number().int().min(0),
  marks_per_question: z.coerce.number().min(0),
  negative_marks: z.coerce.number().min(0).default(0),
  time_limit_minutes: z.coerce.number().int().positive().nullish(),
  rule: ruleSchema.optional(),
  distribution: distributionSchema,
  qids: z.array(z.string()).default([]),
  pinnedQids: z.array(z.string()).default([]),
  randomize: z.boolean().default(true),
});

const testMetaSchema = z.object({
  test_name: z.string().min(1),
  description: z.string().nullish(),
  course: z.string().nullish(),
  duration_minutes: z.coerce.number().int().positive(),
  total_marks: z.coerce.number().min(0).optional(),
  instructions: z.string().nullish(),
  starts_at: z.string().nullish(),
  ends_at: z.string().nullish(),
  status: z.enum(['draft', 'review', 'approved', 'published', 'archived']).default('draft'),
  randomize_questions: z.boolean().default(true),
  randomize_options: z.boolean().default(true),
  prevent_duplicates: z.boolean().default(true),
  include_qid_in_student: z.boolean().default(false),
  random_seed: z.string().nullish(),
});

const createSchema = z.object({
  test: testMetaSchema,
  sections: z.array(sectionSchema).min(1),
  mode: z.enum(['automatic', 'manual', 'hybrid']).default('automatic'),
  allowPartial: z.boolean().default(false),
  templateId: z.coerce.number().int().nullish(),
});

/** Resolves :id and enforces read access. */
function loadTest(req, res, next) {
  const test = getTestRow(req.params.id);
  if (!test) return next(notFound('Test not found'));
  req.testRow = test;
  next();
}

/* --------------------------- planning ------------------------------ */

/** Live availability for a whole draft test (spec §7, §14, §24). */
router.post('/availability', requirePermission('tests:read'), validateBody(z.object({
  sections: z.array(z.record(z.string(), z.any())).default([]),
  preventDuplicates: z.boolean().default(true),
})), (req, res) => {
  res.json(checkTest({ sections: req.body.sections, preventDuplicates: req.body.preventDuplicates }));
});

/** Live availability for a single section as the user edits its filters. */
router.post('/availability/section', requirePermission('tests:read'), validateBody(z.object({
  section: z.record(z.string(), z.any()).default({}),
  excludeQids: z.array(z.string()).default([]),
})), (req, res) => {
  res.json(checkSection(req.body.section, { excludeQids: req.body.excludeQids }));
});

/**
 * Dry-run validation without writing anything (spec §22).
 *
 * Deliberately permissive at the transport layer: reporting *why* a draft is
 * invalid is this endpoint's whole purpose, so a missing name or a zero
 * duration must reach the domain validator instead of being rejected as a
 * malformed request.
 */
router.post('/validate', requirePermission('tests:read'), validateBody(z.object({
  test: z.record(z.string(), z.any()).default({}),
  sections: z.array(z.record(z.string(), z.any())).default([]),
})), (req, res) => {
  res.json(validateTestDefinition(req.body.test, req.body.sections, { checkAvailability: true }));
});

/** Generates a preview selection without persisting it (spec §8, §11). */
router.post('/preview', requirePermission('tests:write'), validateBody(z.object({
  sections: z.array(sectionSchema).min(1),
  mode: z.enum(['automatic', 'manual', 'hybrid']).default('automatic'),
  seed: z.string().nullish(),
  preventDuplicates: z.boolean().default(true),
  allowPartial: z.boolean().default(true),
})), (req, res) => {
  const selection = generateSelection({
    sections: req.body.sections,
    mode: req.body.mode,
    seed: req.body.seed || null,
    preventDuplicates: req.body.preventDuplicates,
    allowPartial: req.body.allowPartial,
  });

  // Attach question metadata so the preview panel can render immediately.
  const qids = selection.sections.flatMap((s) => s.questions.map((q) => q.qid));
  const byQid = new Map(getQuestionsByQids(qids).map((q) => [q.qid, q]));
  res.json({
    ...selection,
    sections: selection.sections.map((s) => ({
      ...s,
      questions: s.questions.map((q) => ({ ...q, question: byQid.get(q.qid) || null })),
    })),
  });
});

/* --------------------------- CRUD ---------------------------------- */

router.get('/', requirePermission('tests:read'), (req, res) => {
  res.json(listTests({
    user: req.user,
    page: req.query.page,
    pageSize: req.query.pageSize,
    status: req.query.status || undefined,
    search: req.query.search || undefined,
    mine: req.query.mine === 'true',
    includeArchived: req.query.includeArchived !== 'false',
  }));
});

router.post('/', requirePermission('tests:write'), validateBody(createSchema), (req, res) => {
  const result = createTest({
    user: req.user,
    test: req.body.test,
    sections: req.body.sections,
    mode: req.body.mode,
    allowPartial: req.body.allowPartial,
    templateId: req.body.templateId ?? null,
  });
  res.status(201).json(result);
});

router.get('/:id', requirePermission('tests:read'), loadTest, (req, res) => {
  const withAnswers = req.query.withAnswers === 'true' && req.user.role !== 'viewer';
  res.json(getTest(req.testRow.id, { withAnswers, applyRandomization: req.query.randomize === 'true' }));
});

router.patch('/:id', requirePermission('tests:write'), loadTest, validateBody(testMetaSchema.partial()), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(updateTestMeta(req.testRow.id, req.body, req.user));
});

router.delete('/:id', requirePermission('tests:delete'), loadTest, (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(deleteTest(req.testRow.id, req.user));
});

router.post('/:id/archive', requirePermission('tests:write'), loadTest, (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(updateTestMeta(req.testRow.id, { status: 'archived' }, req.user));
});

router.post('/:id/duplicate', requirePermission('tests:write'), loadTest, validateBody(z.object({
  name: z.string().optional(),
})), (req, res) => {
  res.status(201).json(duplicateTest(req.testRow.id, req.user, { name: req.body.name }));
});

router.post('/:id/regenerate', requirePermission('tests:write'), loadTest, validateBody(z.object({
  seed: z.string().nullish(),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(regenerateTest(req.testRow.id, req.user, { seed: req.body.seed || null }));
});

/** Multiple versions of the same blueprint (spec §17). */
router.post('/:id/versions', requirePermission('tests:write'), loadTest, validateBody(z.object({
  count: z.coerce.number().int().min(1).max(12).default(2),
  uniqueAcrossVersions: z.boolean().default(false),
  seed: z.string().nullish(),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.status(201).json(createVersions(req.testRow.id, req.user, req.body));
});

router.get('/:id/versions', requirePermission('tests:read'), loadTest, (req, res) => {
  res.json(listTests({ user: req.user, pageSize: 100 }).items.filter(
    (t) => t.parent_test_id === req.testRow.id || t.id === req.testRow.id,
  ));
});

/* ----------------------- review and approval ------------------------ */

router.post('/:id/submit-review', requirePermission('tests:write'), loadTest, validateBody(z.object({
  note: z.string().nullish(),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(submitForReview(req.testRow.id, req.user, { note: req.body.note }));
});

/**
 * Approving is gated on `tests:approve`, which only an admin holds — and the
 * service additionally refuses to let anyone approve their own test.
 */
router.post('/:id/approve', requirePermission('tests:approve'), loadTest, validateBody(z.object({
  note: z.string().nullish(),
})), (req, res) => {
  res.json(reviewTest(req.testRow.id, req.user, { approve: true, note: req.body.note }));
});

router.post('/:id/reject', requirePermission('tests:approve'), loadTest, validateBody(z.object({
  note: z.string().nullish(),
})), (req, res) => {
  res.json(reviewTest(req.testRow.id, req.user, { approve: false, note: req.body.note }));
});

router.post('/:id/publish', requirePermission('tests:write'), loadTest, (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(publishTest(req.testRow.id, req.user));
});

/* --------------------------- coverage ------------------------------- */

/**
 * Did the generated test cover what the sections asked for?
 * Availability answers "can this be filled"; this answers "is it balanced".
 */
router.get('/:id/coverage', requirePermission('tests:read'), loadTest, (req, res) => {
  if (req.query.axis === 'all') return res.json({ axes: fullCoverage(req.testRow.id) });
  res.json(testCoverage(req.testRow.id, req.query.axis || 'difficulty'));
});

router.get('/:id/coverage/axes', requirePermission('tests:read'), loadTest, (req, res) => {
  res.json(Object.entries(COVERAGE_AXES).map(([key, value]) => ({ key, label: value.label })));
});

/** Near-duplicate questions drawn into the same test. */
router.get('/:id/duplicate-warnings', requirePermission('tests:read'), loadTest, (req, res) => {
  res.json({
    threshold: Number(req.query.threshold) || 0.6,
    pairs: duplicateWarnings(req.testRow.id, { threshold: Number(req.query.threshold) || 0.6 }),
  });
});

/* --------------------- question-level editing ---------------------- */

router.get('/:id/questions/:testQuestionId/replacements', requirePermission('tests:write'), loadTest, (req, res) => {
  res.json(replacementOptions(req.testRow.id, Number(req.params.testQuestionId), {
    limit: Math.min(Number(req.query.limit) || 20, 100),
  }));
});

router.post('/:id/questions/:testQuestionId/replace', requirePermission('tests:write'), loadTest, validateBody(z.object({
  qid: z.string().min(1),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(replaceQuestion(req.testRow.id, Number(req.params.testQuestionId), req.body.qid, req.user));
});

router.get('/:id/questions/:testQuestionId/explain', requirePermission('tests:read'), loadTest, (req, res) => {
  res.json(explainTestQuestion(req.testRow.id, Number(req.params.testQuestionId)));
});

router.post('/:id/sections/:sectionId/questions', requirePermission('tests:write'), loadTest, validateBody(z.object({
  qids: z.array(z.string()).min(1).max(200),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(addQuestions(req.testRow.id, Number(req.params.sectionId), req.body.qids, req.user));
});

router.delete('/:id/questions/:testQuestionId', requirePermission('tests:write'), loadTest, (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(removeQuestion(req.testRow.id, Number(req.params.testQuestionId), req.user));
});

router.post('/:id/questions/:testQuestionId/move', requirePermission('tests:write'), loadTest, validateBody(z.object({
  sectionId: z.coerce.number().int(),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(moveQuestion(req.testRow.id, Number(req.params.testQuestionId), req.body.sectionId, req.user));
});

router.post('/:id/sections/:sectionId/reorder', requirePermission('tests:write'), loadTest, validateBody(z.object({
  orderedIds: z.array(z.coerce.number().int()).min(1),
})), (req, res) => {
  assertCanModifyTest(req.user, req.testRow);
  res.json(reorderSection(req.testRow.id, Number(req.params.sectionId), req.body.orderedIds, req.user));
});

export default router;
