import { Link } from 'react-router-dom';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { Card, Stat, Badge, BarChart, Spinner, Alert, EmptyState, statusVariant } from '../components/ui.jsx';

export default function Dashboard() {
  const { user, can } = useAuth();
  const { data, error, loading } = useAsync(() => api.analytics.overview(), []);

  return (
    <>
      <TopBar
        title={`Welcome, ${user.name.split(' ')[0]}`}
        subtitle="Define what you need — the system finds the right QIDs in the bank."
        actions={can('tests:write') && <Link className="btn btn-primary btn-sm" to="/create">+ Create Test</Link>}
      />

      <div className="page">
        {error && <Alert variant="error">{error.message}</Alert>}
        {loading && !data && <Spinner label="Loading dashboard…" />}

        {data && (
          <>
            <div className="grid grid-4 mb-2">
              <Stat
                label="Questions in bank"
                value={data.bank.total.toLocaleString()}
                hint={`${data.bank.totalSubjects} subjects · ${data.bank.totalAreas} areas`}
              />
              <Stat label="Generated tests" value={data.tests.total} hint={`${data.tests.drafts} draft · ${data.tests.published} published`} />
              <Stat label="Templates" value={data.templates} hint="Reusable blueprints" />
              <Stat label="Active users" value={data.users} hint="Across all roles" />
            </div>

            <div className="grid grid-2 mb-2">
              <Card title="Question types">
                <BarChart
                  data={Object.entries(data.bank.byType).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))}
                  formatValue={(v) => v.toLocaleString()}
                />
              </Card>
              <Card title="Difficulty spread">
                <BarChart
                  data={['Easy', 'Medium', 'Hard']
                    .filter((level) => data.bank.byDifficulty[level])
                    .map((label) => ({
                      label,
                      value: data.bank.byDifficulty[label],
                      color: { Easy: 'var(--easy)', Medium: 'var(--medium)', Hard: 'var(--hard)' }[label],
                    }))}
                  formatValue={(v) => v.toLocaleString()}
                />
                <div className="divider" />
                <span className="field-label">Top subjects</span>
                <BarChart
                  data={data.bank.bySubject.slice(0, 6).map((t) => ({ label: t.value, value: t.count }))}
                  formatValue={(v) => v.toLocaleString()}
                />
              </Card>
            </div>

            <div className="grid grid-2">
              <Card
                title="Recent tests"
                actions={<Link className="btn btn-sm" to="/tests">View all</Link>}
                bodyClass="tight"
              >
                {data.recentTests.length === 0 ? (
                  <EmptyState title="No tests yet" icon="✎">
                    Create your first test to see it here.
                  </EmptyState>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr><th>Test</th><th className="right">Q</th><th>Status</th><th>Created</th></tr>
                      </thead>
                      <tbody>
                        {data.recentTests.map((test) => (
                          <tr key={test.id}>
                            <td>
                              <Link to={`/tests/${test.id}`}>{test.test_name}</Link>
                              <div className="faint small mono">{test.test_id}</div>
                            </td>
                            <td className="right">{test.question_count}</td>
                            <td><Badge variant={statusVariant(test.status)}>{test.status}</Badge></td>
                            <td className="faint small nowrap">{String(test.created_at).slice(0, 10)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card title="Most reused questions" bodyClass="tight">
                {data.mostUsed.length === 0 ? (
                  <EmptyState title="No usage data yet" icon="◔">
                    Question reuse is tracked as tests are generated.
                  </EmptyState>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr><th>QID</th><th>Topic</th><th>Type</th><th className="right">Used in</th></tr>
                      </thead>
                      <tbody>
                        {data.mostUsed.map((row) => (
                          <tr key={row.qid}>
                            <td className="mono">{row.qid}</td>
                            <td>{row.area || '—'}</td>
                            <td className="small">{row.question_type}</td>
                            <td className="right">{row.uses} test{row.uses === 1 ? '' : 's'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}
