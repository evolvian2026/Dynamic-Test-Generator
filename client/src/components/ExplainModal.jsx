/** "Why was this question selected?" (spec §25). */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Modal, Badge, Spinner, Alert } from './ui.jsx';

export default function ExplainModal({ testId, entry, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.tests.explain(testId, entry.id).then(setData).catch((err) => setError(err.message));
  }, [testId, entry.id]);

  return (
    <Modal title={`Why was ${entry.qid} selected?`} onClose={onClose}>
      {error && <Alert variant="error">{error}</Alert>}
      {!data && !error && <Spinner label="Checking the selection rule…" />}

      {data && (
        <>
          <p className="muted">{entry.question?.question_text}</p>

          <div className="flex-gap mb-2">
            <Badge variant={data.matched ? 'success' : 'danger'}>
              {data.matched ? '✓ Matches every criterion' : '✕ No longer matches'}
            </Badge>
            <Badge>Section: {data.section}</Badge>
            <Badge>Pool: {data.poolSize.toLocaleString()} eligible</Badge>
            {data.seed && <Badge>Seed: {data.seed}</Badge>}
          </div>

          <span className="field-label">Selected because</span>
          <ul className="criteria-list">
            {data.criteria.map((criterion, i) => (
              <li key={i}>
                <span className={`criteria-mark ${criterion.passed ? 'pass' : 'fail'}`}>
                  {criterion.passed ? '✓' : '✕'}
                </span>
                <span>
                  {criterion.criterion}
                  {criterion.actual && <span className="faint small"> — this question: {criterion.actual}</span>}
                </span>
              </li>
            ))}
          </ul>

          {data.bucket && (
            <p className="field-hint mt-2">
              Drawn from the <strong>{data.bucket}</strong> slice of the section's distribution.
            </p>
          )}

          <Alert variant="info" title="How the pick was made">
            The engine filtered the bank down to {data.poolSize.toLocaleString()} eligible questions and drew
            from that pool using the test's seed. The same seed and rules always reproduce the same selection.
          </Alert>
        </>
      )}
    </Modal>
  );
}
