/** Test history (spec §18). */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import { Card, Badge, Pagination, Spinner, EmptyState, statusVariant } from '../components/ui.jsx';

export default function GeneratedTests() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const debouncedSearch = useDebounced(search, 300);

  const load = () => {
    setLoading(true);
    api.tests
      .list({ page, pageSize, ...(status ? { status } : {}), ...(debouncedSearch ? { search: debouncedSearch } : {}), mine })
      .then(setResult)
      .catch((error) => toast.error(error.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [debouncedSearch, status, mine, page, pageSize]);
  useEffect(() => setPage(1), [debouncedSearch, status, mine]);

  const act = async (label, fn) => {
    setBusy(true);
    try {
      const result = await fn();
      toast.success(label);
      load();
      return result;
    } catch (error) {
      toast.error(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar
        title="Generated Tests"
        subtitle="Every test ever generated, with its rules and seed preserved."
        actions={can('tests:write') && <Link className="btn btn-primary btn-sm" to="/create">+ Create Test</Link>}
      />

      <div className="page">
        <Card className="mb-2">
          <div className="form-row">
            <div>
              <span className="field-label">Search</span>
              <input type="search" placeholder="Test name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div>
              <span className="field-label">Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div>
              <span className="field-label">Ownership</span>
              <select value={mine ? 'mine' : 'all'} onChange={(e) => setMine(e.target.value === 'mine')}>
                <option value="all">All tests</option>
                <option value="mine">Created by me</option>
              </select>
            </div>
          </div>
        </Card>

        <Card bodyClass="tight" title={loading ? <Spinner label="Loading tests…" /> : `${result?.total ?? 0} test${result?.total === 1 ? '' : 's'}`}>
          {!result?.items?.length && !loading ? (
            <EmptyState
              title="No tests yet"
              icon="✎"
              action={can('tests:write') && <Link className="btn btn-primary" to="/create">Create your first test</Link>}
            >
              Generated tests will appear here with their full history.
            </EmptyState>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Test ID</th><th>Test Name</th><th className="right">Questions</th>
                      <th className="right">Marks</th><th>Mode</th><th>Created By</th>
                      <th>Created</th><th>Status</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {(result?.items || []).map((test) => (
                      <tr key={test.id}>
                        <td className="mono small nowrap">{test.test_id}</td>
                        <td>
                          <Link to={`/tests/${test.id}`}>{test.test_name}</Link>
                          {test.version_label && <Badge variant="brand" >{`v${test.version_label}`}</Badge>}
                          <div className="faint small">{test.section_count} section{test.section_count === 1 ? '' : 's'} · seed {test.random_seed || '—'}</div>
                        </td>
                        <td className="right">{test.question_count}</td>
                        <td className="right">{test.total_marks}</td>
                        <td className="small" style={{ textTransform: 'capitalize' }}>{test.generation_mode}</td>
                        <td className="small">{test.created_by_name || '—'}</td>
                        <td className="faint small nowrap">{String(test.created_at).slice(0, 16)}</td>
                        <td><Badge variant={statusVariant(test.status)}>{test.status}</Badge></td>
                        <td className="nowrap">
                          <div className="flex-gap">
                            <Link className="btn btn-xs" to={`/tests/${test.id}`}>View</Link>
                            {can('tests:write') && (
                              <>
                                <button
                                  type="button" className="btn btn-xs" disabled={busy}
                                  onClick={async () => {
                                    const copy = await act('Test duplicated.', () => api.tests.duplicate(test.id));
                                    if (copy) navigate(`/tests/${copy.id}`);
                                  }}
                                >
                                  Duplicate
                                </button>
                                <button
                                  type="button" className="btn btn-xs" disabled={busy}
                                  title="Re-run the same rules with a new seed"
                                  onClick={() => act('Test regenerated.', () => api.tests.regenerate(test.id))}
                                >
                                  Regenerate
                                </button>
                                {test.status !== 'archived' && (
                                  <button
                                    type="button" className="btn btn-xs" disabled={busy}
                                    onClick={() => act('Test archived.', () => api.tests.archive(test.id))}
                                  >
                                    Archive
                                  </button>
                                )}
                              </>
                            )}
                            <a className="btn btn-xs" href={api.exportUrl(test.id, 'pdf')} target="_blank" rel="noreferrer">Export</a>
                            {can('tests:delete') && (
                              <button
                                type="button" className="btn btn-xs btn-ghost" disabled={busy}
                                title="Delete permanently"
                                onClick={() => {
                                  if (window.confirm(`Delete ${test.test_id} permanently?`)) {
                                    act('Test deleted.', () => api.tests.remove(test.id));
                                  }
                                }}
                              >
                                ✕
                              </button>
                            )}
                          </div>
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
    </>
  );
}
