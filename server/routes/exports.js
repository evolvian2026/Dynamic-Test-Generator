/** Export endpoints (spec §19). */

import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import { getTestRow, audit } from '../services/testService.js';
import { toJson, toCsv, toXlsx, toStudentPdf, toAnswerKeyPdf } from '../services/exportService.js';
import { toQtiPackage } from '../services/qtiService.js';

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

/**
 * Student paper.
 *
 * Layout is chosen per download rather than stored: the same test is often
 * printed one way for an invigilated sitting and another for a take-home.
 *   ?includeQid=true|false  override the test's own QID setting
 *   ?columns=1|2            two-column saves roughly a third of the paper
 *   ?pageBreaks=true        start each section on a fresh page
 *   ?answerSpace=false      omit ruled writing space
 *   ?branding=false         omit institution name and logo
 */
router.get('/:id/pdf', (req, res) => {
  const includeQid = req.query.includeQid === undefined ? null : req.query.includeQid === 'true';
  const options = {
    includeQid,
    columns: req.query.columns === '2' ? 2 : 1,
    pageBreakBetweenSections: req.query.pageBreaks === 'true',
    answerSpace: req.query.answerSpace !== 'false',
    branding: req.query.branding !== 'false',
  };
  const doc = toStudentPdf(req.testRow.id, options);
  audit(req.user.id, 'export.pdf.student', 'test', String(req.testRow.id), options);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}-paper.pdf"`);
  doc.pipe(res);
});

/** QTI 2.1 content package, for import into an LMS. */
router.get('/:id/qti', async (req, res, next) => {
  try {
    const buffer = await toQtiPackage(req.testRow.id);
    audit(req.user.id, 'export.qti', 'test', String(req.testRow.id), null);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}-qti.zip"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/answer-key.pdf', requirePermission('tests:write'), (req, res) => {
  const doc = toAnswerKeyPdf(req.testRow.id);
  audit(req.user.id, 'export.pdf.answerKey', 'test', String(req.testRow.id), null);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${slug(req.testRow.test_name)}-answer-key.pdf"`);
  doc.pipe(res);
});

export default router;
