/**
 * Create Test — the multi-step builder (spec §3, §4, §8, §11, §23).
 *
 * Layout follows the spec's suggested three-panel test-builder:
 *   left   — test configuration and filters
 *   centre — sections and selected questions
 *   right  — live test summary
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useToast } from '../components/Toast.jsx';
import SectionEditor from '../components/SectionEditor.jsx';
import ManualPicker from '../components/ManualPicker.jsx';
import PreviewPanel from '../components/PreviewPanel.jsx';
import { Alert, Card, DistributionBar, Spinner } from '../components/ui.jsx';

const STEPS = [
  { key: 'info', label: 'Test Information' },
  { key: 'sections', label: 'Sections & Rules' },
  { key: 'generate', label: 'Generate' },
  { key: 'preview', label: 'Preview & Save' },
];

const newSection = (index) => ({
  section_name: `Section ${index + 1}`,
  section_description: '',
  section_order: index + 1,
  question_count: 10,
  marks_per_question: 1,
  negative_marks: 0,
  time_limit_minutes: null,
  rule: {},
  distribution: null,
  qids: [],
  randomize: true,
});

const emptyTest = {
  test_name: '',
  description: '',
  course: '',
  duration_minutes: 60,
  instructions: 'Read every question carefully. All questions are compulsory unless stated otherwise.',
  starts_at: '',
  ends_at: '',
  status: 'draft',
  randomize_questions: true,
  randomize_options: true,
  prevent_duplicates: true,
  include_qid_in_student: false,
  random_seed: '',
};

export default function CreateTest() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();

  const [step, setStep] = useState('info');
  const [test, setTest] = useState(emptyTest);
  const [sections, setSections] = useState([newSection(0)]);
  const [mode, setMode] = useState('automatic');
  const [preview, setPreview] = useState(null);
  const [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [manualFor, setManualFor] = useState(null);

  const { data: meta } = useAsync(() => api.questions.metadata(), []);

  // Loading a template pre-fills the whole builder (spec §16).
  useEffect(() => {
    const templateId = params.get('template');
    if (!templateId) return;
    api.templates.get(templateId)
      .then((template) => {
        const config = template.configuration || {};
        setTest((current) => ({ ...current, ...(config.test || {}) }));
        if (config.sections?.length) {
          setSections(config.sections.map((s, i) => ({ ...newSection(i), ...s })));
        }
        toast.success(`Loaded template "${template.template_name}"`);
        setStep('sections');
      })
      .catch((error) => toast.error(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('template')]);

  // A blueprint from the smart generator arrives the same way (spec §26).
  useEffect(() => {
    const blueprint = params.get('blueprint');
    if (!blueprint) return;
    api.templates.expandBlueprint({ blueprintId: blueprint })
      .then((result) => {
        setSections(result.sections.map((s, i) => ({ ...newSection(i), ...s })));
        setTest((current) => ({ ...current, test_name: current.test_name || result.blueprint?.name || '' }));
        toast.success(`Blueprint expanded into ${result.sections.length} section(s)`);
        setStep('sections');
      })
      .catch((error) => toast.error(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('blueprint')]);

  const patchTest = (changes) => setTest((current) => ({ ...current, ...changes }));

  const updateSection = useCallback((index, next) => {
    setSections((current) => current.map((s, i) => (i === index ? next : s)));
  }, []);

  const totals = useMemo(() => {
    const questions = sections.reduce((a, s) => a + (Number(s.question_count) || 0), 0);
    const marks = sections.reduce((a, s) => a + (Number(s.question_count) || 0) * (Number(s.marks_per_question) || 0), 0);
    return { questions, marks };
  }, [sections]);

  const previewDifficulty = useMemo(() => {
    if (!preview) return null;
    const counts = {};
    for (const section of preview.sections) {
      for (const q of section.questions) {
        const level = q.question?.difficulty;
        if (level) counts[level] = (counts[level] || 0) + 1;
      }
    }
    return counts;
  }, [preview]);

  const runValidation = async () => {
    const result = await api.tests.validate(test, sections).catch((error) => {
      toast.error(error.message);
      return null;
    });
    setValidation(result);
    return result;
  };

  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.tests.preview({
        sections,
        mode,
        seed: test.random_seed || null,
        preventDuplicates: test.prevent_duplicates,
        allowPartial: true,
      });
      setPreview(result);
      if (!test.random_seed) patchTest({ random_seed: result.seed });
      setStep('preview');

      if (result.warnings?.length) {
        toast.warning(`${result.warnings.length} section(s) could not be filled completely.`);
      } else {
        toast.success(`Generated ${result.sections.reduce((a, s) => a + s.delivered, 0)} questions.`);
      }
    } catch (error) {
      toast.error(error.message);
      if (error.details?.sections) setPreview({ sections: error.details.sections, warnings: error.details.warnings || [] });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const result = await runValidation();
    if (result && !result.valid) {
      toast.error('Fix the validation errors before saving.');
      setStep('preview');
      return;
    }

    setBusy(true);
    try {
      const payload = {
        test: {
          ...test,
          starts_at: test.starts_at || null,
          ends_at: test.ends_at || null,
          random_seed: test.random_seed || null,
        },
        sections: sections.map((s, i) => ({ ...s, section_order: i + 1 })),
        mode,
        allowPartial: true,
      };
      const saved = await api.tests.create(payload);
      toast.success(`${saved.test_id} saved with ${saved.summary.totalQuestions} questions.`);
      navigate(`/tests/${saved.id}`);
    } catch (error) {
      toast.error(error.message);
      if (error.details) setValidation(error.details);
    } finally {
      setBusy(false);
    }
  };

  const saveAsTemplate = async () => {
    const name = window.prompt('Template name', test.test_name || 'New template');
    if (!name) return;
    try {
      await api.templates.create({
        template_name: name,
        description: test.description || null,
        configuration: { test, sections },
      });
      toast.success(`Template "${name}" saved.`);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const canGenerate = test.test_name.trim() && sections.length > 0 && totals.questions > 0;

  return (
    <>
      <TopBar
        title="Create Test"
        subtitle="Define what you need — the system finds matching QIDs in the bank."
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={saveAsTemplate}>Save as template</button>
            <button type="button" className="btn btn-sm" onClick={runValidation}>Validate</button>
            <button
              type="button" className="btn btn-primary btn-sm"
              onClick={generate} disabled={!canGenerate || busy}
            >
              {busy ? 'Working…' : 'Generate Test'}
            </button>
          </>
        }
      />

      <div className="page">
        <div className="steps">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className={`step${step === s.key ? ' active' : ''}${STEPS.findIndex((x) => x.key === step) > i ? ' done' : ''}`}
              onClick={() => setStep(s.key)}
            >
              <span className="step-number">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </div>

        {validation && !validation.valid && (
          <Alert variant="error" title="This test cannot be saved yet">
            <ul>
              {validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}
            </ul>
          </Alert>
        )}
        {validation?.valid && validation.warnings?.length > 0 && (
          <Alert variant="warning" title="Worth a second look">
            <ul>{validation.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
          </Alert>
        )}
        {validation?.valid && !validation.warnings?.length && (
          <Alert variant="success">This test configuration is valid and every section can be filled.</Alert>
        )}

        <div className="builder">
          {/* ------------------------- left panel ------------------------- */}
          <div className="builder-panel">
            <Card title="Test Configuration">
              <div className="field">
                <label htmlFor="test_name">Test Name *</label>
                <input
                  id="test_name" type="text" value={test.test_name}
                  placeholder="DSA Assessment – Arrays & Strings"
                  onChange={(e) => patchTest({ test_name: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="description">Description</label>
                <textarea
                  id="description" rows="2" value={test.description || ''}
                  onChange={(e) => patchTest({ description: e.target.value })}
                />
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="course">Course / Subject</label>
                  <input
                    id="course" type="text" value={test.course || ''}
                    onChange={(e) => patchTest({ course: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="duration">Duration (minutes) *</label>
                  <input
                    id="duration" type="number" min="1" value={test.duration_minutes}
                    onChange={(e) => patchTest({ duration_minutes: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="starts">Start Date/Time</label>
                  <input
                    id="starts" type="datetime-local" value={test.starts_at || ''}
                    onChange={(e) => patchTest({ starts_at: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ends">End Date/Time</label>
                  <input
                    id="ends" type="datetime-local" value={test.ends_at || ''}
                    onChange={(e) => patchTest({ ends_at: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="status">Test Status</label>
                <select id="status" value={test.status} onChange={(e) => patchTest({ status: e.target.value })}>
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="instructions">Instructions</label>
                <textarea
                  id="instructions" rows="3" value={test.instructions || ''}
                  onChange={(e) => patchTest({ instructions: e.target.value })}
                />
              </div>
            </Card>

            <Card title="Generation Mode" className="mt-2">
              {[
                ['automatic', 'Automatic', 'The system picks matching QIDs at random.'],
                ['hybrid', 'Hybrid', 'The system picks, then you review, replace and reorder.'],
                ['manual', 'Manual', 'You choose every QID yourself from the filtered list.'],
              ].map(([value, label, hint]) => (
                <div className="checkbox-row" key={value}>
                  <input
                    id={`mode-${value}`} type="radio" name="mode" checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  <label htmlFor={`mode-${value}`}>
                    {label}
                    <span className="field-hint">{hint}</span>
                  </label>
                </div>
              ))}
            </Card>

            <Card title="Randomization & Integrity" className="mt-2">
              {[
                ['randomize_questions', 'Randomize question order'],
                ['randomize_options', 'Randomize options (where applicable)'],
                ['prevent_duplicates', 'Prevent duplicate questions across sections'],
                ['include_qid_in_student', 'Include QID in the student version'],
              ].map(([key, label]) => (
                <div className="checkbox-row" key={key}>
                  <input
                    id={key} type="checkbox" checked={Boolean(test[key])}
                    onChange={(e) => patchTest({ [key]: e.target.checked })}
                  />
                  <label htmlFor={key}>{label}</label>
                </div>
              ))}
              <div className="field mt-1">
                <label htmlFor="seed">Random Seed (optional)</label>
                <input
                  id="seed" type="text" value={test.random_seed || ''} placeholder="e.g. DSA2026"
                  onChange={(e) => patchTest({ random_seed: e.target.value })}
                />
                <span className="field-hint">Same seed + same rules = the same test, every time.</span>
              </div>
            </Card>
          </div>

          {/* ------------------------ centre panel ------------------------ */}
          <div>
            {step === 'preview' && preview ? (
              <PreviewPanel
                preview={preview}
                sections={sections}
                onRegenerate={generate}
                busy={busy}
              />
            ) : (
              <>
                <div className="flex-between mb-2">
                  <h2>Test Sections</h2>
                  <button
                    type="button" className="btn btn-sm"
                    onClick={() => setSections((current) => [...current, newSection(current.length)])}
                  >
                    + Add Section
                  </button>
                </div>

                {sections.map((section, index) => (
                  <div key={index}>
                    <SectionEditor
                      meta={meta}
                      section={section}
                      index={index}
                      onChange={(next) => updateSection(index, next)}
                      onRemove={() => setSections((current) => current.filter((_, i) => i !== index))}
                      canRemove={sections.length > 1}
                      excludeQids={[]}
                    />
                    {mode === 'manual' && (
                      <div className="mb-2">
                        <button type="button" className="btn btn-sm" onClick={() => setManualFor(index)}>
                          Select questions manually ({section.qids?.length || 0} chosen)
                        </button>
                      </div>
                    )}
                  </div>
                ))}

                <div className="flex-gap mt-2">
                  <button
                    type="button" className="btn"
                    onClick={() => setSections((current) => [...current, newSection(current.length)])}
                  >
                    + Add Section
                  </button>
                  <button
                    type="button" className="btn btn-primary"
                    onClick={generate} disabled={!canGenerate || busy}
                  >
                    {busy ? <Spinner label="Generating…" /> : 'Generate Test →'}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ------------------------- right panel ------------------------ */}
          <div className="builder-panel builder-summary">
            <Card title="Test Summary">
              <div className="summary-line">
                <span className="label">Sections</span><span className="value">{sections.length}</span>
              </div>
              <div className="summary-line">
                <span className="label">Questions</span>
                <span className="value">
                  {preview ? preview.sections.reduce((a, s) => a + s.delivered, 0) : totals.questions}
                  {preview && totals.questions !== preview.sections.reduce((a, s) => a + s.delivered, 0) && (
                    <span className="faint"> / {totals.questions}</span>
                  )}
                </span>
              </div>
              <div className="summary-line">
                <span className="label">Total Marks</span>
                <span className="value">
                  {preview ? preview.sections.reduce((a, s) => a + s.marks, 0) : totals.marks}
                </span>
              </div>
              <div className="summary-line">
                <span className="label">Duration</span><span className="value">{test.duration_minutes} min</span>
              </div>
              <div className="summary-line">
                <span className="label">Mode</span><span className="value" style={{ textTransform: 'capitalize' }}>{mode}</span>
              </div>
              {test.random_seed && (
                <div className="summary-line">
                  <span className="label">Seed</span><span className="value mono">{test.random_seed}</span>
                </div>
              )}

              {previewDifficulty && Object.keys(previewDifficulty).length > 0 && (
                <>
                  <div className="divider" />
                  <span className="field-label">Difficulty mix</span>
                  <DistributionBar counts={previewDifficulty} />
                </>
              )}

              <div className="divider" />
              <span className="field-label">Sections</span>
              {sections.map((section, index) => {
                const delivered = preview?.sections?.[index]?.delivered;
                return (
                  <div className="summary-line" key={index}>
                    <span className="label">{section.section_name || `Section ${index + 1}`}</span>
                    <span className="value">
                      {delivered != null ? delivered : section.question_count} Q
                      {delivered != null && delivered < section.question_count && (
                        <span className="badge badge-warning" style={{ marginLeft: 6 }}>short</span>
                      )}
                    </span>
                  </div>
                );
              })}

              <div className="divider" />
              <button
                type="button" className="btn btn-primary btn-block"
                onClick={save} disabled={busy || !preview}
              >
                Save Test
              </button>
              {!preview && <p className="field-hint center mt-1">Generate the test to enable saving.</p>}
            </Card>
          </div>
        </div>
      </div>

      {manualFor !== null && (
        <ManualPicker
          meta={meta}
          section={sections[manualFor]}
          onClose={() => setManualFor(null)}
          onConfirm={(qids) => {
            updateSection(manualFor, { ...sections[manualFor], qids });
            setManualFor(null);
          }}
        />
      )}
    </>
  );
}
