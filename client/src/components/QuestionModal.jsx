/** Full question preview — opened by clicking a QID anywhere in the app (spec §11). */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { Modal, Badge, DifficultyBadge, Spinner, Alert } from './ui.jsx';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export default function QuestionModal({ qid, onClose, withAnswers = false }) {
  const [question, setQuestion] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.questions.byQid(qid, withAnswers)
      .then((data) => !cancelled && setQuestion(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [qid, withAnswers]);

  return (
    <Modal title={<h2 className="mono">{qid}</h2>} onClose={onClose}>
      {error && <Alert variant="error">{error}</Alert>}
      {!question && !error && <Spinner label="Loading question…" />}

      {question && (
        <>
          <div className="flex-gap mb-2">
            <Badge variant="brand">{question.question_type}</Badge>
            <DifficultyBadge level={question.difficulty} />
            <Badge>{question.topic}</Badge>
            {question.subtopic && <Badge>{question.subtopic}</Badge>}
            <Badge>{question.marks} mark{question.marks === 1 ? '' : 's'}</Badge>
            <Badge>{Math.round(question.expected_seconds / 60)} min</Badge>
            <Badge variant={question.status === 'active' ? 'success' : undefined}>{question.status}</Badge>
          </div>

          <p style={{ fontSize: 14.5, lineHeight: 1.6 }}>{question.question_text}</p>

          {question.options?.length > 0 && (
            <div className="mt-2">
              {question.options.map((option, i) => (
                <div
                  key={option.id}
                  className="question-row"
                  style={option.is_correct ? { borderColor: 'var(--success)', background: 'var(--success-soft)' } : undefined}
                >
                  <span className="q-index">{LETTERS[i]}</span>
                  <span className="q-main">{option.option_text}</span>
                  {option.is_correct && <Badge variant="success">correct</Badge>}
                </div>
              ))}
            </div>
          )}

          {question.answer_text && (
            <div className="alert alert-success mt-2">
              <span className="alert-icon">✓</span>
              <div className="alert-body"><strong>Model answer</strong><div>{question.answer_text}</div></div>
            </div>
          )}
          {question.explanation && (
            <div className="alert alert-info mt-1">
              <span className="alert-icon">ℹ</span>
              <div className="alert-body"><strong>Explanation</strong><div>{question.explanation}</div></div>
            </div>
          )}

          {question.tags?.length > 0 && (
            <>
              <div className="divider" />
              <span className="field-label">Tags</span>
              <div className="flex-gap">{question.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>
            </>
          )}

          {Object.keys(question.attributes || {}).length > 0 && (
            <>
              <div className="divider" />
              <span className="field-label">Metadata</span>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {Object.entries(question.attributes).map(([key, value]) => (
                      <tr key={key}>
                        <td className="muted nowrap" style={{ width: 180 }}>{key.replace(/_/g, ' ')}</td>
                        <td>{Array.isArray(value) ? value.join(', ') : String(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
