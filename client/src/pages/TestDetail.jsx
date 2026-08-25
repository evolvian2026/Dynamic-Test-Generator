/**
 * Test detail — preview, hybrid editing, replace, explain, versions, export
 * (spec §11, §12, §17, §19, §25).
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import QuestionModal from '../components/QuestionModal.jsx';
import ReplaceModal from '../components/ReplaceModal.jsx';
import ExplainModal from '../components/ExplainModal.jsx';
import AddQuestionsModal from '../components/AddQuestionsModal.jsx';
import {
  Card, Stat, Badge, DifficultyBadge, DistributionBar, Alert, Spinner, Modal, statusVariant,
} from '../components/ui.jsx';

export default function TestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, user } = useAuth();

  const { data: test, error, loading, reload } = useAsync(() => api.tests.get(id, { withAnswers: true }), [id]);
  const [openQid, setOpenQid] = useState(null);
  const [replaceTarget, setReplaceTarget] = useState(null);
  const [explainTarget, setExplainTarget] = useState(null);
  const [addTo, setAddTo] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const editable = test && can('tests:write') && (can('tests:read:all') || test.created_by === user.id);

  const act = async (label, fn) => {
    setBusy(true);
    try {
      const result = await fn();
      toast.success(label);
      await reload();
      return result;
    } catch (err) {
      toast.error(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !test) {
    return (<><TopBar title="Test" /><div className="page"><Spinner label="Loading test…" /></div></>);
  }
  if (error) {
    return (<><TopBar title="Test" /><div className="page"><Alert variant="error">{error.message}</Alert></div></>);
  }

  const exportButton = (format, label, params) => (
    <a className="btn btn-sm" href={api.exportUrl(test.id, format, params)} target="_blank" rel="noreferrer">{label}</a>
  );

  return (
    <>
      <TopBar
        title={test.test_name}
        subtitle={
          <>
            <span className="mono">{test.test_id}</span>
            {test.version_label && <> · Version {test.version_label}</>}
            {test.course && <> · {test.course}</>}
            {test.createdBy && <> · created by {test.createdBy.name}</>}
          </>
        }
        actions={
          <>
            <Badge variant={statusVariant(test.status)}>{test.status}</Badge>
            {editable && (
              <>
                <button
                  type="button" className="btn btn-sm" disabled={busy}
                  onClick={() => act('Test regenerated with a new seed.', () => api.tests.regenerate(test.id))}
                >
                  ↻ Regenerate
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setVersionsOpen(true)}>Create versions</button>
              </>
            )}
            {can('tests:write') && (
              <button
                type="button" className="btn btn-sm" disabled={busy}
                onClick={async () => {
                  const copy = await act('Test duplicated.', () => api.tests.duplicate(test.id));
                  if (copy) navigate(`/tests/${copy.id}`);
                }}
              >
                Duplicate
              </button>
            )}
          </>
        }
      />

      <div className="page">
        <div className="grid grid-4 mb-2">
          <Stat label="Questions" value={test.summary.totalQuestions} hint={`${test.summary.totalSections} sections`} />
          <Stat label="Total marks" value={test.summary.totalMarks} />
          <Stat label="Duration" value={`${test.duration_minutes} min`} hint={`~${test.summary.estimatedMinutes} min of content`} />
          <Stat label="Seed" value={<span className="mono" style={{ fontSize: 17 }}>{test.random_seed || '—'}</span>} hint="Reproduces this exact test" />
        </div>

        <div className="grid grid-2 mb-2">
          <Card title="Export" bodyClass="tight">
            <div className="flex-gap">
              {exportButton('pdf', '📄 Student PDF', { includeQid: test.include_qid_in_student })}
              {can('tests:write') && exportButton('answer-key.pdf', '🔑 Answer Key PDF')}
              {exportButton('xlsx', '📊 Excel')}
              {exportButton('csv', '📋 CSV')}
              {exportButton('json', '{ } JSON')}
            </div>
            <p className="field-hint mt-1">
              QID in the student version is currently <strong>{test.include_qid_in_student ? 'on' : 'off'}</strong>.
              {editable && (
                <button
                  type="button" className="btn btn-xs" style={{ marginLeft: 8 }} disabled={busy}
                  onClick={() => act('Setting updated.', () =>
                    api.tests.update(test.id, { include_qid_in_student: !test.include_qid_in_student }))}
                >
                  Turn {test.include_qid_in_student ? 'off' : 'on'}
                </button>
              )}
            </p>
          </Card>

          <Card title="Composition" bodyClass="tight">
            <span className="field-label">Difficulty</span>
            <DistributionBar counts={test.summary.byDifficulty} />
            <div className="divider" />
            <div className="flex-gap">
              {Object.entries(test.summary.byType).map(([type, count]) => (
                <Badge key={type}>{type}: {count}</Badge>
              ))}
            </div>
          </Card>
        </div>

        {test.instructions && (
          <Card title="Instructions" className="mb-2"><p className="mb-0">{test.instructions}</p></Card>
        )}

        {test.sections.map((section) => (
          <Card
            key={section.id}
            className="mb-2"
            bodyClass="tight"
            title={
              <div>
                <h3>{section.section_name}</h3>
                <span className="muted small">
                  {section.questions.length} question{section.questions.length === 1 ? '' : 's'} ·
                  {' '}{section.marks} marks · {section.marks_per_question} per question
                  {section.negative_marks > 0 && ` · −${section.negative_marks} for a wrong answer`}
                  {section.time_limit_minutes && ` · ${section.time_limit_minutes} min`}
                </span>
              </div>
            }
            actions={editable && (
              <button type="button" className="btn btn-sm" onClick={() => setAddTo(section)}>+ Add questions</button>
            )}
          >
            {section.section_description && <p className="muted small">{section.section_description}</p>}

            {section.questions.length === 0 ? (
              <p className="faint mb-0">This section has no questions.</p>
            ) : (
              section.questions.map((entry, index) => (
                <div className="question-row" key={entry.id}>
                  <span className="q-index">{index + 1}</span>
                  <div className="q-main">
                    <span className="q-text">{entry.question?.question_text || '(question no longer in the bank)'}</span>
                    <div className="q-meta">
                      <button type="button" className="qid-link" onClick={() => setOpenQid(entry.qid)}>{entry.qid}</button>
                      {entry.question && (
                        <>
                          <Badge>{entry.question.question_type}</Badge>
                          <DifficultyBadge level={entry.question.difficulty} />
                          <Badge>{entry.question.topic}</Badge>
                        </>
                      )}
                      <span className="faint small">{entry.marks} mark{entry.marks === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <div className="q-actions">
                    <button type="button" className="btn btn-xs" onClick={() => setExplainTarget(entry)} title="Why was this question selected?">
                      Why?
                    </button>
                    {editable && (
                      <>
                        <button type="button" className="btn btn-xs" onClick={() => setReplaceTarget({ entry, section })}>
                          Replace
                        </button>
                        {test.sections.length > 1 && (
                          <button type="button" className="btn btn-xs" onClick={() => setMoveTarget({ entry, section })}>
                            Move
                          </button>
                        )}
                        <button
                          type="button" className="btn btn-xs btn-ghost" disabled={busy}
                          title="Remove from test"
                          onClick={() => act('Question removed.', () => api.tests.removeQuestion(test.id, entry.id))}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </Card>
        ))}

        <div className="flex-gap">
          <Link className="btn" to="/tests">← Back to all tests</Link>
          {editable && test.status !== 'archived' && (
            <button
              type="button" className="btn" disabled={busy}
              onClick={() => act('Test archived.', () => api.tests.archive(test.id))}
            >
              Archive
            </button>
          )}
          {editable && can('tests:delete') && (
            <button
              type="button" className="btn btn-danger" disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Delete ${test.test_id} permanently? This cannot be undone.`)) return;
                const done = await act('Test deleted.', () => api.tests.remove(test.id));
                if (done) navigate('/tests');
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {openQid && <QuestionModal qid={openQid} onClose={() => setOpenQid(null)} withAnswers={can('tests:write')} />}

      {replaceTarget && (
        <ReplaceModal
          testId={test.id}
          entry={replaceTarget.entry}
          onClose={() => setReplaceTarget(null)}
          onReplaced={async () => { setReplaceTarget(null); await reload(); }}
        />
      )}

      {explainTarget && (
        <ExplainModal testId={test.id} entry={explainTarget} onClose={() => setExplainTarget(null)} />
      )}

      {addTo && (
        <AddQuestionsModal
          testId={test.id}
          section={addTo}
          usedQids={test.sections.flatMap((s) => s.questions.map((q) => q.qid))}
          onClose={() => setAddTo(null)}
          onAdded={async () => { setAddTo(null); await reload(); }}
        />
      )}

      {moveTarget && (
        <Modal title={`Move ${moveTarget.entry.qid}`} onClose={() => setMoveTarget(null)}>
          <p className="muted">Choose the section this question should move to.</p>
          {test.sections.filter((s) => s.id !== moveTarget.section.id).map((section) => (
            <button
              key={section.id}
              type="button"
              className="btn btn-block mb-1"
              disabled={busy}
              onClick={async () => {
                await act(`Moved to ${section.section_name}.`, () =>
                  api.tests.moveQuestion(test.id, moveTarget.entry.id, section.id));
                setMoveTarget(null);
              }}
            >
              {section.section_name} ({section.questions.length} questions)
            </button>
          ))}
        </Modal>
      )}

      {versionsOpen && (
        <VersionsModal
          test={test}
          onClose={() => setVersionsOpen(false)}
          onCreated={async () => { setVersionsOpen(false); await reload(); }}
        />
      )}
    </>
  );
}

/** Multiple versions of the same blueprint (spec §17). */
function VersionsModal({ test, onClose, onCreated }) {
  const toast = useToast();
  const [count, setCount] = useState(3);
  const [unique, setUnique] = useState(true);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.tests.versions(test.id, { count, uniqueAcrossVersions: unique });
      setCreated(result);
      toast.success(`${result.length} version(s) created.`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Generate test versions"
      onClose={onClose}
      footer={
        created
          ? <button type="button" className="btn btn-primary" onClick={onCreated}>Done</button>
          : (
            <>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
                {busy ? 'Generating…' : `Generate ${count} version${count === 1 ? '' : 's'}`}
              </button>
            </>
          )
      }
    >
      {!created ? (
        <>
          <p className="muted">
            Each version follows the same selection rules and keeps the same difficulty and topic
            distribution, but draws different QIDs.
          </p>
          <div className="field">
            <label htmlFor="version-count">Number of versions</label>
            <input
              id="version-count" type="number" min="1" max="12" value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </div>
          <div className="checkbox-row">
            <input id="version-unique" type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
            <label htmlFor="version-unique">
              No question may appear in more than one version
              <span className="field-hint">Turn this off if the bank is too small to keep the versions disjoint.</span>
            </label>
          </div>
        </>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Version</th><th>Test ID</th><th className="right">Questions</th><th className="right">Marks</th><th /></tr></thead>
            <tbody>
              {created.map((version) => (
                <tr key={version.id}>
                  <td><Badge variant="brand">{version.label}</Badge></td>
                  <td className="mono">{version.test_id}</td>
                  <td className="right">{version.question_count}</td>
                  <td className="right">{version.total_marks}</td>
                  <td><Link to={`/tests/${version.id}`} onClick={onClose}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          {created.some((v) => v.warnings?.length) && (
            <Alert variant="warning" title="Some versions are short">
              <ul>
                {created.flatMap((v) => (v.warnings || []).map((w, i) => <li key={`${v.label}-${i}`}>Version {v.label}: {w.message}</li>))}
              </ul>
            </Alert>
          )}
        </div>
      )}
    </Modal>
  );
}
