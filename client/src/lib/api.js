/** Thin API client. Every call is same-origin and carries the session cookie. */

class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (raw) {
    if (!response.ok) throw new ApiError('Download failed', response.status);
    return response;
  }

  const text = await response.text();
  const data = text ? safeParse(text) : null;

  if (!response.ok) {
    throw new ApiError(
      data?.error?.message || `Request failed (${response.status})`,
      response.status,
      data?.error?.details,
    );
  }
  return data;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const get = (path, options) => request(path, options);
const post = (path, body, options) => request(path, { ...options, method: 'POST', body });
const patch = (path, body) => request(path, { method: 'PATCH', body });
const put = (path, body) => request(path, { method: 'PUT', body });
const del = (path) => request(path, { method: 'DELETE' });

export const api = {
  ApiError,

  auth: {
    login: (email, password) => post('/auth/login', { email, password }),
    logout: () => post('/auth/logout'),
    me: () => get('/auth/me'),
    changePassword: (currentPassword, newPassword) => post('/auth/change-password', { currentPassword, newPassword }),
  },

  questions: {
    metadata: () => get('/questions/metadata'),
    statistics: () => get('/questions/statistics'),
    taxonomy: (withCounts = true) => get(`/questions/taxonomy?withCounts=${withCounts}`),
    /** `parent` may be a list — areas cascade from subjects, sub-areas from areas. */
    facet: (dimension, parent = '') => {
      const value = Array.isArray(parent) ? parent.join(',') : parent;
      return get(`/questions/facets/${dimension}?parent=${encodeURIComponent(value)}`);
    },
    tags: (q = '', { subjects = [], areas = [], source } = {}) => {
      const params = new URLSearchParams({ q });
      if (subjects.length) params.set('subject', subjects.join(','));
      if (areas.length) params.set('area', areas.join(','));
      if (source) params.set('source', source);
      return get(`/questions/tags?${params}`);
    },
    search: (payload, signal) => post('/questions/search', payload, { signal }),
    count: (payload, signal) => post('/questions/count', payload, { signal }),
    lookup: (qids, withAnswers = false) => post('/questions/lookup', { qids, withAnswers }),
    byQid: (qid, withAnswers = false) => get(`/questions/${encodeURIComponent(qid)}?withAnswers=${withAnswers}`),

    // Authoring
    create: (payload) => post('/questions', payload),
    update: (qid, payload) => patch(`/questions/${encodeURIComponent(qid)}`, payload),
    retire: (qid) => del(`/questions/${encodeURIComponent(qid)}`),
    remove: (qid) => del(`/questions/${encodeURIComponent(qid)}?hard=true`),

    // Bulk import
    importTemplate: () => get('/questions/import/template'),
    importPreview: (rows, options = {}) => post('/questions/import/preview', { rows, ...options }),
    importCommit: (items, options = {}) => post('/questions/import/commit', { items, ...options }),

    // Near-duplicates
    duplicates: (params = {}) => get(`/questions/duplicates?${new URLSearchParams(params)}`),
    reindexDuplicates: () => post('/questions/duplicates/reindex', {}),
    similar: (qid, params = {}) => get(`/questions/${encodeURIComponent(qid)}/similar?${new URLSearchParams(params)}`),

    // Exposure
    exposureOverview: (params = {}) => get(`/questions/exposure/overview?${new URLSearchParams(params)}`),
    usage: (qid) => get(`/questions/${encodeURIComponent(qid)}/usage`),

    // Item analytics
    analytics: (qid) => get(`/questions/${encodeURIComponent(qid)}/analytics`),
  },

  sets: {
    list: () => get('/sets'),
    get: (id) => get(`/sets/${id}`),
    questions: (id, params = {}) => get(`/sets/${id}/questions?${new URLSearchParams(params)}`),
    create: (payload) => post('/sets', payload),
    update: (id, payload) => put(`/sets/${id}`, payload),
    remove: (id) => del(`/sets/${id}`),
  },

  results: {
    ingestAttempts: (testId, attempts) => post(`/results/tests/${testId}/attempts`, { attempts }),
    ingestRows: (testId, rows) => post(`/results/tests/${testId}/responses`, { rows }),
    forTest: (testId) => get(`/results/tests/${testId}/results`),
    clear: (testId) => del(`/results/tests/${testId}/attempts`),
    itemOverview: (params = {}) => get(`/results/items/overview?${new URLSearchParams(params)}`),
    recompute: () => post('/results/items/recompute', {}),
  },

  settings: {
    get: () => get('/settings'),
    update: (payload) => put('/settings', payload),
  },

  tests: {
    list: (params = {}) => get(`/tests?${new URLSearchParams(params)}`),
    get: (id, params = {}) => get(`/tests/${id}?${new URLSearchParams(params)}`),
    create: (payload) => post('/tests', payload),
    update: (id, payload) => patch(`/tests/${id}`, payload),
    remove: (id) => del(`/tests/${id}`),
    archive: (id) => post(`/tests/${id}/archive`),
    duplicate: (id, name) => post(`/tests/${id}/duplicate`, name ? { name } : {}),
    regenerate: (id, seed) => post(`/tests/${id}/regenerate`, { seed: seed || null }),
    versions: (id, payload) => post(`/tests/${id}/versions`, payload),
    listVersions: (id) => get(`/tests/${id}/versions`),
    availability: (sections, preventDuplicates = true, signal) =>
      post('/tests/availability', { sections, preventDuplicates }, { signal }),
    sectionAvailability: (section, excludeQids = [], signal) =>
      post('/tests/availability/section', { section, excludeQids }, { signal }),
    validate: (test, sections) => post('/tests/validate', { test, sections }),
    preview: (payload) => post('/tests/preview', payload),
    replacements: (id, testQuestionId, limit = 20) =>
      get(`/tests/${id}/questions/${testQuestionId}/replacements?limit=${limit}`),
    replace: (id, testQuestionId, qid) => post(`/tests/${id}/questions/${testQuestionId}/replace`, { qid }),
    explain: (id, testQuestionId) => get(`/tests/${id}/questions/${testQuestionId}/explain`),
    addQuestions: (id, sectionId, qids) => post(`/tests/${id}/sections/${sectionId}/questions`, { qids }),
    removeQuestion: (id, testQuestionId) => del(`/tests/${id}/questions/${testQuestionId}`),
    moveQuestion: (id, testQuestionId, sectionId) => post(`/tests/${id}/questions/${testQuestionId}/move`, { sectionId }),
    reorder: (id, sectionId, orderedIds) => post(`/tests/${id}/sections/${sectionId}/reorder`, { orderedIds }),

    // Review workflow
    submitForReview: (id, note) => post(`/tests/${id}/submit-review`, { note: note || null }),
    approve: (id, note) => post(`/tests/${id}/approve`, { note: note || null }),
    reject: (id, note) => post(`/tests/${id}/reject`, { note: note || null }),
    publish: (id) => post(`/tests/${id}/publish`, {}),

    // Coverage and duplicate warnings
    coverage: (id, axis = 'difficulty') => get(`/tests/${id}/coverage?axis=${encodeURIComponent(axis)}`),
    coverageAxes: (id) => get(`/tests/${id}/coverage/axes`),
    duplicateWarnings: (id) => get(`/tests/${id}/duplicate-warnings`),
  },

  templates: {
    list: () => get('/templates'),
    get: (id) => get(`/templates/${id}`),
    create: (payload) => post('/templates', payload),
    update: (id, payload) => put(`/templates/${id}`, payload),
    remove: (id) => del(`/templates/${id}`),
    blueprints: () => get('/templates/blueprints'),
    expandBlueprint: (payload) => post('/templates/blueprints/expand', payload),
  },

  analytics: {
    overview: () => get('/analytics/overview'),
    test: (id) => get(`/analytics/tests/${id}`),
    audit: (limit = 100) => get(`/analytics/audit?limit=${limit}`),
  },

  users: {
    list: () => get('/users'),
    roles: () => get('/users/roles'),
    create: (payload) => post('/users', payload),
    update: (id, payload) => patch(`/users/${id}`, payload),
  },

  /** Export URLs are plain links so the browser handles the download. */
  exportUrl: (id, format, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return `/api/exports/${id}/${format}${query ? `?${query}` : ''}`;
  },
};

export default api;
