/**
 * Results for one generated test.
 *
 * This application builds papers; it does not deliver them. Without response
 * data, though, the bank can never tell a good item from a bad one — so results
 * are ingested from whatever did the delivery. A flat CSV (one row per
 * response) is the shape most LMS and OMR exports already have.
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from './Toast.jsx';
import { parseCsv } from './ImportWizard.jsx';
import { Card, Badge, Alert, Spinner, EmptyState } from './ui.jsx';

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export default function ResultsPanel({ testId, onOpenStats }) {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.results.forTest(testId).then(setData).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, [testId]);

  const upload = async (file) => {
    setBusy(true);
    setError(null);
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error('That file has no data rows.');
      const result = await api.results.ingestRows(testId, rows);
      toast.success(`Recorded ${result.responses} response(s) from ${result.attempts} candidate(s).`);
      if (result.ignoredQids.length) {
        toast.warning(`${result.ignoredQids.length} QID(s) in the file are not in this test and were ignored.`);
      }
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('Delete every recorded attempt for this test? Item statistics will be recomputed without them.')) return;
    try {
      const result = await api.results.clear(testId);
      toast.success(`Removed ${result.removed} attempt(s).`);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const analysed = (data?.items || []).filter((item) => item.responses > 0);

  return (
    <Card
      title="Results"
      bodyClass="tight"
      actions={can('results:write') && data?.attempts > 0 && (
        <button type="button" className="btn btn-xs btn-ghost" onClick={clear}>Clear results</button>
      )}
    >
      {error && <Alert variant="error">{error}</Alert>}
      {!data && !error && <Spinner label="Loading results…" />}

      {data && data.attempts === 0 && (
        <EmptyState title="No results recorded for this test" icon="◔">
          Upload a results file below to give every question in this paper an observed difficulty and a
          discrimination index.
        </EmptyState>
      )}

      {data?.attempts > 0 && (
        <>
          <div className="grid grid-4 mb-2">
            <div className="stat"><div className="stat-label">Candidates</div><div className="stat-value">{data.attempts}</div></div>
            <div className="stat"><div className="stat-label">Mean score</div><div className="stat-value">{data.meanScore ?? '—'}</div></div>
            <div className="stat"><div className="stat-label">Lowest</div><div className="stat-value">{data.minScore ?? '—'}</div></div>
            <div className="stat"><div className="stat-label">Highest</div><div className="stat-value">{data.maxScore ?? '—'}</div></div>
          </div>

          {analysed.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>QID</th><th>Labelled</th><th className="right">Responses</th>
                    <th className="right">p-value</th><th className="right">Discrimination</th><th>Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {analysed.map((item) => (
                    <tr key={item.qid}>
                      <td>
                        <button type="button" className="qid-link" onClick={() => onOpenStats?.(item.qid)}>{item.qid}</button>
                      </td>
                      <td className="small">{item.difficulty}</td>
                      <td className="right">{item.responses}</td>
                      <td className="right">{pct(item.p_value)}</td>
                      <td className="right">
                        {item.discrimination === null || item.discrimination === undefined ? '—' : (
                          <Badge variant={item.discrimination < 0 ? 'danger' : item.discrimination < 0.2 ? 'warning' : 'success'}>
                            {item.discrimination.toFixed(2)}
                          </Badge>
                        )}
                      </td>
                      <td className="small">
                        {item.difficulty_flag
                          ? <Badge variant="warning">{item.difficulty_flag.replace(/_/g, ' ')}</Badge>
                          : <span className="faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {can('results:write') && (
        <div className="field mt-2">
          <label htmlFor={`results-${testId}`}>Upload results (CSV)</label>
          <input
            id={`results-${testId}`} type="file" accept=".csv,text/csv" disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <span className="field-hint">
            One row per response, with columns <code>candidate_ref</code>, <code>qid</code> and
            {' '}<code>is_correct</code>. <code>chosen_option</code>, <code>score</code>,
            {' '}<code>time_taken</code> and <code>total_score</code> are optional; a total score is derived
            when the file has none. Re-uploading a corrected file replaces that candidate&rsquo;s attempt
            rather than duplicating it.
          </span>
          {busy && <Spinner label="Recording responses…" />}
        </div>
      )}
    </Card>
  );
}
