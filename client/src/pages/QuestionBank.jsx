/** Question Bank dashboard and explorer (spec §13). */

import { useEffect, useState } from 'react';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync, useDebounced } from '../lib/hooks.js';
import FilterPanel from '../components/FilterPanel.jsx';
import RuleBuilder from '../components/RuleBuilder.jsx';
import QuestionModal from '../components/QuestionModal.jsx';
import {
  Card, Stat, Badge, DifficultyBadge, BarChart, Pagination, Spinner, EmptyState, ChipSelect,
  TaxonomyPath,
} from '../components/ui.jsx';

export default function QuestionBank() {
  const [rule, setRule] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState('qid');
  const [direction, setDirection] = useState('asc');
  const [qidQuery, setQidQuery] = useState('');
  const [openQid, setOpenQid] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  const { data: meta } = useAsync(() => api.questions.metadata(), []);
  const { data: stats } = useAsync(() => api.questions.statistics(), []);
  const debouncedQid = useDebounced(qidQuery, 300);
  const filterKey = useDebounced(JSON.stringify(rule), 350);

  useEffect(() => { setPage(1); }, [filterKey, debouncedQid]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const filter = JSON.parse(filterKey);
    const payload = {
      filter: debouncedQid
        ? { ...filter, advanced: { field: 'qid', operator: 'contains', value: debouncedQid } }
        : filter,
      page, pageSize, sort, direction,
      // The bank explorer shows every lifecycle state, not just active.
      activeOnly: false,
    };
    api.questions.search(payload)
      .then((data) => !cancelled && setResult(data))
      .catch(() => !cancelled && setResult({ items: [], total: 0, pageCount: 1, page: 1 }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [filterKey, debouncedQid, page, pageSize, sort, direction]);

  const sortBy = (column) => {
    if (sort === column) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(column); setDirection('asc'); }
  };
  const arrow = (column) => (sort === column ? (direction === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <>
      <TopBar
        title="Question Bank"
        subtitle="Browse and filter the bank. Tests reference these QIDs — they are never copied."
        actions={
          <button type="button" className="btn btn-sm" onClick={() => { setRule({}); setQidQuery(''); }}>
            Clear filters
          </button>
        }
      />

      <div className="page">
        {stats && (
          <div className="grid grid-4 mb-2">
            <Stat
              label="Total questions"
              value={stats.total.toLocaleString()}
              hint={`${stats.totalSubjects} subjects · ${stats.totalAreas} areas`}
            />
            <Stat label="MCQ" value={(stats.byType.MCQ || 0).toLocaleString()} hint={`Multiple Select: ${(stats.byType['Multiple Select'] || 0).toLocaleString()}`} />
            <Stat label="Coding" value={(stats.byType.Coding || 0).toLocaleString()} hint={`Fill in the Blank: ${(stats.byType['Fill in the Blank'] || 0).toLocaleString()}`} />
            <Stat
              label="Difficulty"
              value={`${stats.byDifficulty.Easy || 0} / ${stats.byDifficulty.Medium || 0} / ${stats.byDifficulty.Hard || 0}`}
              hint="Easy / Medium / Hard"
            />
          </div>
        )}

        <div className="builder" style={{ gridTemplateColumns: '330px minmax(0, 1fr)' }}>
          <div className="builder-panel">
            <Card title="Filters">
              <div className="field">
                <span className="field-label">QID</span>
                <input type="search" placeholder="QID1023" value={qidQuery} onChange={(e) => setQidQuery(e.target.value)} />
              </div>
              <FilterPanel meta={meta} rule={rule} onChange={setRule} />
              <div className="field">
                <span className="field-label">Status</span>
                <ChipSelect
                  options={(meta?.statuses || []).map((value) => ({ value }))}
                  selected={rule.status || []}
                  onChange={(v) => setRule({ ...rule, status: v })}
                  showCounts={false}
                />
              </div>
              <div className="divider" />
              <RuleBuilder meta={meta} value={rule.advanced || null} onChange={(advanced) => setRule({ ...rule, advanced })} />
            </Card>

            {stats && (
              <Card title="Subject distribution" className="mt-2">
                <BarChart
                  data={stats.bySubject.slice(0, 12).map((t) => ({ label: t.value, value: t.count }))}
                  formatValue={(v) => v.toLocaleString()}
                />
                <div className="divider" />
                <span className="field-label">Top areas</span>
                <BarChart
                  data={stats.byArea.slice(0, 10).map((t) => ({ label: t.value, value: t.count }))}
                  formatValue={(v) => v.toLocaleString()}
                />
                <div className="divider" />
                <span className="field-label">Tag distribution</span>
                <div className="chip-select">
                  {stats.byTag.slice(0, 24).map((tag) => (
                    <span key={tag.value} className="chip chip-static">
                      {tag.value}<span className="chip-count">{tag.count.toLocaleString()}</span>
                    </span>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <Card
            title={
              <div>
                <h3>Questions</h3>
                <span className="muted small">
                  {loading ? 'Filtering…' : `${result?.total?.toLocaleString() ?? 0} match the current filters`}
                </span>
              </div>
            }
            actions={loading ? <Spinner /> : null}
            bodyClass="tight"
          >
            {!result?.items?.length && !loading ? (
              <EmptyState title="No questions match these filters" icon="⌕">
                Try removing a filter or widening the difficulty range.
              </EmptyState>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th className="sortable" onClick={() => sortBy('qid')}>QID{arrow('qid')}</th>
                        <th>Question</th>
                        <th className="sortable" onClick={() => sortBy('question_type')}>Type{arrow('question_type')}</th>
                        <th className="sortable" onClick={() => sortBy('difficulty')}>Level{arrow('difficulty')}</th>
                        <th>Subject</th>
                        <th>Area / Sub-Area</th>
                        <th className="sortable right" onClick={() => sortBy('marks')}>Marks{arrow('marks')}</th>
                        <th className="sortable" onClick={() => sortBy('status')}>Status{arrow('status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(result?.items || []).map((question) => (
                        <tr key={question.qid}>
                          <td>
                            <button type="button" className="qid-link" onClick={() => setOpenQid(question.qid)}>
                              {question.qid}
                            </button>
                          </td>
                          <td style={{ maxWidth: 400 }}>
                            <span className="q-text">{question.question_text}</span>
                            {question.tags?.length > 0 && (
                              <div className="flex-gap mt-1">
                                {question.tags.slice(0, 4).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                              </div>
                            )}
                          </td>
                          <td className="nowrap small">{question.question_type}</td>
                          <td><DifficultyBadge level={question.difficulty} /></td>
                          <td className="small">
                            {question.subjects?.length
                              ? question.subjects.join(', ')
                              : <span className="faint">unclassified</span>}
                          </td>
                          <td className="small"><TaxonomyPath question={question} /></td>
                          <td className="right">{question.marks}</td>
                          <td>
                            <Badge variant={question.status === 'active' ? 'success' : undefined}>{question.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result && (
                  <Pagination
                    page={result.page} pageCount={result.pageCount} total={result.total} pageSize={pageSize}
                    onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }}
                  />
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      {openQid && <QuestionModal qid={openQid} onClose={() => setOpenQid(null)} withAnswers />}
    </>
  );
}
