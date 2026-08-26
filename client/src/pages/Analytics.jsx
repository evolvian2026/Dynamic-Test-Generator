/** Analytics (spec §23). */

import { useState } from 'react';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import ItemAnalyticsModal from '../components/ItemAnalyticsModal.jsx';
import { Card, Stat, Badge, BarChart, Spinner, Alert, EmptyState } from '../components/ui.jsx';

const FLAG_LABEL = {
  too_easy: 'too easy',
  too_hard: 'too hard',
  harder_than_labelled: 'harder than labelled',
  easier_than_labelled: 'easier than labelled',
};

export default function Analytics() {
  const { can } = useAuth();
  const [analyticsQid, setAnalyticsQid] = useState(null);
  const { data, error, loading } = useAsync(() => api.analytics.overview(), []);
  const { data: audit } = useAsync(
    () => (can('users:read') ? api.analytics.audit(40) : Promise.resolve(null)),
    [],
  );
  const { data: items, reload: reloadItems } = useAsync(
    () => (can('results:read') ? api.results.itemOverview({ limit: 20 }) : Promise.resolve(null)),
    [],
  );

  return (
    <>
      <TopBar title="Analytics" subtitle="Bank coverage, test output and question reuse." />

      <div className="page">
        {error && <Alert variant="error">{error.message}</Alert>}
        {loading && !data && <Spinner label="Crunching numbers…" />}

        {data && (
          <>
            <div className="grid grid-4 mb-2">
              <Stat
                label="Bank size"
                value={data.bank.total.toLocaleString()}
                hint={`${data.bank.totalSubjects} subjects · ${data.bank.totalAreas} areas`}
              />
              <Stat label="Tests generated" value={data.tests.total} hint={`${data.tests.published} published`} />
              <Stat
                label="Subjects covered"
                value={data.coverage.filter((c) => c.used_questions > 0).length}
                hint={`of ${data.coverage.length} in the bank`}
              />
              <Stat
                label="Questions used"
                value={data.coverage.reduce((a, c) => a + c.used_questions, 0).toLocaleString()}
                hint="Distinct QIDs across all tests"
              />
            </div>

            <div className="grid grid-2 mb-2">
              <Card title="Bank composition by type">
                <BarChart
                  data={Object.entries(data.bank.byType).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))}
                  formatValue={(v) => v.toLocaleString()}
                />
              </Card>

              <Card title="Subject coverage" bodyClass="tight">
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Subject</th><th className="right">In bank</th><th className="right">Used</th><th className="right">Coverage</th></tr></thead>
                    <tbody>
                      {data.coverage.slice(0, 12).map((row) => {
                        const pct = row.bank_questions ? (row.used_questions / row.bank_questions) * 100 : 0;
                        return (
                          <tr key={row.subject}>
                            <td>{row.subject}</td>
                            <td className="right">{row.bank_questions.toLocaleString()}</td>
                            <td className="right">{row.used_questions.toLocaleString()}</td>
                            <td className="right">
                              <Badge variant={pct > 0 ? 'brand' : undefined}>{pct.toFixed(1)}%</Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            <div className="grid grid-2">
              <Card title="Tests created (last 30 days)">
                {data.testsPerDay.length === 0 ? (
                  <EmptyState title="No tests in the last 30 days" icon="◔" />
                ) : (
                  <BarChart data={data.testsPerDay.map((d) => ({ label: d.day, value: d.count }))} />
                )}
              </Card>

              <Card title="Most reused questions" bodyClass="tight">
                {data.mostUsed.length === 0 ? (
                  <EmptyState title="No reuse data yet" icon="↻" />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead><tr><th>QID</th><th>Area</th><th>Difficulty</th><th className="right">Tests</th></tr></thead>
                      <tbody>
                        {data.mostUsed.map((row) => (
                          <tr key={row.qid}>
                            <td className="mono">{row.qid}</td>
                            <td>{row.area || '—'}</td>
                            <td>{row.difficulty}</td>
                            <td className="right">{row.uses}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>

            {items && (
              <ItemQuality data={items} onReload={reloadItems} onOpen={setAnalyticsQid} />
            )}

            {audit && (
              <Card title="Recent activity" className="mt-2" bodyClass="tight">
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
                    <tbody>
                      {audit.map((row) => (
                        <tr key={row.id}>
                          <td className="faint small nowrap">{String(row.created_at).slice(0, 16)}</td>
                          <td className="small">{row.user_name || '—'}</td>
                          <td><Badge>{row.action}</Badge></td>
                          <td className="small faint">{row.entity_type} {row.entity_id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </>
        )}
      </div>

      {analyticsQid && <ItemAnalyticsModal qid={analyticsQid} onClose={() => setAnalyticsQid(null)} />}
    </>
  );
}

/**
 * Item quality across the bank.
 *
 * The rest of this page measures the bank as a catalogue — how big it is, what
 * has been used. This measures whether the questions actually *work*, which is
 * only knowable once responses have been imported.
 */
function ItemQuality({ data, onReload, onOpen }) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const recompute = async () => {
    setBusy(true);
    try {
      const result = await api.results.recompute();
      toast.success(`Recomputed statistics for ${result.questions} question(s).`);
      onReload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Item quality"
      className="mt-2"
      bodyClass="tight"
      actions={can('results:write') && (
        <button type="button" className="btn btn-sm" onClick={recompute} disabled={busy}>
          {busy ? 'Recomputing…' : '↻ Recompute'}
        </button>
      )}
    >
      {data.analysed === 0 ? (
        <EmptyState title="No responses have been imported yet" icon="◔">
          This application generates tests but does not deliver them. Import results from whatever does —
          an LMS, a proctoring platform or an OMR scanner — and every question gains an observed difficulty
          and a discrimination index.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-4 mb-2">
            <Stat
              label="Questions analysed"
              value={data.analysed.toLocaleString()}
              hint={`${data.totalResponses.toLocaleString()} responses · ${data.totalAttempts.toLocaleString()} attempts`}
            />
            <Stat
              label="Mean p-value"
              value={data.meanPValue === null ? '—' : `${Math.round(data.meanPValue * 100)}%`}
              hint="Observed difficulty; higher means easier"
            />
            <Stat
              label="Mean discrimination"
              value={data.meanDiscrimination === null ? '—' : data.meanDiscrimination.toFixed(2)}
              hint="0.30 and above is good"
            />
            <Stat
              label="Flagged"
              value={data.flagged.toLocaleString()}
              hint={`${data.negativeDiscrimination} with negative discrimination`}
              tone={data.negativeDiscrimination > 0 ? 'danger' : undefined}
            />
          </div>

          {data.negativeDiscrimination > 0 && (
            <Alert variant="error" title="Check these keys">
              {data.negativeDiscrimination} question(s) are answered correctly more often by weak candidates than
              strong ones. That usually means the marked answer is wrong or the wording misleads.
            </Alert>
          )}

          {Object.keys(data.flagCounts).length > 0 && (
            <div className="flex-gap mb-2">
              {Object.entries(data.flagCounts).map(([flag, n]) => (
                <Badge key={flag} variant="warning">{FLAG_LABEL[flag] || flag}: {n}</Badge>
              ))}
            </div>
          )}

          {data.needsReview.length === 0 ? (
            <Alert variant="success">
              No question with enough responses falls below the discrimination threshold.
            </Alert>
          ) : (
            <>
              <span className="field-label">Questions worth reviewing</span>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>QID</th><th>Type</th><th>Labelled</th>
                      <th className="right">Responses</th><th className="right">p-value</th>
                      <th className="right">Discrimination</th><th>Flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.needsReview.map((row) => (
                      <tr key={row.qid}>
                        <td>
                          <button type="button" className="qid-link" onClick={() => onOpen(row.qid)}>{row.qid}</button>
                        </td>
                        <td className="small nowrap">{row.question_type}</td>
                        <td className="small">{row.labelled}</td>
                        <td className="right">{row.responses}</td>
                        <td className="right">{row.p_value === null ? '—' : `${Math.round(row.p_value * 100)}%`}</td>
                        <td className="right">
                          <Badge variant={row.discrimination < 0 ? 'danger' : 'warning'}>
                            {row.discrimination === null ? '—' : row.discrimination.toFixed(2)}
                          </Badge>
                        </td>
                        <td className="small">
                          {row.difficulty_flag ? FLAG_LABEL[row.difficulty_flag] : <span className="faint">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field-hint mt-1">
                Only questions with at least 20 responses are listed — below that the numbers are noise.
              </p>
            </>
          )}
        </>
      )}
    </Card>
  );
}
