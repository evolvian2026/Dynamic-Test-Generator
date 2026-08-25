/** Small presentational primitives shared across pages. */

import { useEffect } from 'react';

export function Card({ title, actions, children, className = '', bodyClass = '' }) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions && <div className="flex-gap">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ children, variant }) {
  return <span className={`badge${variant ? ` badge-${variant}` : ''}`}>{children}</span>;
}

export function DifficultyBadge({ level }) {
  const variant = { Easy: 'easy', Medium: 'medium', Hard: 'hard' }[level];
  return <Badge variant={variant}>{level}</Badge>;
}

/**
 * Renders a question's taxonomy branches.
 *
 * A QID may sit in several branches, so this shows the primary one in full
 * (Subject > Area > Sub-Area) and summarises the rest rather than pretending
 * there is only one classification.
 */
export function TaxonomyBadges({ question, showSubject = true, compact = false }) {
  if (!question) return null;
  const branches = question.taxonomy || [];
  if (!branches.length) {
    return <span className="faint small">unclassified</span>;
  }

  const primary = question.primary || branches[0];
  const others = branches.length - 1;

  return (
    <>
      {showSubject && <Badge variant="brand">{primary.subject}</Badge>}
      <Badge>{primary.area}</Badge>
      {primary.subArea && <span className="faint small">{primary.subArea}</span>}
      {others > 0 && (
        <span
          className="badge"
          title={branches
            .slice(1)
            .map((b) => `${b.subject} › ${b.area}${b.subArea ? ` › ${b.subArea}` : ''}`)
            .join('\n')}
        >
          +{others} more
        </span>
      )}
      {!compact && null}
    </>
  );
}

/** Compact "Subject › Area › Sub-Area" text for table cells. */
export function TaxonomyPath({ question, fallback = '—' }) {
  const primary = question?.primary;
  if (!primary) return <span className="faint">{fallback}</span>;
  const extra = (question.taxonomy?.length || 1) - 1;
  return (
    <span title={(question.taxonomy || []).map((b) => `${b.subject} › ${b.area}${b.subArea ? ` › ${b.subArea}` : ''}`).join('\n')}>
      {primary.area}
      {primary.subArea && <span className="faint"> › {primary.subArea}</span>}
      {extra > 0 && <span className="faint"> +{extra}</span>}
    </span>
  );
}

export function Alert({ variant = 'info', title, children }) {
  const icon = { error: '✕', warning: '⚠', success: '✓', info: 'ℹ' }[variant];
  return (
    <div className={`alert alert-${variant}`}>
      <span className="alert-icon" aria-hidden="true">{icon}</span>
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label }) {
  return (
    <span className="flex-gap">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="muted small">{label}</span>}
    </span>
  );
}

export function EmptyState({ icon = '∅', title, children, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, size }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Horizontal bar chart used across the dashboards. */
export function BarChart({ data, max, formatValue = (v) => v, color = 'var(--brand)' }) {
  const peak = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bar-chart">
      {data.map((row) => (
        <div className="bar-row" key={row.label}>
          <span className="bar-label" title={row.label}>{row.label}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: `${Math.max(2, (row.value / peak) * 100)}%`, background: row.color || color }}
            />
          </span>
          <span className="bar-value">{formatValue(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Stacked difficulty mix bar. */
export function DistributionBar({ counts }) {
  const palette = { Easy: 'var(--easy)', Medium: 'var(--medium)', Hard: 'var(--hard)' };
  const entries = Object.entries(counts || {}).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return null;
  return (
    <>
      <div className="distribution-bar">
        {entries.map(([key, value]) => (
          <span key={key} style={{ width: `${(value / total) * 100}%`, background: palette[key] || 'var(--brand)' }} title={`${key}: ${value}`} />
        ))}
      </div>
      <div className="flex-gap small muted">
        {entries.map(([key, value]) => (
          <span key={key}>
            <span style={{ color: palette[key] || 'var(--brand)' }}>■</span> {key} {value}
          </span>
        ))}
      </div>
    </>
  );
}

export function Pagination({ page, pageCount, total, pageSize, onPage, onPageSize }) {
  return (
    <div className="pagination">
      <span className="muted">
        {total.toLocaleString()} result{total === 1 ? '' : 's'}
        {pageCount > 1 && ` · page ${page} of ${pageCount}`}
      </span>
      <div className="flex-gap">
        {onPageSize && (
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            style={{ width: 'auto' }}
            aria-label="Rows per page"
          >
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(1)}>« First</button>
        <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
        <button type="button" className="btn btn-sm" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next ›</button>
        <button type="button" className="btn btn-sm" disabled={page >= pageCount} onClick={() => onPage(pageCount)}>Last »</button>
      </div>
    </div>
  );
}

/**
 * Multi-select chip group backed by facet counts.
 *
 * Taxonomy options can repeat a name across parents — "Arrays and Strings"
 * exists under four subjects — so chips are keyed by id where one is available
 * and the parent is surfaced in the tooltip. Selecting such a chip selects the
 * name, which matches the filter semantics: the name is scoped by whatever
 * parent level is also selected.
 */
export function ChipSelect({ options, selected = [], onChange, showCounts = true, emptyLabel = 'No options available' }) {
  const toggle = (value) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  if (!options?.length) return <p className="faint small mb-0">{emptyLabel}</p>;

  // Names that appear more than once need their parent shown to be tellable apart.
  const seen = new Map();
  for (const option of options) {
    const value = typeof option === 'string' ? option : option.value;
    seen.set(value, (seen.get(value) || 0) + 1);
  }

  return (
    <div className="chip-select">
      {options.map((option, index) => {
        const isObject = typeof option !== 'string';
        const value = isObject ? option.value : option;
        const count = isObject ? option.count : null;
        const parent = isObject ? option.subject || option.area || null : null;
        const ambiguous = seen.get(value) > 1 && parent;

        return (
          <button
            type="button"
            key={(isObject && option.id != null ? `id-${option.id}` : `${value}-${index}`)}
            className={`chip${selected.includes(value) ? ' selected' : ''}`}
            onClick={() => toggle(value)}
            aria-pressed={selected.includes(value)}
            title={parent ? `${parent} › ${value}` : undefined}
          >
            {value || '(none)'}
            {ambiguous && <span className="chip-count">{parent}</span>}
            {showCounts && count != null && <span className="chip-count">{count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function statusVariant(status) {
  return { draft: 'draft', published: 'published', archived: 'archived' }[status] || 'draft';
}
