/** Replace one question with another matching the same rule (spec §12). */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { Modal, Badge, DifficultyBadge, Spinner, Alert, EmptyState } from './ui.jsx';

export default function ReplaceModal({ testId, entry, onClose, onReplaced }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setData(null);
    api.tests.replacements(testId, entry.id, 12)
      .then(setData)
      .catch((err) => setError(err.message));
  };

  useEffect(load, [testId, entry.id]);

  const replace = async (qid) => {
    setBusy(true);
    try {
      await api.tests.replace(testId, entry.id, qid);
      toast.success(`${entry.qid} replaced with ${qid}.`);
      onReplaced();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      size="lg"
      title={`Replace ${entry.qid}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {data ? `${data.available.toLocaleString()} other questions match this section's rule` : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={load} disabled={busy}>↻ Show different options</button>
        </>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      <Alert variant="info">
        Replacements are drawn using this question's original selection rule, so the section
        configuration stays exactly as you defined it.
      </Alert>

      <div className="question-row mb-2" style={{ borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
        <span className="q-index">now</span>
        <div className="q-main">
          <span className="q-text">{entry.question?.question_text}</span>
          <div className="q-meta">
            <span className="mono small">{entry.qid}</span>
            {entry.question && (
              <>
                <Badge>{entry.question.question_type}</Badge>
                <DifficultyBadge level={entry.question.difficulty} />
                <Badge>{entry.question.topic}</Badge>
              </>
            )}
          </div>
        </div>
      </div>

      <span className="field-label">Replacement options</span>
      {!data && !error && <Spinner label="Finding alternatives…" />}
      {data && data.candidates.length === 0 && (
        <EmptyState title="No alternatives available" icon="⌕">
          Every other question matching this rule is already used in this test.
        </EmptyState>
      )}
      {data?.candidates.map((candidate) => (
        <div className="question-row" key={candidate.qid}>
          <div className="q-main">
            <span className="q-text">{candidate.question_text}</span>
            <div className="q-meta">
              <span className="mono small">{candidate.qid}</span>
              <Badge>{candidate.question_type}</Badge>
              <DifficultyBadge level={candidate.difficulty} />
              <Badge>{candidate.topic}</Badge>
              {candidate.subtopic && <span className="faint small">{candidate.subtopic}</span>}
              <span className="faint small">{candidate.marks} marks</span>
            </div>
          </div>
          <div className="q-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => replace(candidate.qid)}>
              Use this
            </button>
          </div>
        </div>
      ))}
    </Modal>
  );
}
