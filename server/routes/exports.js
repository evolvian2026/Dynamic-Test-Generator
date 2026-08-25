/** Export endpoints (spec §19). */

import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import { getTestRow, audit } from '../services/testService.js';
import { toJson, toCsv, toXlsx, toStudentPdf, toAnswerKeyPdf } from '../services/exportService.js';

const router = Router();
router.use(requireAuth);

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';

function loadTest(req, res, next) {
  const test = getTestRow(req.params.id);
  if (!test) return next(notFound('Test not found'));
  req.testRow = test;
  next();
}

router.use('/:id', requirePermission('exports:read'), loadTest);

router.get('/:id/json', (req, res) => {
  const data = toJson(req.testRow.id);
  audit(req.user.id, 'export.json', 'test', String(req.testRow.id), null);
  res.setHeader('Content-Disposition', `attachment; filename="${slug(data.test.test_name)}.json"`);
  res.json(data);
});

router.get('/:id/csv', (req, res) => {
  // Viewers never receive answer keys.
  const includeAnswers = req.query.includeAnswers !== 'false' && req.user.role !== 'viewer';
  const csv = toCsv(req.testRow.id, { includeAnswers });
  audit(req.user.id, 'export.csv', 'test', String(req.testRow.id), { includeAnswers });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}.csv"`);
  res.send(`﻿${csv}`); // BOM so Excel reads UTF-8 correctly
});

router.get('/:id/xlsx', async (req, res, next) => {
  try {
    const buffer = await toXlsx(req.testRow.id);
    audit(req.user.id, 'export.xlsx', 'test', String(req.testRow.id), null);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

router.get('/:id/pdf', (req, res) => {
  // `includeQid` overrides the test's stored setting for this download only.
  const includeQid = req.query.includeQid === undefined ? null : req.query.includeQid === 'true';
  const doc = toStudentPdf(req.testRow.id, { includeQid });
  audit(req.user.id, 'export.pdf.student', 'test', String(req.testRow.id), { includeQid });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}-paper.pdf"`);
  doc.pipe(res);
});

router.get('/:id/answer-key.pdf', requirePermission('tests:write'), (req, res) => {
  const doc = toAnswerKeyPdf(req.testRow.id);
  audit(req.user.id, 'export.pdf.answerKey', 'test', String(req.testRow.id), null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}-answer-key.pdf"`);
  doc.pipe(res);
});

export default router;
