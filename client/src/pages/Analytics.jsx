/** Analytics (spec §23). */

import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { Card, Stat, Badge, BarChart, Spinner, Alert, EmptyState } from '../components/ui.jsx';

export default function Analytics() {
  const { can } = useAuth();
  const { data, error, loading } = useAsync(() => api.analytics.overview(), []);
  const { data: audit } = useAsync(
    () => (can('users:read') ? api.analytics.audit(40) : Promise.resolve(null)),
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
    </>
  );
}
