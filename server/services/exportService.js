/**
 * Test exports (spec §19).
 *
 *   PDF   — a student version (optionally without QIDs) and a separate answer key
 *   Excel — a workbook with summary, questions and answer-key sheets
 *   CSV   — one flat row per question
 *   JSON  — the full structured test
 *
 * Every exporter reads the stored QIDs and resolves the content from the
 * question bank at export time, so an export always reflects the live bank.
 */

import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { getTest } from './testService.js';
import { randomizeOptions } from '../core/generator.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Loads a test with answers and applies the stored randomisation settings. */
function loadForExport(id, { randomize = true } = {}) {
  const test = getTest(id, { withAnswers: true });
  if (randomize && test.randomize_options) {
    for (const section of test.sections) {
      section.questions = section.questions.map((entry) => ({
        ...entry,
        question: randomizeOptions([entry.question], `${test.random_seed}:opt`)[0],
      }));
    }
  }
  return test;
}

export function toJson(id) {
  const test = loadForExport(id, { randomize: false });
  return {
    test: {
      test_id: test.test_id,
      test_name: test.test_name,
      description: test.description,
      course: test.course,
      duration_minutes: test.duration_minutes,
      total_marks: test.total_marks,
      instructions: test.instructions,
      status: test.status,
      generation_mode: test.generation_mode,
      random_seed: test.random_seed,
      starts_at: test.starts_at,
      ends_at: test.ends_at,
      created_at: test.created_at,
    },
    summary: test.summary,
    sections: test.sections.map((section) => ({
      section_name: section.section_name,
      section_description: section.section_description,
      section_order: section.section_order,
      marks_per_question: section.marks_per_question,
      negative_marks: section.negative_marks,
      time_limit_minutes: section.time_limit_minutes,
      selection_rules: section.selection_rules,
      questions: section.questions.map((entry) => ({
        qid: entry.qid,
        order: entry.order,
        marks: entry.marks,
        question_type: entry.question.question_type,
        question_text: entry.question.question_text,
        topic: entry.question.topic,
        subtopic: entry.question.subtopic,
        difficulty: entry.question.difficulty,
        tags: entry.question.tags,
        options: entry.question.options,
        answer_text: entry.question.answer_text,
        explanation: entry.question.explanation,
        selection_reason: entry.reason,
      })),
    })),
  };
}

/** Flat one-row-per-question CSV. */
export function toCsv(id, { includeAnswers = true } = {}) {
  const data = toJson(id);
  const header = [
    'test_id', 'test_name', 'section', 'question_number', 'qid', 'question_type', 'difficulty',
    'topic', 'subtopic', 'tags', 'marks', 'question_text',
    ...(includeAnswers ? ['correct_answer', 'explanation'] : []),
  ];

  const rows = [header];
  let number = 0;
  for (const section of data.sections) {
    for (const q of section.questions) {
      number += 1;
      rows.push([
        data.test.test_id, data.test.test_name, section.section_name, number, q.qid,
        q.question_type, q.difficulty, q.topic, q.subtopic ?? '', (q.tags || []).join('|'),
        q.marks, q.question_text,
        ...(includeAnswers ? [formatAnswer(q), q.explanation ?? ''] : []),
      ]);
    }
  }

  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatAnswer(question) {
  const correct = (question.options || []).filter((o) => o.is_correct);
  if (correct.length) {
    return correct.map((o) => `${LETTERS[question.options.indexOf(o)]}. ${o.option_text}`).join(' | ');
  }
  return question.answer_text || 'Manually graded';
}

/** Excel workbook: Summary, Questions, Answer Key, Section Rules. */
export async function toXlsx(id) {
  const data = toJson(id);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dynamic Test Generator';
  workbook.created = new Date();

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A93' } },
  };
  const styleHeader = (sheet) => {
    sheet.getRow(1).eachCell((cell) => Object.assign(cell, headerStyle));
    sheet.getRow(1).height = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ header: 'Field', key: 'field', width: 28 }, { header: 'Value', key: 'value', width: 60 }];
  const summaryRows = [
    ['Test ID', data.test.test_id],
    ['Test Name', data.test.test_name],
    ['Course / Subject', data.test.course ?? '—'],
    ['Description', data.test.description ?? '—'],
    ['Duration (minutes)', data.test.duration_minutes],
    ['Total Questions', data.summary.totalQuestions],
    ['Total Marks', data.summary.totalMarks],
    ['Sections', data.summary.totalSections],
    ['Status', data.test.status],
    ['Generation Mode', data.test.generation_mode],
    ['Random Seed', data.test.random_seed ?? '—'],
    ['Created', data.test.created_at],
    ['Difficulty Mix', Object.entries(data.summary.byDifficulty).map(([k, v]) => `${k}: ${v}`).join(', ')],
    ['Type Mix', Object.entries(data.summary.byType).map(([k, v]) => `${k}: ${v}`).join(', ')],
  ];
  for (const [field, value] of summaryRows) summary.addRow({ field, value });
  styleHeader(summary);

  const sectionSheet = workbook.addWorksheet('Sections');
  sectionSheet.columns = [
    { header: 'Section', key: 'name', width: 26 },
    { header: 'Questions', key: 'questions', width: 12 },
    { header: 'Marks', key: 'marks', width: 10 },
    { header: 'Marks / Question', key: 'per', width: 16 },
    { header: 'Negative Marking', key: 'negative', width: 18 },
    { header: 'Time Limit (min)', key: 'time', width: 16 },
    { header: 'Selection Rules', key: 'rules', width: 70 },
  ];
  for (const section of data.sections) {
    sectionSheet.addRow({
      name: section.section_name,
      questions: section.questions.length,
      marks: section.questions.reduce((a, q) => a + q.marks, 0),
      per: section.marks_per_question,
      negative: section.negative_marks,
      time: section.time_limit_minutes ?? '—',
      rules: describeRules(section.selection_rules),
    });
  }
  styleHeader(sectionSheet);

  const questions = workbook.addWorksheet('Questions');
  questions.columns = [
    { header: '#', key: 'number', width: 6 },
    { header: 'Section', key: 'section', width: 22 },
    { header: 'QID', key: 'qid', width: 12 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Difficulty', key: 'difficulty', width: 12 },
    { header: 'Topic', key: 'topic', width: 20 },
    { header: 'Subtopic', key: 'subtopic', width: 20 },
    { header: 'Tags', key: 'tags', width: 28 },
    { header: 'Marks', key: 'marks', width: 8 },
    { header: 'Question', key: 'text', width: 90 },
    { header: 'Options', key: 'options', width: 60 },
  ];

  const answerKey = workbook.addWorksheet('Answer Key');
  answerKey.columns = [
    { header: '#', key: 'number', width: 6 },
    { header: 'QID', key: 'qid', width: 12 },
    { header: 'Correct Answer', key: 'answer', width: 60 },
    { header: 'Marks', key: 'marks', width: 8 },
    { header: 'Difficulty', key: 'difficulty', width: 12 },
    { header: 'Topic', key: 'topic', width: 20 },
    { header: 'Subtopic', key: 'subtopic', width: 20 },
    { header: 'Tags', key: 'tags', width: 28 },
  ];

  let number = 0;
  for (const section of data.sections) {
    for (const q of section.questions) {
      number += 1;
      questions.addRow({
        number, section: section.section_name, qid: q.qid, type: q.question_type,
        difficulty: q.difficulty, topic: q.topic, subtopic: q.subtopic ?? '',
        tags: (q.tags || []).join(', '), marks: q.marks, text: q.question_text,
        options: (q.options || []).map((o, i) => `${LETTERS[i]}. ${o.option_text}`).join('\n'),
      });
      answerKey.addRow({
        number, qid: q.qid, answer: formatAnswer(q), marks: q.marks,
        difficulty: q.difficulty, topic: q.topic, subtopic: q.subtopic ?? '',
        tags: (q.tags || []).join(', '),
      });
    }
  }
  questions.getColumn('text').alignment = { wrapText: true, vertical: 'top' };
  questions.getColumn('options').alignment = { wrapText: true, vertical: 'top' };
  styleHeader(questions);
  styleHeader(answerKey);

  return workbook.xlsx.writeBuffer();
}

function describeRules(rules) {
  const rule = rules?.rule || {};
  const parts = [];
  const push = (label, value) => {
    if (Array.isArray(value) ? value.length : value) parts.push(`${label}: ${Array.isArray(value) ? value.join(', ') : value}`);
  };
  push('Type', rule.question_type);
  push('Topic', rule.topic);
  push('Subtopic', rule.subtopic);
  push('Difficulty', rule.difficulty);
  push('Include tags', rule.includeTags);
  push('Exclude tags', rule.excludeTags);
  if (rules?.distribution?.values) {
    parts.push(`Distribution (${rules.distribution.field}): ${Object.entries(rules.distribution.values).map(([k, v]) => `${k} ${v}${rules.distribution.mode === 'percentage' ? '%' : ''}`).join(', ')}`);
  }
  return parts.length ? parts.join(' | ') : 'No filters — full active bank';
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

const PDF_MARGIN = 50;

/**
 * Student paper (spec §19). Answers are never included. QIDs appear only when
 * "Include QID in Student Version" is on.
 */
export function toStudentPdf(id, { includeQid = null } = {}) {
  const test = loadForExport(id);
  const showQid = includeQid === null ? !!test.include_qid_in_student : includeQid;
  const doc = new PDFDocument({ size: 'A4', margin: PDF_MARGIN, bufferPages: true });

  header(doc, test.test_name, `${test.course ? `${test.course} · ` : ''}Test paper`);

  doc.moveDown(0.5);
  metaGrid(doc, [
    ['Duration', `${test.duration_minutes} minutes`],
    ['Total marks', String(test.total_marks)],
    ['Questions', String(test.summary.totalQuestions)],
    ['Sections', String(test.summary.totalSections)],
  ]);

  if (test.instructions) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f3a93').text('Instructions');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#222').text(test.instructions, { align: 'left' });
  }

  let number = 0;
  for (const section of test.sections) {
    doc.moveDown(1.2);
    sectionHeading(doc, section);

    for (const entry of section.questions) {
      number += 1;
      const question = entry.question;
      ensureSpace(doc, 110);

      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111')
        .text(`Q${number}.`, { continued: true })
        .font('Helvetica').fillColor('#111')
        .text(` ${question.question_text}`);

      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#666')
        .text(`[${question.question_type} · ${entry.marks} mark${entry.marks === 1 ? '' : 's'}${showQid ? ` · ${entry.qid}` : ''}]`);
      doc.fillColor('#111');

      if (question.options?.length) {
        doc.moveDown(0.25);
        question.options.forEach((option, i) => {
          doc.font('Helvetica').fontSize(10).text(`     ${LETTERS[i]}.  ${option.option_text}`);
        });
      } else {
        // Answer space for free-form types (spec §19).
        const lines = { Coding: 12, SQL: 8, Subjective: 8, Debugging: 8, 'Output-based': 4 }[question.question_type] ?? 3;
        answerSpace(doc, lines);
      }
    }
  }

  pageNumbers(doc, test.test_name);
  doc.end();
  return doc;
}

/** Answer key (spec §19) — always carries the QID and full metadata. */
export function toAnswerKeyPdf(id) {
  const test = loadForExport(id);
  const doc = new PDFDocument({ size: 'A4', margin: PDF_MARGIN, bufferPages: true });

  header(doc, `${test.test_name} — Answer Key`, `Confidential · ${test.test_id}`);
  doc.moveDown(0.5);
  metaGrid(doc, [
    ['Total marks', String(test.total_marks)],
    ['Questions', String(test.summary.totalQuestions)],
    ['Seed', test.random_seed || '—'],
    ['Generated', String(test.created_at).slice(0, 16)],
  ]);

  let number = 0;
  for (const section of test.sections) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1f3a93').text(section.section_name);
    doc.fillColor('#111');

    for (const entry of section.questions) {
      number += 1;
      const q = entry.question;
      ensureSpace(doc, 80);

      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(10).text(`Q${number}  ·  ${entry.qid}`);
      doc.font('Helvetica').fontSize(9.5).fillColor('#333')
        .text(truncate(q.question_text, 220));

      doc.moveDown(0.15);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0a7d3f')
        .text('Answer: ', { continued: true })
        .font('Helvetica').fillColor('#111').text(formatAnswer(q));

      doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(
        `Marks: ${entry.marks}   ·   Difficulty: ${q.difficulty}   ·   Topic: ${q.topic}` +
        `${q.subtopic ? `   ·   Subtopic: ${q.subtopic}` : ''}` +
        `${q.tags?.length ? `   ·   Tags: ${q.tags.join(', ')}` : ''}`,
      );
      if (q.explanation) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555').text(`Explanation: ${truncate(q.explanation, 300)}`);
      }
      doc.fillColor('#111');
    }
  }

  pageNumbers(doc, `${test.test_name} — Answer Key`);
  doc.end();
  return doc;
}

/* ----------------------------- PDF helpers ------------------------- */

function header(doc, title, subtitle) {
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1f3a93').text(title, { align: 'center' });
  doc.font('Helvetica').fontSize(10).fillColor('#666').text(subtitle, { align: 'center' });
  doc.moveDown(0.4);
  const y = doc.y;
  doc.strokeColor('#1f3a93').lineWidth(1.2)
    .moveTo(PDF_MARGIN, y).lineTo(doc.page.width - PDF_MARGIN, y).stroke();
  doc.fillColor('#111');
}

function metaGrid(doc, pairs) {
  const usable = doc.page.width - PDF_MARGIN * 2;
  const columnWidth = usable / pairs.length;
  const top = doc.y + 8;
  pairs.forEach(([label, value], i) => {
    const x = PDF_MARGIN + i * columnWidth;
    doc.font('Helvetica').fontSize(8).fillColor('#777').text(label.toUpperCase(), x, top, { width: columnWidth });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(value, x, top + 11, { width: columnWidth });
  });
  doc.y = top + 30;
  doc.x = PDF_MARGIN;
}

function sectionHeading(doc, section) {
  ensureSpace(doc, 70);
  const y = doc.y;
  doc.rect(PDF_MARGIN, y, doc.page.width - PDF_MARGIN * 2, 24).fill('#eef2fb');
  doc.fillColor('#1f3a93').font('Helvetica-Bold').fontSize(11.5)
    .text(section.section_name, PDF_MARGIN + 8, y + 7, { width: doc.page.width - PDF_MARGIN * 2 - 16 });

  const detail = `${section.questions.length} question${section.questions.length === 1 ? '' : 's'} · ` +
    `${section.marks_per_question} mark${section.marks_per_question === 1 ? '' : 's'} each` +
    `${section.negative_marks ? ` · −${section.negative_marks} for a wrong answer` : ''}` +
    `${section.time_limit_minutes ? ` · ${section.time_limit_minutes} min` : ''}`;

  doc.y = y + 24;
  doc.x = PDF_MARGIN;
  doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(detail);
  if (section.section_description) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#666').text(section.section_description);
  }
  doc.fillColor('#111');
}

function answerSpace(doc, lines) {
  doc.moveDown(0.35);
  const width = doc.page.width - PDF_MARGIN * 2 - 20;
  for (let i = 0; i < lines; i += 1) {
    ensureSpace(doc, 24);
    const y = doc.y + 10;
    doc.strokeColor('#d5d9e2').lineWidth(0.6)
      .moveTo(PDF_MARGIN + 20, y).lineTo(PDF_MARGIN + 20 + width, y).stroke();
    doc.y = y + 4;
  }
  doc.strokeColor('#000');
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - PDF_MARGIN - 20) doc.addPage();
}

function pageNumbers(doc, title) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - PDF_MARGIN + 8;
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(truncate(title, 70), PDF_MARGIN, y, { width: 300, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - PDF_MARGIN - 120, y, {
        width: 120, align: 'right', lineBreak: false,
      });
  }
  doc.flushPages();
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export const exportHelpers = { formatAnswer, describeRules };
