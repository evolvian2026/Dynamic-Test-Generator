/**
 * Metadata-driven field registry (spec §15, §28).
 *
 * The filter engine, the smart filter builder UI and the availability checker
 * are all driven by this registry rather than by hard-coded knowledge of
 * "topic / difficulty / question type". Adding a new filterable field is a
 * matter of appending one descriptor here — no SQL, route or UI change.
 *
 * `source` decides how a field is resolved:
 *   column    — a first-class indexed column on `questions`
 *   tag       — the many-to-many `question_tags` table
 *   attribute — the extensible key/value `question_attributes` table
 *   fts       — full-text search over question text
 */

export const OPERATORS = {
  eq: { label: 'is', arity: 'single' },
  neq: { label: 'is not', arity: 'single' },
  in: { label: 'is any of', arity: 'multi' },
  not_in: { label: 'is none of', arity: 'multi' },
  contains: { label: 'contains', arity: 'single' },
  not_contains: { label: 'does not contain', arity: 'single' },
  starts_with: { label: 'starts with', arity: 'single' },
  gt: { label: 'greater than', arity: 'single' },
  gte: { label: 'at least', arity: 'single' },
  lt: { label: 'less than', arity: 'single' },
  lte: { label: 'at most', arity: 'single' },
  between: { label: 'between', arity: 'range' },
  is_set: { label: 'is set', arity: 'none' },
  is_not_set: { label: 'is not set', arity: 'none' },
  has_any: { label: 'has any of', arity: 'multi' },
  has_all: { label: 'has all of', arity: 'multi' },
  has_none: { label: 'has none of', arity: 'multi' },
  matches: { label: 'text matches', arity: 'single' },
};

const TEXT_OPS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'is_set', 'is_not_set'];
const ENUM_OPS = ['in', 'not_in', 'eq', 'neq'];
const NUMBER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_set', 'is_not_set'];
const SET_OPS = ['has_any', 'has_all', 'has_none'];

/** @type {Array<import('./types.js').FieldDescriptor>} */
const FIELDS = [
  {
    key: 'qid',
    label: 'QID',
    source: 'column',
    column: 'qid',
    dataType: 'string',
    operators: TEXT_OPS,
    group: 'Identity',
  },
  {
    key: 'question_type',
    label: 'Question Type',
    source: 'column',
    column: 'question_type',
    dataType: 'enum',
    operators: ENUM_OPS,
    facet: 'question_type',
    multi: true,
    group: 'Classification',
    primary: true,
  },
  {
    key: 'topic',
    label: 'Topic',
    source: 'column',
    column: 'topic',
    dataType: 'enum',
    operators: ENUM_OPS,
    facet: 'topic',
    multi: true,
    group: 'Classification',
    primary: true,
  },
  {
    key: 'subtopic',
    label: 'Subtopic',
    source: 'column',
    column: 'subtopic',
    dataType: 'enum',
    operators: [...ENUM_OPS, 'is_set', 'is_not_set'],
    facet: 'subtopic',
    // Subtopic options are scoped by the selected topic (spec §5).
    cascadesFrom: 'topic',
    multi: true,
    group: 'Classification',
    primary: true,
  },
  {
    key: 'difficulty',
    label: 'Difficulty',
    source: 'column',
    column: 'difficulty',
    dataType: 'enum',
    operators: ENUM_OPS,
    facet: 'difficulty',
    multi: true,
    group: 'Classification',
    primary: true,
    supportsDistribution: true,
  },
  {
    key: 'tags',
    label: 'Tags',
    source: 'tag',
    dataType: 'set',
    operators: SET_OPS,
    facet: 'tag',
    multi: true,
    group: 'Classification',
    primary: true,
  },
  {
    key: 'marks',
    label: 'Marks',
    source: 'column',
    column: 'marks',
    dataType: 'number',
    operators: NUMBER_OPS,
    group: 'Scoring',
  },
  {
    key: 'expected_seconds',
    label: 'Expected Time (seconds)',
    source: 'column',
    column: 'expected_seconds',
    dataType: 'number',
    operators: NUMBER_OPS,
    group: 'Scoring',
  },
  {
    key: 'status',
    label: 'Status',
    source: 'column',
    column: 'status',
    dataType: 'enum',
    operators: ENUM_OPS,
    facet: 'status',
    multi: true,
    group: 'Lifecycle',
  },
  {
    key: 'created_at',
    label: 'Created Date',
    source: 'column',
    column: 'created_at',
    dataType: 'date',
    operators: ['gt', 'gte', 'lt', 'lte', 'between'],
    group: 'Lifecycle',
  },
  {
    key: 'question_text',
    label: 'Question Text',
    source: 'fts',
    dataType: 'text',
    operators: ['matches', 'contains', 'not_contains'],
    group: 'Content',
  },
];

/**
 * Extensible attribute-backed fields (spec §28). These live in
 * `question_attributes`, so new entries here are immediately filterable,
 * sortable in the bank explorer and usable in section rules.
 */
const ATTRIBUTE_FIELDS = [
  ['company', 'Company', 'enum', 'Context'],
  ['course', 'Course', 'enum', 'Context'],
  ['university', 'University', 'enum', 'Context'],
  ['batch', 'Batch', 'enum', 'Context'],
  ['language', 'Language', 'enum', 'Context'],
  ['skill', 'Skill', 'enum', 'Pedagogy'],
  ['learning_outcome', 'Learning Outcome', 'enum', 'Pedagogy'],
  ['cognitive_level', 'Cognitive Level', 'enum', 'Pedagogy'],
  ['bloom_taxonomy', "Bloom's Taxonomy", 'enum', 'Pedagogy'],
  ['exam', 'Exam', 'enum', 'Provenance'],
  ['source', 'Source', 'enum', 'Provenance'],
  ['author', 'Author', 'enum', 'Provenance'],
  ['year', 'Year', 'number', 'Provenance'],
  ['usage_count', 'Previous Usage Count', 'number', 'Quality'],
  ['success_rate', 'Average Success Rate', 'number', 'Quality'],
  ['quality_score', 'Quality Score', 'number', 'Quality'],
  ['avg_time_taken', 'Average Time Taken (s)', 'number', 'Quality'],
];

for (const [key, label, dataType, group] of ATTRIBUTE_FIELDS) {
  FIELDS.push({
    key,
    label,
    source: 'attribute',
    attrKey: key,
    dataType,
    operators: dataType === 'number' ? NUMBER_OPS : [...ENUM_OPS, 'is_set', 'is_not_set'],
    facet: dataType === 'enum' ? 'attribute' : undefined,
    multi: dataType === 'enum',
    group,
    extended: true,
  });
}

const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]));

export function listFields() {
  return FIELDS;
}

export function getField(key) {
  return FIELD_MAP.get(key) || null;
}

export function isKnownField(key) {
  return FIELD_MAP.has(key);
}

/** Fields the section rule builder offers as "quick filters". */
export function primaryFields() {
  return FIELDS.filter((f) => f.primary);
}

/** Canonical question types. New types are accepted without a code change —
 *  this list only seeds the UI; the engine never validates against it. */
export const KNOWN_QUESTION_TYPES = [
  'MCQ',
  'Multiple Select',
  'Coding',
  'Fill in the Blank',
  'True/False',
  'Subjective',
  'SQL',
  'Output-based',
  'Debugging',
];

export const DIFFICULTY_LEVELS = ['Easy', 'Medium', 'Hard'];
export const QUESTION_STATUSES = ['active', 'draft', 'retired', 'review'];

/** Types for which "randomize options" is meaningful (spec §10). */
export const OPTION_BEARING_TYPES = new Set(['MCQ', 'Multiple Select', 'True/False']);
