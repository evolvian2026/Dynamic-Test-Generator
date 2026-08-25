/**
 * Manual selection mode (spec §8, Mode 2).
 *
 * Shows every QID matching the section's filters with select-all, clear-all,
 * QID search, text search, sorting and paging — all server-side, so this works
 * against a bank of any size.
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { Modal, Badge, DifficultyBadge, Pagination, Spinner, EmptyState, TaxonomyPath } from './ui.jsx';

export default function ManualPicker({ section, onClose, onConfirm, excludeQids = [] }) {
  const [selected, setSelected] = useState(new Set(section.qids || []));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState('qid');
  const [direction, setDirection] = useState('asc');
  const [qidQuery, setQidQuery] = useState('');
  const [textQuery, setTextQuery] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  const debouncedQid = useDebounced(qidQuery, 300);
  const debouncedText = useDebounced(textQuery, 300);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const filter = { ...(section.rule || {}) };
    if (debouncedQid) filter.qid = undefined;
    if (debouncedText) filter.search = debouncedText;

    api.questions
      .search({
        filter: debouncedQid
          ? { ...filter, advanced: { field: 'qid', operator: 'contains', value: debouncedQid } }
          : filter,
        page,
        pageSize,
        sort,
        direction,
        excludeQids,
      })
      .then((data) => !cancelled && setResult(data))
      .catch(() => !cancelled && setResult({ items: [], total: 0, pageCount: 1 }))
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [debouncedQid, debouncedText, page, pageSize, sort, direction, JSON.stringify(section.rule), JSON.stringify(excludeQids)]);

  const toggle = (qid) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(qid)) next.delete(qid); else next.add(qid);
      return next;
    });
  };

  const selectAllOnPage = () => {
    setSelected((current) => new Set([...current, ...(result?.items || []).map((q) => q.qid)]));
  };

  const sortBy = (column) => {
    if (sort === column) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(column); setDirection('asc'); }
  };

  const requested = Number(section.question_count) || 0;

  return (
    <Modal
      size="lg"
      title={`Select questions — ${section.section_name || 'Section'}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {selected.size} selected{requested ? ` of ${requested} requested` : ''}
            {requested > 0 && selected.size !== requested && (
              <span className={selected.size > requested ? ' badge badge-warning' : ' badge'} style={{ marginLeft: 8 }}>
                {selected.size > requested ? `${selected.size - requested} over` : `${requested - selected.size} more needed`}
              </span>
            )}
          </span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onConfirm([...selected])}>
            Use {selected.size} question{selected.size === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="form-row mb-2">
        <div>
          <span className="field-label">Search QID</span>
          <input type="search" placeholder="QID1023" value={qidQuery} onChange={(e) => { setQidQuery(e.target.value); setPage(1); }} />
        </div>
        <div>
          <span className="field-label">Search question text</span>
          <input type="search" placeholder="binary search…" value={textQuery} onChange={(e) => { setTextQuery(e.target.value); setPage(1); }} />
        </div>
      </div>

      <div className="flex-gap mb-2">
        <button type="button" className="btn btn-sm" onClick={selectAllOnPage}>Select all on page</button>
        <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear all</button>
        {requested > 0 && (
          <button
            type="button" className="btn btn-sm"
            onClick={() => {
              const next = new Set(selected);
              for (const q of result?.items || []) {
                if (next.size >= requested) break;
                next.add(q.qid);
              }
              setSelected(next);
            }}
          >
            Fill to {requested}
          </button>
        )}
        <span className="muted small">Showing {result?.total?.toLocaleString() ?? 0} matching questions</span>
      </div>

      {loading && !result ? (
        <div className="center" style={{ padding: 30 }}><Spinner label="Loading questions…" /></div>
      ) : !result?.items?.length ? (
        <EmptyState title="No questions match these filters" icon="⌕">
          Relax the section rules and try again.
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th className="sortable" onClick={() => sortBy('qid')}>QID</th>
                  <th>Question</th>
                  <th className="sortable" onClick={() => sortBy('question_type')}>Type</th>
                  <th className="sortable" onClick={() => sortBy('difficulty')}>Level</th>
                  <th>Subject / Area</th>
                  <th className="sortable right" onClick={() => sortBy('marks')}>Marks</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((question) => (
                  <tr key={question.qid} onClick={() => toggle(question.qid)} style={{ cursor: 'pointer' }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(question.qid)}
                        onChange={() => toggle(question.qid)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${question.qid}`}
                      />
                    </td>
                    <td className="mono nowrap">{question.qid}</td>
                    <td style={{ maxWidth: 340 }}>
                      <span className="q-text">{question.question_text}</span>
                      {question.tags?.length > 0 && (
                        <div className="flex-gap mt-1">
                          {question.tags.slice(0, 3).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                        </div>
                      )}
                    </td>
                    <td className="nowrap">{question.question_type}</td>
                    <td><DifficultyBadge level={question.difficulty} /></td>
                    <td className="small">
                      {question.primary
                        ? <>{question.primary.subject}<div className="faint"><TaxonomyPath question={question} /></div></>
                        : <span className="faint">unclassified</span>}
                    </td>
                    <td className="right">{question.marks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={result.page} pageCount={result.pageCount} total={result.total} pageSize={pageSize}
            onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }}
          />
        </>
      )}
    </Modal>
  );
}
