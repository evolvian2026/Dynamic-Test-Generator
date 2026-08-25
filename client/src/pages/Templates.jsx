/** Test templates (spec §16) and the smart blueprint generator (spec §26). */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import { Card, Badge, Alert, Spinner, EmptyState, Modal } from '../components/ui.jsx';

export default function Templates() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const { data: templates, loading, reload } = useAsync(() => api.templates.list(), []);
  const { data: blueprints } = useAsync(() => api.templates.blueprints(), []);
  const [smartOpen, setSmartOpen] = useState(false);

  const remove = async (template) => {
    if (!window.confirm(`Delete the template "${template.template_name}"?`)) return;
    try {
      await api.templates.remove(template.id);
      toast.success('Template deleted.');
      reload();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <>
      <TopBar
        title="Test Templates"
        subtitle="Save a test-generation configuration once, then reuse it whenever you need a fresh test."
        actions={can('tests:write') && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setSmartOpen(true)}>
            ✨ Smart Generator
          </button>
        )}
      />

      <div className="page">
        <Alert variant="info" title="Blueprints never invent questions">
          A blueprint only describes the shape of a test — how many questions, which difficulty mix,
          which subjects and areas. Every question is still drawn from your existing bank by QID.
        </Alert>

        {loading && !templates && <Spinner label="Loading templates…" />}

        <div className="grid grid-2">
          {(templates || []).map((template) => {
            const config = template.configuration || {};
            const sections = config.sections || [];
            const totalQuestions = sections.reduce((a, s) => a + (Number(s.question_count) || 0), 0);
            const totalMarks = sections.reduce((a, s) => a + (Number(s.question_count) || 0) * (Number(s.marks_per_question) || 0), 0);

            return (
              <Card
                key={template.id}
                title={
                  <div>
                    <h3>{template.template_name}</h3>
                    <span className="muted small">{template.description || 'No description'}</span>
                  </div>
                }
                actions={can('templates:write') && (
                  <button type="button" className="btn btn-xs btn-ghost" onClick={() => remove(template)} aria-label="Delete template">✕</button>
                )}
              >
                <div className="flex-gap mb-2">
                  <Badge variant="brand">{sections.length} section{sections.length === 1 ? '' : 's'}</Badge>
                  <Badge>{totalQuestions} questions</Badge>
                  <Badge>{totalMarks} marks</Badge>
                  {config.test?.duration_minutes && <Badge>{config.test.duration_minutes} min</Badge>}
                </div>

                {sections.map((section, i) => (
                  <div className="summary-line" key={i}>
                    <span className="label">{section.section_name}</span>
                    <span className="value">
                      {section.question_count} × {section.marks_per_question}
                      {section.distribution?.values && (
                        <span className="faint small">
                          {' '}({Object.entries(section.distribution.values).map(([k, v]) => `${k} ${v}${section.distribution.mode === 'count' ? '' : '%'}`).join(' / ')})
                        </span>
                      )}
                    </span>
                  </div>
                ))}

                <div className="divider" />
                <div className="flex-gap">
                  {can('tests:write') && (
                    <Link className="btn btn-sm btn-primary" to={`/create?template=${template.id}`}>
                      Use this template
                    </Link>
                  )}
                  <span className="faint small">by {template.created_by_name || 'system'}</span>
                </div>
              </Card>
            );
          })}
        </div>

        {templates && templates.length === 0 && (
          <EmptyState
            title="No templates yet"
            icon="❑"
            action={can('tests:write') && <Link className="btn btn-primary" to="/create">Build a test and save it as a template</Link>}
          >
            Templates capture section rules, distributions and settings for reuse.
          </EmptyState>
        )}

        {blueprints?.length > 0 && (
          <>
            <h2 className="mt-3 mb-2">Predefined blueprints</h2>
            <div className="grid grid-3">
              {blueprints.map((blueprint) => (
                <Card key={blueprint.id} title={blueprint.name}>
                  <p className="muted small">{blueprint.description}</p>
                  <div className="flex-gap mb-2">
                    <Badge variant="brand">{blueprint.totalQuestions} questions</Badge>
                    {Object.entries(blueprint.difficultyMix).map(([level, pct]) => (
                      <Badge key={level} variant={{ Easy: 'easy', Medium: 'medium', Hard: 'hard' }[level]}>
                        {level} {pct}%
                      </Badge>
                    ))}
                  </div>
                  <div className="flex-gap mb-2">
                    {(blueprint.subjects || []).map((subject) => (
                      <Badge key={subject} variant="brand">{subject}</Badge>
                    ))}
                    {(blueprint.areas || []).slice(0, 4).map((area) => <Badge key={area}>{area}</Badge>)}
                    {(blueprint.areas || []).length > 4 && (
                      <span className="faint small">+{blueprint.areas.length - 4} more areas</span>
                    )}
                  </div>
                  {can('tests:write') && (
                    <Link className="btn btn-sm btn-block" to={`/create?blueprint=${blueprint.id}`}>
                      Generate from this blueprint
                    </Link>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      {smartOpen && <SmartGeneratorModal onClose={() => setSmartOpen(false)} onApply={(id) => navigate(`/create?blueprint=${id}`)} />}
    </>
  );
}

/** Smart Test Generator (spec §26) — configure a blueprint, check feasibility, then build. */
function SmartGeneratorModal({ onClose, onApply }) {
  const toast = useToast();
  const { data: blueprints } = useAsync(() => api.templates.blueprints(), []);
  const { data: meta } = useAsync(() => api.questions.metadata(), []);

  const [blueprintId, setBlueprintId] = useState('');
  const [totalQuestions, setTotalQuestions] = useState(50);
  const [mix, setMix] = useState({ Easy: 20, Medium: 50, Hard: 30 });
  const [subjects, setSubjects] = useState([]);
  const [areas, setAreas] = useState([]);
  const [areaOptions, setAreaOptions] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const chooseBlueprint = (id) => {
    setBlueprintId(id);
    const blueprint = blueprints?.find((b) => b.id === id);
    if (blueprint) {
      setTotalQuestions(blueprint.totalQuestions);
      setMix(blueprint.difficultyMix);
      setSubjects(blueprint.subjects || []);
      setAreas(blueprint.areas || []);
    }
  };

  const expand = async () => {
    setBusy(true);
    try {
      const data = await api.templates.expandBlueprint({
        blueprintId: blueprintId || undefined,
        totalQuestions,
        difficultyMix: mix,
        subjects,
        areas,
      });
      setResult(data);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!subjects.length) { setAreaOptions([]); return () => { cancelled = true; }; }
    api.questions.facet('area', subjects)
      .then((rows) => !cancelled && setAreaOptions(rows))
      .catch(() => !cancelled && setAreaOptions([]));
    return () => { cancelled = true; };
  }, [subjects.join('|')]);

  const mixTotal = Object.values(mix).reduce((a, v) => a + Number(v || 0), 0);

  return (
    <Modal
      size="lg"
      title="Smart Test Generator"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={expand} disabled={busy || Math.abs(mixTotal - 100) > 0.5}>
            {busy ? 'Working…' : 'Preview blueprint'}
          </button>
          {result && (
            <button type="button" className="btn btn-primary" onClick={() => onApply(blueprintId || 'dsa-placement')}>
              Open in builder →
            </button>
          )}
        </>
      }
    >
      <p className="muted">
        Describe the test you want and the system turns it into concrete sections with concrete
        selection rules. Questions always come from the existing bank.
      </p>

      <div className="field">
        <label htmlFor="blueprint">Start from a blueprint</label>
        <select id="blueprint" value={blueprintId} onChange={(e) => chooseBlueprint(e.target.value)}>
          <option value="">Custom</option>
          {(blueprints || []).map((b) => <option key={b.id} value={b.id}>{b.name} — {b.totalQuestions} questions</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="total">Total questions</label>
        <input id="total" type="number" min="1" max="500" value={totalQuestions} onChange={(e) => setTotalQuestions(Number(e.target.value))} />
      </div>

      <div className="field">
        <span className="field-label">Difficulty mix (must total 100%)</span>
        <div className="form-row">
          {['Easy', 'Medium', 'Hard'].map((level) => (
            <div key={level} className="flex-gap">
              <span style={{ minWidth: 60 }}>{level}</span>
              <input
                type="number" min="0" max="100" value={mix[level] ?? 0}
                onChange={(e) => setMix({ ...mix, [level]: Number(e.target.value) })}
              />
              <span className="muted">%</span>
            </div>
          ))}
        </div>
        <span className={`field-hint ${Math.abs(mixTotal - 100) > 0.5 ? 'badge badge-warning' : ''}`}>
          Total: {mixTotal}%{Math.abs(mixTotal - 100) > 0.5 ? ' — adjust to 100%' : ' ✓'}
        </span>
      </div>

      <div className="field">
        <span className="field-label">Subjects</span>
        <div className="chip-select">
          {(meta?.subjects || []).map((subject) => (
            <button
              key={subject.value}
              type="button"
              className={`chip${subjects.includes(subject.value) ? ' selected' : ''}`}
              onClick={() => {
                const next = subjects.includes(subject.value)
                  ? subjects.filter((t) => t !== subject.value)
                  : [...subjects, subject.value];
                setSubjects(next);
                // Areas belong to subjects, so drop any that no longer apply.
                setAreas((current) => current.filter((a) =>
                  areaOptions.some((o) => o.value === a && next.includes(o.subject))));
              }}
            >
              {subject.value}<span className="chip-count">{subject.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>

      {subjects.length > 0 && (
        <div className="field">
          <span className="field-label">
            Areas <span className="faint">· optional, leave empty for the whole subject</span>
          </span>
          <div className="chip-select">
            {areaOptions.slice(0, 40).map((area) => (
              <button
                key={`${area.subject}-${area.value}`}
                type="button"
                className={`chip${areas.includes(area.value) ? ' selected' : ''}`}
                title={`${area.subject} › ${area.value}`}
                onClick={() => setAreas(areas.includes(area.value)
                  ? areas.filter((a) => a !== area.value)
                  : [...areas, area.value])}
              >
                {area.value}<span className="chip-count">{area.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="divider" />
          <h3 className="mb-1">Generated blueprint</h3>
          <div className="flex-gap mb-2">
            <Badge variant="brand">{result.totalQuestions} questions</Badge>
            <Badge>{result.totalMarks} marks</Badge>
            <Badge>{result.sections.length} sections</Badge>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Section</th><th className="right">Questions</th><th className="right">Marks each</th><th>Availability</th></tr></thead>
              <tbody>
                {result.sections.map((section, i) => {
                  const feasibility = result.feasibility[i];
                  const ok = feasibility.available >= feasibility.requested;
                  return (
                    <tr key={section.section_name}>
                      <td>{section.section_name}</td>
                      <td className="right">{section.question_count}</td>
                      <td className="right">{section.marks_per_question}</td>
                      <td>
                        <Badge variant={ok ? 'success' : 'warning'}>
                          {ok ? '✓' : '⚠'} {feasibility.available.toLocaleString()} available
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
