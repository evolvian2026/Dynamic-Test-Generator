/** Exports (spec §19): JSON, CSV, Excel, student PDF and answer key. */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, cleanup, sampleTest } from './helpers.js';
import { extractPdfText } from './pdfText.js';

let http;
let token;
let testId;

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
};

before(async () => {
  http = await startServer();
  token = await http.login();
  const created = await http.post('/api/tests', sampleTest(), { token });
  testId = created.body.id;
});

after(async () => {
  await http.close();
  cleanup();
});

test('JSON export carries the full structure and the answer key', async () => {
  const result = await http.get(`/api/exports/${testId}/json`, { token });
  assert.equal(result.status, 200);

  const data = result.body;
  assert.equal(data.test.test_name, 'Advanced DSA Assessment');
  assert.equal(data.sections.length, 3);
  assert.equal(data.summary.totalQuestions, 11);

  const questions = data.sections.flatMap((s) => s.questions);
  assert.equal(questions.length, 11);
  assert.ok(questions.every((q) => q.qid && q.question_text && q.question_type));
  // The selection rule travels with the export so a test is auditable offline.
  assert.ok(questions.every((q) => q.selection_reason));
});

test('CSV export is well formed and quotes embedded separators', async () => {
  const response = await http.raw(`/api/exports/${testId}/csv`, { token });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename=/);

  const text = await response.text();
  const lines = text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 12, 'a header row plus one row per question');
  assert.match(lines[0], /^test_id,test_name,section,question_number,qid/);
  assert.ok(lines[0].includes('correct_answer'));

  // Every data row must expose the same number of top-level fields.
  const columns = (line) => {
    let count = 1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') i += 1;
        else inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) count += 1;
    }
    return count;
  };
  const expected = columns(lines[0]);
  for (const line of lines.slice(1)) assert.equal(columns(line), expected);
});

test('Excel export is a valid workbook with the expected sheets', async () => {
  const response = await http.raw(`/api/exports/${testId}/xlsx`, { token });
  assert.equal(response.status, 200);
  const buffer = Buffer.from(await response.arrayBuffer());

  // XLSX files are ZIP archives — check the magic bytes and read it back.
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const names = workbook.worksheets.map((s) => s.name);
  assert.deepEqual(names, ['Summary', 'Sections', 'Questions', 'Answer Key']);
  assert.equal(workbook.getWorksheet('Questions').rowCount, 12, 'header plus 11 questions');
  assert.equal(workbook.getWorksheet('Answer Key').rowCount, 12);
  assert.equal(workbook.getWorksheet('Sections').rowCount, 4, 'header plus 3 sections');
});

test('the student PDF contains the paper and never the answers', async () => {
  const { toStudentPdf } = await import('../server/services/exportService.js');
  const { getTest } = await import('../server/services/testService.js');

  const pdf = await collect(toStudentPdf(testId, { includeQid: false }));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');

  const text = extractPdfText(pdf);
  assert.match(text, /Advanced DSA Assessment/, 'the title must be rendered');
  assert.match(text, /Instructions/);
  assert.match(text, /Operating Systems/, 'section headings are rendered');
  assert.match(text, /Coding/);
  assert.match(text, /Databases/);
  assert.match(text, /Q1\./, 'questions must be numbered');
  assert.match(text, /Q11\./, 'every question must appear');

  // No answer key content may leak into the student paper.
  const stored = getTest(testId, { withAnswers: true });
  const answers = stored.sections
    .flatMap((s) => s.questions)
    .flatMap((entry) => (entry.question.options || []).filter((o) => o.is_correct).map((o) => o.option_text));
  assert.ok(answers.length > 0, 'the fixture should include option-bearing questions');
  assert.ok(!text.includes('Explanation:'), 'explanations belong to the answer key only');
  assert.ok(!/Answer:/.test(text), 'the student paper must not print answers');
});

test('the QID toggle controls whether QIDs appear on the paper', async () => {
  const { toStudentPdf } = await import('../server/services/exportService.js');
  const { getTest } = await import('../server/services/testService.js');
  const firstQid = getTest(testId).sections[0].questions[0].qid;

  const without = extractPdfText(await collect(toStudentPdf(testId, { includeQid: false })));
  const with_ = extractPdfText(await collect(toStudentPdf(testId, { includeQid: true })));

  assert.ok(!without.includes(firstQid), 'QIDs must be hidden when the toggle is off');
  assert.ok(with_.includes(firstQid), 'QIDs must be printed when the toggle is on');
});

test('the answer key is a separate document and is not served to viewers', async () => {
  const key = await http.raw(`/api/exports/${testId}/answer-key.pdf`, { token });
  assert.equal(key.status, 200);
  assert.equal(key.headers.get('content-type'), 'application/pdf');
  const buffer = Buffer.from(await key.arrayBuffer());
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');

  // The key carries the QID, the answer and the full metadata line (spec §19).
  const { getTest } = await import('../server/services/testService.js');
  const stored = getTest(testId);
  const text = extractPdfText(buffer);
  assert.match(text, /Answer Key/);
  assert.match(text, /Answer:/);
  // The key carries the full taxonomy path for each question.
  assert.match(text, /Marks:.*Difficulty:.*Subject:.*Area:/s);
  assert.ok(text.includes(stored.sections[0].questions[0].qid), 'the key always identifies the QID');

  const viewerToken = await http.login('viewer@example.com', 'Viewer@12345');
  const denied = await http.raw(`/api/exports/${testId}/answer-key.pdf`, { token: viewerToken });
  assert.equal(denied.status, 403, 'viewers must never receive answers');
});

test('a viewer\'s CSV export omits the answer columns', async () => {
  const viewerToken = await http.login('viewer@example.com', 'Viewer@12345');
  const response = await http.raw(`/api/exports/${testId}/csv`, { token: viewerToken });
  assert.equal(response.status, 200);
  const header = (await response.text()).replace(/^﻿/, '').split('\r\n')[0];
  assert.ok(!header.includes('correct_answer'));
});

test('CSV neutralises spreadsheet formula injection', async () => {
  const { toCsv } = await import('../server/services/exportService.js');
  const { createTest } = await import('../server/services/testService.js');

  // A test name that a spreadsheet would execute on open.
  const payload = '=cmd|\'/c calc\'!A1';
  const created = createTest({
    user: { id: 1, role: 'admin' },
    test: { test_name: payload, duration_minutes: 30, status: 'draft' },
    sections: [{ section_name: '+1+1', question_count: 2, marks_per_question: 1, rule: { question_type: ['MCQ'] } }],
    mode: 'automatic',
    allowPartial: true,
  });

  const csv = toCsv(created.id);
  const [header, first] = csv.trim().split('\r\n');
  const columns = header.split(',');

  // Parse the row honouring quotes, then check no cell starts a formula.
  const cells = [];
  let buffer = '';
  let inQuotes = false;
  for (let i = 0; i < first.length; i += 1) {
    const char = first[i];
    if (char === '"') {
      if (inQuotes && first[i + 1] === '"') { buffer += '"'; i += 1; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) { cells.push(buffer); buffer = ''; }
    else buffer += char;
  }
  cells.push(buffer);

  assert.ok(!cells.some((c) => /^[=+@]/.test(c)), 'no cell may begin a formula');
  const nameCell = cells[columns.indexOf('test_name')];
  assert.ok(nameCell.startsWith('\t'), 'the payload is prefixed, not executed');
  assert.ok(nameCell.includes(payload), 'the original text is preserved for the reader');

  // Plain numbers must not be mangled by the guard.
  assert.equal(cells[columns.indexOf('question_number')], '1');
  assert.equal(cells[columns.indexOf('marks')], '1');
});

test('exporting a test that does not exist returns 404', async () => {
  const result = await http.get('/api/exports/999999/json', { token });
  assert.equal(result.status, 404);
});
