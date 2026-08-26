/**
 * Near-duplicate report for the bank.
 *
 * Duplicate prevention elsewhere works on QID, so it cannot see two *different*
 * QIDs carrying the same question — which is what banks assembled from several
 * sources are full of. A test that draws both looks correct and is not.
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { Card, Alert, Badge, Spinner, EmptyState } from './ui.jsx';

export default function DuplicatesPanel({ onOpen }) {
  const toast = useToast();
  const [groups, setGroups] = useState(null);
  const [threshold, setThreshold] = useState(0.6);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = (value = threshold) => {
    setLoading(true);
    setError(null);
    api.questions.duplicates({ threshold: value, limit: 50 })
      .then((data) => setGroups(data.groups))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <Card
      title="Possible duplicate questions"
      bodyClass="tight"
      actions={
        <div className="flex-gap">
          <select
            value={threshold}
            onChange={(e) => { const v = Number(e.target.value); setThreshold(v); load(v); }}
            style={{ width: 'auto' }}
            aria-label="Similarity threshold"
          >
            <option value={0.5}>50% similar or more</option>
            <option value={0.6}>60% similar or more</option>
            <option value={0.8}>80% similar or more</option>
            <option value={0.95}>95% similar or more</option>
          </select>
          <button
            type="button" className="btn btn-sm"
            onClick={async () => {
              try {
                const r = await api.questions.reindexDuplicates();
                toast.success(`Reindexed ${r.updated} question(s).`);
                load();
              } catch (e) { toast.error(e.message); }
            }}
          >
            ↻ Reindex
          </button>
        </div>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}
      {loading && !groups && <Spinner label="Comparing question text…" />}

      {groups && groups.length === 0 && (
        <EmptyState title="No duplicates found at this threshold" icon="✓">
          Lower the threshold to catch looser matches, or reindex if questions were imported before
          duplicate detection was enabled.
        </EmptyState>
      )}

      {groups?.length > 0 && (
        <>
          <Alert variant="warning">
            {groups.length} group(s) of near-identical questions. Retiring the redundant copies keeps a test
            from unknowingly asking the same thing twice under two QIDs.
          </Alert>
          {groups.map((group, index) => (
            <div className="section-card" key={index}>
              <div className="section-head">
                <div className="section-head-main">
                  <Badge variant="warning">{group.size} similar</Badge>
                  <span className="muted small">{Math.round(group.similarity * 100)}% match</span>
                </div>
              </div>
              <div className="section-body">
                {group.questions.map((question) => (
                  <div className="question-row" key={question.id}>
                    <div className="q-main">
                      <span className="q-text">{question.question_text}</span>
                      <div className="q-meta">
                        <button type="button" className="qid-link" onClick={() => onOpen?.(question.qid)}>{question.qid}</button>
                        <Badge>{question.question_type}</Badge>
                        <Badge>{question.difficulty}</Badge>
                        <Badge variant={question.status === 'active' ? 'success' : undefined}>{question.status}</Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}
