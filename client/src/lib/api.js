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
    facet: (dimension, parent = '') => get(`/questions/facets/${dimension}?parent=${encodeURIComponent(parent)}`),
    tags: (q = '') => get(`/questions/tags?q=${encodeURIComponent(q)}`),
    search: (payload, signal) => post('/questions/search', payload, { signal }),
    count: (payload, signal) => post('/questions/count', payload, { signal }),
    lookup: (qids, withAnswers = false) => post('/questions/lookup', { qids, withAnswers }),
    byQid: (qid, withAnswers = false) => get(`/questions/${encodeURIComponent(qid)}?withAnswers=${withAnswers}`),
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
