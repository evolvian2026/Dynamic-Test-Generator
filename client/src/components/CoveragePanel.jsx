/**
 * Blueprint coverage for a generated test.
 *
 * Availability asks "can this section be filled?". This asks the question a
 * designer actually cares about afterwards: did the test cover what I intended,
 * in the proportions I intended?
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Card, Alert, Badge, Spinner, EmptyState } from './ui.jsx';

const STATUS = {
  met: { variant: 'success', label: 'met' },
  under: { variant: 'warning', label: 'under' },
  over: { variant: 'warning', label: 'over' },
  not_specified: { variant: undefined, label: 'not specified' },
};

export default function CoveragePanel({ testId }) {
  const [axes, setAxes] = useState([]);
  const [axis, setAxis] = useState('difficulty');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.tests.coverageAxes(testId).then(setAxes).catch(() => setAxes([]));
  }, [testId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.tests.coverage(testId, axis)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [testId, axis]);

  return (
    <Card
      title="Blueprint coverage"
      bodyClass="tight"
      actions={
        <select value={axis} onChange={(e) => setAxis(e.target.value)} style={{ width: 'auto' }} aria-label="Coverage axis">
          {axes.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}
      {loading && !data && <Spinner label="Comparing intent with outcome…" />}

      {data && (
        <>
          {!data.coverageKnown ? (
            <EmptyState title="No intent was stated on this axis" icon="◔">
              The sections did not specify a distribution or a single value for {data.axisLabel.toLowerCase()},
              so there is nothing to compare against. The actual spread is still shown below.
            </EmptyState>
          ) : (
            <Alert variant={data.met ? 'success' : 'warning'}>
              {data.met
                ? `The test matches its intended ${data.axisLabel.toLowerCase()} distribution exactly.`
                : `${data.gaps.length} value(s) differ from what the sections asked for.`}
            </Alert>
          )}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{data.axisLabel}</th>
                  <th className="right">Intended</th>
                  <th className="right">Actual</th>
                  <th className="right">Difference</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.value}>
                    <td>{row.value}</td>
                    <td className="right">{row.intended ?? <span className="faint">—</span>}</td>
                    <td className="right">{row.actual}</td>
                    <td className="right">
                      {row.difference === null
                        ? <span className="faint">—</span>
                        : row.difference === 0 ? '0' : row.difference > 0 ? `+${row.difference}` : row.difference}
                    </td>
                    <td><Badge variant={STATUS[row.status].variant}>{STATUS[row.status].label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.note && <p className="field-hint mt-1">{data.note}</p>}
          <p className="field-hint">
            A question classified under several branches counts towards each of them, so totals on taxonomy
            axes can exceed the number of questions.
          </p>
        </>
      )}
    </Card>
  );
}
