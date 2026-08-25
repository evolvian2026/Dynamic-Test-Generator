/** Generated-selection preview shown inside the builder (spec §11). */

import { useState } from 'react';
import QuestionModal from './QuestionModal.jsx';
import { Badge, DifficultyBadge, Alert, Card } from './ui.jsx';

export default function PreviewPanel({ preview, sections, onRegenerate, busy }) {
  const [openQid, setOpenQid] = useState(null);

  const totalDelivered = preview.sections.reduce((a, s) => a + s.delivered, 0);
  const totalMarks = preview.sections.reduce((a, s) => a + s.marks, 0);

  return (
    <>
      <div className="flex-between mb-2">
        <h2>Preview</h2>
        <div className="flex-gap">
          <span className="muted small">Seed <code>{preview.seed}</code></span>
          <button type="button" className="btn btn-sm" onClick={onRegenerate} disabled={busy}>
            ↻ Re-randomize
          </button>
        </div>
      </div>

      {preview.warnings?.length > 0 && (
        <Alert variant="warning" title="Some sections could not be filled completely">
          <ul>{preview.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
        </Alert>
      )}

      <Card title="Section Summary" className="mb-2" bodyClass="tight">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Section</th><th className="right">Questions</th><th className="right">Marks</th><th>Status</th></tr>
            </thead>
            <tbody>
              {preview.sections.map((section, i) => (
                <tr key={i}>
                  <td>{section.sectionName}</td>
                  <td className="right">
                    {section.delivered}
                    {section.shortfall > 0 && <span className="faint"> / {section.requested}</span>}
                  </td>
                  <td className="right">{section.marks}</td>
                  <td>
                    {section.shortfall > 0
                      ? <Badge variant="warning">{section.shortfall} short</Badge>
                      : <Badge variant="success">complete</Badge>}
                  </td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td className="right"><strong>{totalDelivered}</strong></td>
                <td className="right"><strong>{totalMarks}</strong></td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {preview.sections.map((section, sectionIndex) => (
        <Card
          key={sectionIndex}
          className="mb-2"
          title={
            <div>
              <h3>{section.sectionName}</h3>
              <span className="muted small">
                {section.delivered} question{section.delivered === 1 ? '' : 's'} · {section.marks} marks
                {sections?.[sectionIndex]?.rule && (
                  <> · {describeRule(sections[sectionIndex].rule) || 'no filters'}</>
                )}
              </span>
            </div>
          }
          bodyClass="tight"
        >
          {section.questions.length === 0 ? (
            <p className="faint mb-0">No questions were selected for this section.</p>
          ) : (
            section.questions.map((entry, i) => (
              <div className="question-row" key={entry.qid}>
                <span className="q-index">{i + 1}</span>
                <div className="q-main">
                  <span className="q-text">{entry.question?.question_text || '(question unavailable)'}</span>
                  <div className="q-meta">
                    <button type="button" className="qid-link" onClick={() => setOpenQid(entry.qid)}>{entry.qid}</button>
                    {entry.question && (
                      <>
                        <Badge>{entry.question.question_type}</Badge>
                        <DifficultyBadge level={entry.question.difficulty} />
                        <Badge>{entry.question.topic}</Badge>
                        {entry.question.subtopic && <span className="faint small">{entry.question.subtopic}</span>}
                      </>
                    )}
                    <span className="faint small">{entry.marks} mark{entry.marks === 1 ? '' : 's'}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </Card>
      ))}

      {openQid && <QuestionModal qid={openQid} onClose={() => setOpenQid(null)} />}
    </>
  );
}

function describeRule(rule) {
  const parts = [];
  if (rule.question_type?.length) parts.push(rule.question_type.join('/'));
  if (rule.topic?.length) parts.push(rule.topic.join(', '));
  if (rule.subtopic?.length) parts.push(rule.subtopic.join(', '));
  if (rule.difficulty?.length) parts.push(rule.difficulty.join('/'));
  if (rule.includeTags?.length) parts.push(`+${rule.includeTags.join(', ')}`);
  if (rule.excludeTags?.length) parts.push(`−${rule.excludeTags.join(', ')}`);
  return parts.join(' · ');
}
