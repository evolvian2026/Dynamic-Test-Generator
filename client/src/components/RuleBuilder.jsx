/**
 * Smart Filter Builder (spec §15).
 *
 * Builds an arbitrarily nested AND / OR / NOT tree over any registered
 * metadata field — including fields added later, since the field list comes
 * from the server's registry rather than from hard-coded UI knowledge.
 */

import { useState } from 'react';

const emptyLeaf = (field) => ({ field: field.key, operator: field.operators[0], value: [] });

function ValueEditor({ field, leaf, onChange, facets }) {
  const arity = {
    is_set: 'none', is_not_set: 'none',
    between: 'range',
    in: 'multi', not_in: 'multi', has_any: 'multi', has_all: 'multi', has_none: 'multi',
  }[leaf.operator] || 'single';

  if (arity === 'none') return <span className="faint small">no value needed</span>;

  if (arity === 'range') {
    const values = Array.isArray(leaf.value) ? leaf.value : [];
    return (
      <div className="flex-gap">
        <input
          type={field.dataType === 'number' ? 'number' : 'text'} placeholder="from"
          value={values[0] ?? ''} onChange={(e) => onChange([e.target.value, values[1] ?? ''])}
        />
        <input
          type={field.dataType === 'number' ? 'number' : 'text'} placeholder="to"
          value={values[1] ?? ''} onChange={(e) => onChange([values[0] ?? '', e.target.value])}
        />
      </div>
    );
  }

  const options = facets?.[field.key];
  if (arity === 'multi' && options?.length) {
    const selected = Array.isArray(leaf.value) ? leaf.value : [];
    return (
      <select
        multiple
        size={Math.min(5, options.length)}
        value={selected}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
      >
        {options.map((o) => (
          <option key={o.value ?? o} value={o.value ?? o}>{o.value ?? o}{o.count != null ? ` (${o.count})` : ''}</option>
        ))}
      </select>
    );
  }

  const single = Array.isArray(leaf.value) ? leaf.value.join(', ') : leaf.value ?? '';
  return (
    <input
      type={field.dataType === 'number' ? 'number' : 'text'}
      placeholder={arity === 'multi' ? 'comma-separated values' : 'value'}
      value={single}
      onChange={(e) => onChange(arity === 'multi'
        ? e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
        : e.target.value)}
    />
  );
}

function Node({ node, fields, facets, operators, onChange, onRemove, depth = 0 }) {
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f]));

  if (node.field) {
    const field = fieldMap[node.field] || fields[0];
    return (
      <div className="rule-node">
        <div className="rule-leaf">
          <select
            value={node.field}
            onChange={(e) => onChange(emptyLeaf(fieldMap[e.target.value]))}
            aria-label="Field"
          >
            {groupFields(fields).map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </optgroup>
            ))}
          </select>

          <select
            value={node.operator}
            onChange={(e) => onChange({ ...node, operator: e.target.value })}
            aria-label="Operator"
          >
            {field.operators.map((op) => (
              <option key={op} value={op}>{operators?.[op]?.label || op}</option>
            ))}
          </select>

          <ValueEditor field={field} leaf={node} facets={facets} onChange={(value) => onChange({ ...node, value })} />

          <button type="button" className="btn btn-xs btn-ghost" onClick={onRemove} aria-label="Remove condition">✕</button>
        </div>
      </div>
    );
  }

  const op = String(node.op || 'AND').toUpperCase();
  const children = node.children || [];
  const setChild = (index, next) =>
    onChange({ ...node, children: children.map((c, i) => (i === index ? next : c)) });

  return (
    <div className="rule-node">
      <div className="flex-between mb-1">
        <div className="rule-op-toggle">
          {['AND', 'OR', 'NOT'].map((value) => (
            <button
              key={value}
              type="button"
              className={op === value ? 'active' : ''}
              onClick={() => onChange({ ...node, op: value })}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="flex-gap">
          <button
            type="button" className="btn btn-xs"
            onClick={() => onChange({ ...node, children: [...children, emptyLeaf(fields[0])] })}
          >
            + Condition
          </button>
          {depth < 4 && (
            <button
              type="button" className="btn btn-xs"
              onClick={() => onChange({ ...node, children: [...children, { op: 'OR', children: [emptyLeaf(fields[0])] }] })}
            >
              + Group
            </button>
          )}
          {onRemove && <button type="button" className="btn btn-xs btn-ghost" onClick={onRemove} aria-label="Remove group">✕</button>}
        </div>
      </div>

      {children.length === 0 && <p className="faint small mb-0">Add a condition to this group.</p>}
      {children.map((child, index) => (
        <Node
          key={index}
          node={child}
          fields={fields}
          facets={facets}
          operators={operators}
          depth={depth + 1}
          onChange={(next) => setChild(index, next)}
          onRemove={() => onChange({ ...node, children: children.filter((_, i) => i !== index) })}
        />
      ))}
    </div>
  );
}

function groupFields(fields) {
  const groups = new Map();
  for (const field of fields) {
    const group = field.group || 'Other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(field);
  }
  return [...groups.entries()];
}

export default function RuleBuilder({ meta, value, onChange }) {
  const [enabled, setEnabled] = useState(Boolean(value && (value.children?.length || value.field)));
  const fields = (meta?.fields || []).filter((f) => f.source !== 'fts' || f.key === 'question_text');

  if (!fields.length) return null;

  const facets = {
    question_type: (meta.questionTypes || []).map((v) => ({ value: v })),
    topic: meta.topics || [],
    difficulty: (meta.difficulties || []).map((v) => ({ value: v })),
    status: (meta.statuses || []).map((v) => ({ value: v })),
    tags: meta.tags || [],
  };

  if (!enabled) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-block"
        onClick={() => {
          setEnabled(true);
          onChange({ op: 'AND', children: [emptyLeaf(fields[0])] });
        }}
      >
        + Add advanced rule (AND / OR / NOT)
      </button>
    );
  }

  return (
    <>
      <div className="flex-between mb-1">
        <span className="field-label mb-0">Advanced rule</span>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => { setEnabled(false); onChange(null); }}
        >
          Clear
        </button>
      </div>
      <Node
        node={value || { op: 'AND', children: [] }}
        fields={fields}
        facets={facets}
        operators={meta.operators}
        onChange={onChange}
      />
      <p className="field-hint">Combined with the quick filters above using AND.</p>
    </>
  );
}
