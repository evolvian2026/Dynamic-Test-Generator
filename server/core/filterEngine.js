/**
 * Filter engine (spec §5, §15, §25).
 *
 * Compiles a metadata-driven filter description into a parameterised SQL
 * predicate over `questions q`. Two input shapes are accepted and both
 * normalise to the same boolean tree:
 *
 *   Simple rule  { question_type: ['MCQ'], topic: ['Arrays'], excludeTags: [...] }
 *   Filter tree  { op: 'AND', children: [ { field, operator, value }, { op: 'NOT', ... } ] }
 *
 * The tree supports arbitrary nesting of AND / OR / NOT, which is what the
 * Smart Filter Builder emits. Every value is bound as a parameter — no user
 * input is ever interpolated into SQL.
 */

import { getField } from './metadata.js';
import { resolveIds } from './taxonomy.js';

export class FilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilterError';
    this.status = 400;
  }
}

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (m) => `\\${m}`);

/* ------------------------------------------------------------------ *
 * Normalisation: simple rule object -> boolean tree
 * ------------------------------------------------------------------ */

const TAXONOMY_LEVELS = ['subject', 'area', 'sub_area'];

const SIMPLE_TO_LEAF = {
  question_type: { field: 'question_type', operator: 'in' },
  difficulty: { field: 'difficulty', operator: 'in' },
  status: { field: 'status', operator: 'in' },
  includeTags: { field: 'tags', operator: 'has_any' },
  includeAllTags: { field: 'tags', operator: 'has_all' },
  excludeTags: { field: 'tags', operator: 'has_none' },
  qid: { field: 'qid', operator: 'in' },
};

/**
 * Converts the "quick filter" shape used by section rules into a filter tree.
 * Unknown keys that match a registered metadata field are also honoured, so
 * future fields work without touching this function.
 */
export function normalizeRule(rule = {}) {
  const children = [];

  // Taxonomy levels are combined into ONE constraint rather than one per
  // level. Area names are not globally unique — "Arrays and Strings" exists
  // under four different subjects — so "Subject = X AND Area = Y" has to be
  // satisfied by a single branch of a question's classification. Emitting a
  // separate EXISTS per level would let a question mapped to X > something
  // and Z > Y satisfy both halves and match a branch it does not have.
  const taxonomy = {};
  for (const level of TAXONOMY_LEVELS) {
    const values = asArray(rule[level]).filter((v) => v !== '' && v !== null && v !== undefined);
    if (values.length) taxonomy[level] = values;
  }
  if (Object.keys(taxonomy).length) children.push({ taxonomy });

  for (const [key, mapping] of Object.entries(SIMPLE_TO_LEAF)) {
    const values = asArray(rule[key]).filter((v) => v !== '' && v !== null && v !== undefined);
    if (values.length > 0) children.push({ field: mapping.field, operator: mapping.operator, value: values });
  }

  if (rule.search) {
    children.push({ field: 'question_text', operator: 'matches', value: rule.search });
  }

  if (rule.marksMin !== undefined && rule.marksMin !== null && rule.marksMin !== '') {
    children.push({ field: 'marks', operator: 'gte', value: Number(rule.marksMin) });
  }
  if (rule.marksMax !== undefined && rule.marksMax !== null && rule.marksMax !== '') {
    children.push({ field: 'marks', operator: 'lte', value: Number(rule.marksMax) });
  }

  // Extended / future metadata fields passed through an `attributes` bag.
  for (const [key, value] of Object.entries(rule.attributes || {})) {
    const values = asArray(value).filter((v) => v !== '' && v !== null && v !== undefined);
    if (!values.length) continue;
    const field = getField(key);
    if (!field) continue;
    children.push({ field: key, operator: field.dataType === 'number' ? 'eq' : 'in', value: values });
  }

  // A user-authored advanced tree is ANDed with the quick filters.
  if (rule.advanced && (rule.advanced.op || rule.advanced.field)) {
    children.push(rule.advanced);
  }

  return { op: 'AND', children };
}

/** Accepts either shape and always returns a boolean tree. */
export function toTree(filter) {
  if (!filter) return { op: 'AND', children: [] };
  if (filter.op || filter.field) return filter;
  return normalizeRule(filter);
}

/* ------------------------------------------------------------------ *
 * Compilation: boolean tree -> SQL
 * ------------------------------------------------------------------ */

function compileLeaf(leaf, params) {
  const field = getField(leaf.field);
  if (!field) throw new FilterError(`Unknown filter field: "${leaf.field}"`);

  const operator = leaf.operator || (field.dataType === 'number' ? 'eq' : 'in');
  if (!field.operators.includes(operator)) {
    throw new FilterError(`Operator "${operator}" is not valid for field "${field.key}"`);
  }

  const values = asArray(leaf.value);
  const needsValue = !['is_set', 'is_not_set'].includes(operator);
  if (needsValue && values.length === 0) {
    throw new FilterError(`Filter on "${field.key}" requires a value`);
  }

  switch (field.source) {
    case 'column':
      return compileColumn(field, operator, values, params);
    case 'taxonomy':
      return compileTaxonomy(field, operator, values, params);
    case 'tag':
      return compileTag(operator, values, params);
    case 'attribute':
      return compileAttribute(field, operator, values, params);
    case 'fts':
      return compileFts(operator, values, params);
    default:
      throw new FilterError(`Unsupported field source: ${field.source}`);
  }
}

function compileColumn(field, operator, values, params) {
  const col = `q.${field.column}`;
  const push = (v) => {
    params.push(field.dataType === 'number' ? Number(v) : v);
    return '?';
  };

  switch (operator) {
    case 'eq': return `${col} = ${push(values[0])}`;
    case 'neq': return `(${col} IS NULL OR ${col} <> ${push(values[0])})`;
    case 'in': return `${col} IN (${values.map(push).join(', ')})`;
    case 'not_in': return `(${col} IS NULL OR ${col} NOT IN (${values.map(push).join(', ')}))`;
    case 'contains': params.push(`%${escapeLike(values[0])}%`); return `${col} LIKE ? ESCAPE '\\'`;
    case 'not_contains': params.push(`%${escapeLike(values[0])}%`); return `(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`;
    case 'starts_with': params.push(`${escapeLike(values[0])}%`); return `${col} LIKE ? ESCAPE '\\'`;
    case 'gt': return `${col} > ${push(values[0])}`;
    case 'gte': return `${col} >= ${push(values[0])}`;
    case 'lt': return `${col} < ${push(values[0])}`;
    case 'lte': return `${col} <= ${push(values[0])}`;
    case 'between': {
      if (values.length < 2) throw new FilterError(`"between" on ${field.key} needs two values`);
      return `${col} BETWEEN ${push(values[0])} AND ${push(values[1])}`;
    }
    case 'is_set': return `(${col} IS NOT NULL AND ${col} <> '')`;
    case 'is_not_set': return `(${col} IS NULL OR ${col} = '')`;
    default: throw new FilterError(`Unsupported operator "${operator}"`);
  }
}

/**
 * Compiles a Subject / Area / Sub-Area predicate.
 *
 * A question matches when ANY of its taxonomy mappings satisfies the
 * constraint, which is the natural reading of a multi-mapped QID: a question
 * filed under both "Operating System > Memory Management" and
 * "Computer Architecture > Memory Hierarchy" is found by either.
 *
 * Names are resolved to ids up front against the cached taxonomy index, so the
 * generated SQL is an indexed EXISTS over `question_taxonomy` with no joins.
 */
/**
 * Compiles several taxonomy levels as one constraint on a single mapping row.
 *
 * "Subject = Operating System AND Area = Process Management" becomes one
 * EXISTS over `question_taxonomy` with both conditions on the same row, so a
 * question filed under Linux > Process Management is not matched merely
 * because it also happens to carry an unrelated Operating System branch.
 */
function compileTaxonomyGroup(constraints, params) {
  const columns = { subject: 'subject_id', area: 'area_id', sub_area: 'sub_area_id' };
  const conditions = [];

  for (const [level, values] of Object.entries(constraints)) {
    const ids = resolveIds(level, values);
    // An unresolvable name must exclude everything rather than be ignored.
    if (!ids.length) return '1 = 0';
    conditions.push(`qt.${columns[level]} IN (${ids.map((id) => { params.push(id); return '?'; }).join(', ')})`);
  }

  if (!conditions.length) return '1 = 1';
  // `IN (SELECT ...)` rather than a correlated EXISTS: it lets SQLite build the
  // matching question set once from the (level_id, question_id) index instead
  // of probing per candidate row. On a 300k bank that is ~11 ms versus ~72 ms.
  return `q.id IN (SELECT qt.question_id FROM question_taxonomy qt WHERE ${conditions.join(' AND ')})`;
}

function compileTaxonomy(field, operator, values, params) {
  const column = { subject: 'subject_id', area: 'area_id', sub_area: 'sub_area_id' }[field.level];
  const exists = (inner) =>
    `q.id IN (SELECT qt.question_id FROM question_taxonomy qt WHERE ${inner})`;

  if (operator === 'is_set') return exists(`qt.${column} IS NOT NULL`);
  if (operator === 'is_not_set') return `NOT (${exists(`qt.${column} IS NOT NULL`)})`;

  const ids = resolveIds(field.level, values);
  if (!ids.length) {
    // A name that is not in the taxonomy must exclude everything rather than
    // silently dropping the constraint — otherwise a typo would widen the
    // result set instead of narrowing it.
    return operator === 'neq' || operator === 'not_in' ? '1 = 1' : '1 = 0';
  }

  const placeholders = ids.map((id) => { params.push(id); return '?'; }).join(', ');
  const membership = exists(`qt.${column} IN (${placeholders})`);

  switch (operator) {
    case 'eq':
    case 'in':
      return membership;
    case 'neq':
    case 'not_in':
      return `NOT (${membership})`;
    default:
      throw new FilterError(`Operator "${operator}" is not valid for ${field.label}`);
  }
}

function compileTag(operator, values, params) {
  // Same rationale as the taxonomy compiler: driving from the (tag, question_id)
  // index is much cheaper than a correlated probe per candidate row.
  const matches = (placeholders) =>
    `q.id IN (SELECT t.question_id FROM question_tags t WHERE t.tag IN (${placeholders}))`;

  switch (operator) {
    case 'has_any': {
      const ph = values.map((v) => { params.push(v); return '?'; }).join(', ');
      return matches(ph);
    }
    case 'has_all':
      // One membership test per tag: every one must hold.
      return `(${values
        .map((v) => { params.push(v); return matches('?'); })
        .join(' AND ')})`;
    case 'has_none': {
      const ph = values.map((v) => { params.push(v); return '?'; }).join(', ');
      return `NOT (${matches(ph)})`;
    }
    default:
      throw new FilterError(`Unsupported tag operator "${operator}"`);
  }
}

function compileAttribute(field, operator, values, params) {
  const numeric = field.dataType === 'number';
  const valueCol = numeric ? 'a.num_value' : 'a.attr_value';
  const wrap = (inner) =>
    `EXISTS (SELECT 1 FROM question_attributes a WHERE a.question_id = q.id AND a.attr_key = ? AND ${inner})`;
  const negate = (inner) =>
    `NOT EXISTS (SELECT 1 FROM question_attributes a WHERE a.question_id = q.id AND a.attr_key = ? AND ${inner})`;

  const bind = (v) => { params.push(numeric ? Number(v) : v); return '?'; };

  // attr_key is always the first bound parameter of the subquery.
  const withKey = (build, negated = false) => {
    params.push(field.attrKey);
    const inner = build();
    return negated ? negate(inner) : wrap(inner);
  };

  switch (operator) {
    case 'eq': return withKey(() => `${valueCol} = ${bind(values[0])}`);
    case 'neq': return withKey(() => `${valueCol} = ${bind(values[0])}`, true);
    case 'in': return withKey(() => `${valueCol} IN (${values.map(bind).join(', ')})`);
    case 'not_in': return withKey(() => `${valueCol} IN (${values.map(bind).join(', ')})`, true);
    case 'gt': return withKey(() => `${valueCol} > ${bind(values[0])}`);
    case 'gte': return withKey(() => `${valueCol} >= ${bind(values[0])}`);
    case 'lt': return withKey(() => `${valueCol} < ${bind(values[0])}`);
    case 'lte': return withKey(() => `${valueCol} <= ${bind(values[0])}`);
    case 'between': {
      if (values.length < 2) throw new FilterError(`"between" on ${field.key} needs two values`);
      return withKey(() => `${valueCol} BETWEEN ${bind(values[0])} AND ${bind(values[1])}`);
    }
    case 'contains': return withKey(() => { params.push(`%${escapeLike(values[0])}%`); return `a.attr_value LIKE ? ESCAPE '\\'`; });
    case 'not_contains': return withKey(() => { params.push(`%${escapeLike(values[0])}%`); return `a.attr_value LIKE ? ESCAPE '\\'`; }, true);
    case 'is_set': return withKey(() => '1 = 1');
    case 'is_not_set': return withKey(() => '1 = 1', true);
    default: throw new FilterError(`Unsupported attribute operator "${operator}"`);
  }
}

/** Turns free text into a safe FTS5 prefix query (quotes each token). */
export function toFtsQuery(text) {
  const tokens = String(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

function compileFts(operator, values, params) {
  const raw = String(values[0] ?? '');

  if (operator === 'contains' || operator === 'not_contains') {
    params.push(`%${escapeLike(raw)}%`);
    return operator === 'contains'
      ? `q.question_text LIKE ? ESCAPE '\\'`
      : `q.question_text NOT LIKE ? ESCAPE '\\'`;
  }

  const query = toFtsQuery(raw);
  if (!query) return '1 = 1';
  params.push(query);
  return `q.id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?)`;
}

function compileNode(node, params, depth = 0) {
  if (depth > 12) throw new FilterError('Filter nesting is too deep (max 12 levels)');
  if (!node) return '1 = 1';

  if (node.taxonomy) return compileTaxonomyGroup(node.taxonomy, params);
  if (node.field) return compileLeaf(node, params);

  const op = String(node.op || 'AND').toUpperCase();
  const children = Array.isArray(node.children) ? node.children.filter(Boolean) : [];

  if (op === 'NOT') {
    if (!children.length) return '1 = 1';
    const inner = children.map((c) => compileNode(c, params, depth + 1)).join(' AND ');
    return `NOT (${inner})`;
  }

  if (op !== 'AND' && op !== 'OR') throw new FilterError(`Unknown logical operator "${node.op}"`);
  if (!children.length) return op === 'AND' ? '1 = 1' : '1 = 0';

  return `(${children.map((c) => compileNode(c, params, depth + 1)).join(` ${op} `)})`;
}

/**
 * Compiles a filter into `{ where, params }` for use against `questions q`.
 *
 * @param {object} filter        simple rule object or boolean tree
 * @param {object} [options]
 * @param {string[]} [options.excludeQids]  QIDs already used elsewhere in the test
 * @param {boolean} [options.activeOnly]    restrict to active questions (default true)
 */
export function compileFilter(filter, options = {}) {
  const { excludeQids = [], activeOnly = true } = options;
  const params = [];
  const clauses = [];

  const tree = toTree(filter);
  const compiled = compileNode(tree, params);
  if (compiled !== '1 = 1') clauses.push(compiled);

  const mentionsStatus = JSON.stringify(tree).includes('"status"');
  if (activeOnly && !mentionsStatus) clauses.push(`q.status = 'active'`);

  if (excludeQids.length) {
    // Chunked so we never exceed SQLite's variable limit on large tests.
    for (let i = 0; i < excludeQids.length; i += 400) {
      const chunk = excludeQids.slice(i, i + 400);
      clauses.push(`q.qid NOT IN (${chunk.map(() => '?').join(', ')})`);
      params.push(...chunk);
    }
  }

  return { where: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
}

/* ------------------------------------------------------------------ *
 * Explainability (spec §25)
 * ------------------------------------------------------------------ */

/** Human-readable description of a single leaf predicate. */
export function describeLeaf(leaf) {
  const field = getField(leaf.field);
  const label = field ? field.label : leaf.field;
  const operator = leaf.operator || 'in';
  const opLabel = { eq: '=', neq: '≠', in: '=', not_in: 'not in', has_any: 'includes any of',
    has_all: 'includes all of', has_none: 'does not contain', contains: 'contains',
    not_contains: 'does not contain', starts_with: 'starts with', gt: '>', gte: '≥',
    lt: '<', lte: '≤', between: 'between', is_set: 'is set', is_not_set: 'is not set',
    matches: 'matches' }[operator] || operator;
  const values = asArray(leaf.value);
  const valueLabel = values.length ? values.join(', ') : '';
  return `${label} ${opLabel}${valueLabel ? ` ${valueLabel}` : ''}`;
}

/**
 * Evaluates a filter tree against an already-loaded question and returns a
 * flat list of `{ criterion, passed }` — the data behind
 * "Why was this question selected?".
 */
export function explainMatch(filter, question) {
  const results = [];
  const tree = toTree(filter);

  const valueOf = (field) => {
    if (!field) return undefined;
    if (field.source === 'column') return question[field.column];
    if (field.source === 'taxonomy') {
      // A question can sit in several branches, so every taxonomy field is a
      // set for the purposes of explaining a match.
      const key = { subject: 'subjects', area: 'areas', sub_area: 'subAreas' }[field.level];
      return question[key] || [];
    }
    if (field.source === 'tag') return question.tags || [];
    if (field.source === 'attribute') return (question.attributes || {})[field.attrKey];
    if (field.source === 'fts') return question.question_text;
    return undefined;
  };

  const evalLeaf = (leaf) => {
    const field = getField(leaf.field);
    const operator = leaf.operator || 'in';
    const values = asArray(leaf.value).map((v) => (field?.dataType === 'number' ? Number(v) : v));
    const actual = valueOf(field);
    const asStr = (v) => (v === null || v === undefined ? '' : String(v));
    const set = new Set(asArray(actual).map(asStr));
    const num = Number(actual);

    // Taxonomy and tag fields hold sets: "matches" means any overlap.
    const isSet = field?.source === 'taxonomy' || field?.source === 'tag';

    let passed;
    switch (operator) {
      case 'eq': passed = isSet ? set.has(asStr(values[0])) : asStr(actual) === asStr(values[0]); break;
      case 'neq': passed = isSet ? !set.has(asStr(values[0])) : asStr(actual) !== asStr(values[0]); break;
      case 'in': passed = isSet
        ? values.some((v) => set.has(asStr(v)))
        : values.map(asStr).includes(asStr(actual)); break;
      case 'not_in': passed = isSet
        ? !values.some((v) => set.has(asStr(v)))
        : !values.map(asStr).includes(asStr(actual)); break;
      case 'contains': passed = asStr(actual).toLowerCase().includes(asStr(values[0]).toLowerCase()); break;
      case 'not_contains': passed = !asStr(actual).toLowerCase().includes(asStr(values[0]).toLowerCase()); break;
      case 'starts_with': passed = asStr(actual).toLowerCase().startsWith(asStr(values[0]).toLowerCase()); break;
      case 'gt': passed = num > values[0]; break;
      case 'gte': passed = num >= values[0]; break;
      case 'lt': passed = num < values[0]; break;
      case 'lte': passed = num <= values[0]; break;
      case 'between': passed = num >= values[0] && num <= values[1]; break;
      case 'is_set': passed = isSet
        ? set.size > 0
        : actual !== null && actual !== undefined && actual !== ''; break;
      case 'is_not_set': passed = isSet
        ? set.size === 0
        : actual === null || actual === undefined || actual === ''; break;
      case 'has_any': passed = values.some((v) => set.has(asStr(v))); break;
      case 'has_all': passed = values.every((v) => set.has(asStr(v))); break;
      case 'has_none': passed = !values.some((v) => set.has(asStr(v))); break;
      case 'matches': {
        const haystack = asStr(actual).toLowerCase();
        passed = asStr(values[0]).toLowerCase().split(/\s+/).filter(Boolean).every((t) => haystack.includes(t));
        break;
      }
      default: passed = true;
    }

    results.push({
      field: leaf.field,
      criterion: describeLeaf(leaf),
      actual: Array.isArray(actual) ? actual.join(', ') : asStr(actual),
      passed,
    });
    return passed;
  };

  const walk = (node, negated = false) => {
    if (!node) return true;
    if (node.taxonomy) {
      // Report each level separately for the audit view, but decide the match
      // on whether one branch satisfies all of them at once.
      const branches = question.taxonomy || [];
      const levelKey = { subject: 'subject', area: 'area', sub_area: 'subArea' };
      const matches = branches.some((branch) =>
        Object.entries(node.taxonomy).every(([level, values]) =>
          values.map(String).includes(String(branch[levelKey[level]] ?? ''))));

      for (const [level, values] of Object.entries(node.taxonomy)) {
        const field = getField(level);
        const present = branches.map((b) => b[levelKey[level]]).filter(Boolean);
        results.push({
          field: level,
          criterion: `${field ? field.label : level} = ${values.join(', ')}`,
          actual: present.join(', '),
          passed: matches,
        });
      }
      return negated ? !matches : matches;
    }
    if (node.field) {
      const passed = evalLeaf(node);
      return negated ? !passed : passed;
    }
    const op = String(node.op || 'AND').toUpperCase();
    const children = Array.isArray(node.children) ? node.children.filter(Boolean) : [];
    if (op === 'NOT') return !children.every((c) => walk(c, !negated));
    if (op === 'OR') return children.some((c) => walk(c, negated));
    return children.every((c) => walk(c, negated));
  };

  const matched = walk(tree);
  return { matched, criteria: results };
}
