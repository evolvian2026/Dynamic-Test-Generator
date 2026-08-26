/**
 * Observed performance for one question.
 *
 * Shows what the responses actually say — how many got it right, whether it
 * separates strong candidates from weak ones, and how each distractor behaved —
 * next to the difficulty an author assigned, so a disagreement is visible.
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Modal, Alert, Badge, Spinner, EmptyState } from './ui.jsx';

const pct = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);

function Meter({ value, min = 0, max = 1, tone = 'var(--brand)' }) {
  if (value === null || value === undefined) return <span className="faint">—</span>;
  const width = Math.max(2, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <span className="availability-meter" style={{ display: 'block', color: tone }}>
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

/** Discrimination bands, so a number means something without a textbook. */
function discriminationTone(value) {
  if (value === null || value === undefined) return { variant: undefined, label: 'not available' };
  if (value < 0) return { variant: 'danger', label: 'negative — check the key' };
  if (value < 0.1) return { variant: 'warning', label: 'poor' };
  if (value < 0.2) return { variant: 'warning', label: 'marginal' };
  if (value < 0.3) return { variant: 'success', label: 'acceptable' };
  return { variant: 'success', label: 'good' };
}

const FLAG_LABEL = {
  too_easy: 'Almost everyone answers this correctly',
  too_hard: 'Almost nobody answers this correctly',
  harder_than_labelled: 'Performs harder than its label',
  easier_than_labelled: 'Performs easier than its label',
};

export default function ItemAnalyticsModal({ qid, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.questions.analytics(qid).then(setData).catch((e) => setError(e.message));
  }, [qid]);

  return (
    <Modal size="lg" title={<h2>Item analytics · <span className="mono">{qid}</span></h2>} onClose={onClose}>
      {error && <Alert variant="error">{error}</Alert>}
      {!data && !error && <Spinner label="Loading responses…" />}

      {data && !data.statistics && (
        <EmptyState title="No responses recorded yet" icon="◔">
          Item statistics appear once results for a test containing this question have been imported.
        </EmptyState>
      )}

      {data?.statistics && (
        <>
          <div className="grid grid-4 mb-2">
            <div className="stat">
              <div className="stat-label">Responses</div>
              <div className="stat-value">{data.statistics.responses}</div>
              <div className="stat-hint">{data.statistics.correctResponses} correct</div>
            </div>
            <div className="stat">
              <div className="stat-label">p-value (observed difficulty)</div>
              <div className="stat-value">{pct(data.statistics.pValue)}</div>
              <Meter value={data.statistics.pValue} />
              <div className="stat-hint">higher means easier</div>
            </div>
            <div className="stat">
              <div className="stat-label">Discrimination</div>
              <div className="stat-value">{data.statistics.discrimination?.toFixed(2) ?? '—'}</div>
              <div className="stat-hint">
                <Badge variant={discriminationTone(data.statistics.discrimination).variant}>
                  {discriminationTone(data.statistics.discrimination).label}
                </Badge>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Labelled difficulty</div>
              <div className="stat-value" style={{ fontSize: 20 }}>{data.labelledDifficulty}</div>
              {data.statistics.difficultyFlag && (
                <div className="stat-hint"><Badge variant="warning">{FLAG_LABEL[data.statistics.difficultyFlag]}</Badge></div>
              )}
            </div>
          </div>

          {data.statistics.interpretation?.length > 0 && (
            <Alert variant={data.statistics.discrimination < 0 ? 'error' : 'info'} title="What this means">
              <ul>{data.statistics.interpretation.map((note, i) => <li key={i}>{note}</li>)}</ul>
            </Alert>
          )}

          {data.distractors.length > 0 && (
            <>
              <span className="field-label">Distractor analysis</span>
              <p className="field-hint mb-1">
                How often each option was chosen, and the mean total score of the candidates who chose it.
                A wrong option picked mainly by strong candidates suggests the key or the wording is off.
              </p>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Option</th><th className="right">Picked</th><th className="right">Share</th><th className="right">Mean total score</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.distractors.map((d, i) => (
                      <tr key={i}>
                        <td>
                          {d.option}
                          {d.isCorrect && <Badge variant="success" >key</Badge>}
                        </td>
                        <td className="right">{d.picks}</td>
                        <td className="right">{pct(d.share)}</td>
                        <td className="right">{d.meanTotalScore ?? '—'}</td>
                        <td>{d.dead && <Badge variant="warning">never chosen</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.deadDistractors > 0 && (
                <p className="field-hint">
                  {data.deadDistractors} distractor(s) were never chosen — they add length without adding discrimination.
                </p>
              )}
            </>
          )}

          <p className="field-hint mt-2">Computed {String(data.statistics.computedAt).slice(0, 16)}.</p>
        </>
      )}
    </Modal>
  );
}
