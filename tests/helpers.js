/**
 * Test harness: every suite runs against a throwaway on-disk database that is
 * migrated and seeded from scratch, so tests never touch a real bank.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtg-test-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-used-in-production';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Admin@12345';

const { seed } = await import('../server/db/seed.js');
const { createApp } = await import('../server/app.js');
const { closeDb } = await import('../server/db/index.js');

seed({ count: 4000, seed: 'TEST-BANK', quiet: true });

export const app = createApp();
export { closeDb };

/** Starts the app on an ephemeral port and returns a small fetch wrapper. */
export async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (method, url, { body, token } = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: response.status, body: data, headers: response.headers, text };
  };

  return {
    base,
    server,
    get: (url, options) => request('GET', url, options),
    post: (url, body, options) => request('POST', url, { ...options, body }),
    patch: (url, body, options) => request('PATCH', url, { ...options, body }),
    del: (url, options) => request('DELETE', url, options),
    raw: (url, options = {}) => fetch(`${base}${url}`, {
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
    }),
    async login(email = 'admin@test.local', password = 'Admin@12345') {
      const result = await request('POST', '/api/auth/login', { body: { email, password } });
      if (result.status !== 200) throw new Error(`Login failed: ${JSON.stringify(result.body)}`);
      return result.body.token;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function cleanup() {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A valid three-section test payload used by several suites. */
export const sampleTest = () => ({
  test: {
    test_name: 'Advanced DSA Assessment',
    description: 'End-to-end scenario from the specification',
    course: 'Data Structures',
    duration_minutes: 90,
    instructions: 'Answer all questions.',
    status: 'draft',
    randomize_questions: true,
    randomize_options: true,
    prevent_duplicates: true,
    include_qid_in_student: false,
    random_seed: 'DSA2026',
  },
  mode: 'automatic',
  allowPartial: true,
  sections: [
    {
      section_name: 'Arrays',
      question_count: 6,
      marks_per_question: 2,
      negative_marks: 0.5,
      rule: { question_type: ['MCQ'], topic: ['Arrays'] },
    },
    {
      section_name: 'Coding',
      question_count: 2,
      marks_per_question: 10,
      negative_marks: 0,
      rule: { question_type: ['Coding'] },
    },
    {
      section_name: 'Trees',
      question_count: 3,
      marks_per_question: 2,
      negative_marks: 0,
      rule: { question_type: ['Multiple Select'], topic: ['Trees'] },
    },
  ],
});
