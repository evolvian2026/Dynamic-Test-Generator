/**
 * Question authoring.
 *
 * The taxonomy branch picker is the part that matters: a question must be
 * classified before it can be saved, and a branch is only valid as a whole
 * path, so subject / area / sub-area are chosen together rather than typed.
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { Modal, Alert, Badge, Spinner } from './ui.jsx';

const OPTION_TYPES = new Set(['MCQ', 'Multiple Select', 'True/False']);
const LETTERS = 'ABCDEFGH';

const blank = () => ({
  question_text: '',
  question_type: 'MCQ',
  difficulty: 'Medium',
  marks: 1,
  expected_seconds: 60,
  status: 'draft',
  answer_text: '',
  explanation: '',
  tags: [],
  attributes: {},
  options: [
    { option_text: '', is_correct: true },
    { option_text: '', is_correct: false },
  ],
  taxonomy: [],
});

/** Picks one Subject > Area > Sub-Area path. */
function BranchPicker({ meta, onAdd }) {
  const [subject, setSubject] = useState('');
  const [area, setArea] = useState('');
  const [subArea, setSubArea] = useState('');
  const [areas, setAreas] = useState([]);
  const [subAreas, setSubAreas] = useState([]);

  useEffect(() => {
    if (!subject) { setAreas([]); setArea(''); return undefined; }
    let cancelled = false;
    api.questions.facet('area', [subject])
      .then((rows) => !cancelled && setAreas(rows))
      .catch(() => !cancelled && setAreas([]));
    return () => { cancelled = true; };
  }, [subject]);

  useEffect(() => {
    if (!area) { setSubAreas([]); setSubArea(''); return undefined; }
    let cancelled = false;
    api.questions.facet('sub_area', [area])
      .then((rows) => !cancelled && setSubAreas(rows))
      .catch(() => !cancelled && setSubAreas([]));
    return () => { cancelled = true; };
  }, [area]);

  return (
    <div className="rule-node">
      <div className="form-row">
        <div>
          <span className="field-label">Subject</span>
          <select value={subject} onChange={(e) => { setSubject(e.target.value); setArea(''); setSubArea(''); }}>
            <option value="">Choose…</option>
            {(meta?.subjects || []).map((s) => <option key={s.value} value={s.value}>{s.value}</option>)}
          </select>
        </div>
        <div>
          <span className="field-label">Area / Topic</span>
          <select value={area} disabled={!subject} onChange={(e) => { setArea(e.target.value); setSubArea(''); }}>
            <option value="">{subject ? 'Choose…' : 'Pick a subject first'}</option>
            {areas.map((a) => <option key={a.id} value={a.value}>{a.value}</option>)}
          </select>
        </div>
        <div>
          <span className="field-label">Sub-Area <span className="faint">optional</span></span>
          <select value={subArea} disabled={!area || !subAreas.length} onChange={(e) => setSubArea(e.target.value)}>
            <option value="">{subAreas.length ? 'None' : 'This area has none'}</option>
            {subAreas.map((s) => <option key={s.id} value={s.value}>{s.value}</option>)}
          </select>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-sm mt-1"
        disabled={!subject || !area}
        onClick={() => { onAdd({ subject, area, subArea: subArea || null }); setSubject(''); setArea(''); setSubArea(''); }}
      >
        + Add this branch
      </button>
    </div>
  );
}

export default function QuestionEditor({ qid = null, meta, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(qid ? null : blank());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (!qid) return;
    api.questions.byQid(qid, true)
      .then((q) => setForm({
        question_text: q.question_text,
        question_type: q.question_type,
        difficulty: q.difficulty,
        marks: q.marks,
        expected_seconds: q.expected_seconds,
        status: q.status,
        answer_text: q.answer_text || '',
        explanation: q.explanation || '',
        tags: q.tags || [],
        attributes: q.attributes || {},
        options: (q.options || []).map((o) => ({ option_text: o.option_text, is_correct: !!o.is_correct })),
        taxonomy: (q.taxonomy || []).map((b) => ({ subject: b.subject, area: b.area, subArea: b.subArea, isPrimary: b.isPrimary })),
      }))
      .catch((e) => setError(e.message));
  }, [qid]);

  if (!form) {
    return <Modal title={qid ? `Edit ${qid}` : 'New question'} onClose={onClose}><Spinner label="Loading…" /></Modal>;
  }

  const patch = (changes) => setForm((current) => ({ ...current, ...changes }));
  const hasOptions = OPTION_TYPES.has(form.question_type);

  const setOption = (index, changes) => {
    patch({
      options: form.options.map((o, i) => {
        if (i !== index) {
          // An MCQ has exactly one key, so selecting one clears the others.
          return form.question_type === 'MCQ' && changes.is_correct ? { ...o, is_correct: false } : o;
        }
        return { ...o, ...changes };
      }),
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        marks: Number(form.marks),
        expected_seconds: Number(form.expected_seconds),
        answer_text: form.answer_text || null,
        explanation: form.explanation || null,
        options: hasOptions ? form.options.filter((o) => o.option_text.trim()) : [],
      };
      const saved = qid ? await api.questions.update(qid, payload) : await api.questions.create(payload);
      toast.success(qid ? `${qid} updated.` : `${saved.qid} created.`);
      onSaved(saved);
    } catch (e) {
      setError(e.message);
      if (Array.isArray(e.details)) setError(`${e.message} ${e.details.join(' ')}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      size="lg"
      title={qid ? `Edit ${qid}` : 'New question'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : qid ? 'Save changes' : 'Create question'}
          </button>
        </>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      <div className="field">
        <label htmlFor="q-text">Question text *</label>
        <textarea id="q-text" rows="4" value={form.question_text} onChange={(e) => patch({ question_text: e.target.value })} />
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="q-type">Type *</label>
          <select
            id="q-type"
            value={form.question_type}
            onChange={(e) => {
              const type = e.target.value;
              patch({
                question_type: type,
                options: OPTION_TYPES.has(type)
                  ? (type === 'True/False'
                      ? [{ option_text: 'True', is_correct: true }, { option_text: 'False', is_correct: false }]
                      : form.options.length ? form.options : blank().options)
                  : [],
              });
            }}
          >
            {(meta?.questionTypes || []).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="q-diff">Difficulty *</label>
          <select id="q-diff" value={form.difficulty} onChange={(e) => patch({ difficulty: e.target.value })}>
            {(meta?.difficulties || ['Easy', 'Medium', 'Hard']).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="q-marks">Marks *</label>
          <input id="q-marks" type="number" min="0" step="0.5" value={form.marks} onChange={(e) => patch({ marks: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="q-time">Expected time (s)</label>
          <input id="q-time" type="number" min="1" value={form.expected_seconds} onChange={(e) => patch({ expected_seconds: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="q-status">Status</label>
          <select id="q-status" value={form.status} onChange={(e) => patch({ status: e.target.value })}>
            {(meta?.statuses || ['active', 'draft', 'review', 'retired']).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {hasOptions && (
        <div className="field">
          <span className="field-label">
            Options — mark the correct {form.question_type === 'Multiple Select' ? 'answers' : 'answer'}
          </span>
          {form.options.map((option, index) => (
            <div className="flex-gap mb-1" key={index}>
              <input
                type={form.question_type === 'Multiple Select' ? 'checkbox' : 'radio'}
                name="correct-option"
                checked={option.is_correct}
                onChange={(e) => setOption(index, { is_correct: e.target.checked })}
                aria-label={`Option ${LETTERS[index]} is correct`}
                style={{ width: 16, height: 16, accentColor: 'var(--brand)' }}
              />
              <span className="faint" style={{ width: 16 }}>{LETTERS[index]}</span>
              <input
                type="text"
                value={option.option_text}
                placeholder={`Option ${LETTERS[index]}`}
                onChange={(e) => setOption(index, { option_text: e.target.value })}
              />
              {form.options.length > 2 && form.question_type !== 'True/False' && (
                <button
                  type="button" className="btn btn-xs btn-ghost" aria-label="Remove option"
                  onClick={() => patch({ options: form.options.filter((_, i) => i !== index) })}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {form.question_type !== 'True/False' && form.options.length < 8 && (
            <button
              type="button" className="btn btn-sm"
              onClick={() => patch({ options: [...form.options, { option_text: '', is_correct: false }] })}
            >
              + Add option
            </button>
          )}
        </div>
      )}

      {!hasOptions && (
        <div className="field">
          <label htmlFor="q-answer">Model answer</label>
          <textarea id="q-answer" rows="3" value={form.answer_text} onChange={(e) => patch({ answer_text: e.target.value })} />
        </div>
      )}

      <div className="field">
        <label htmlFor="q-expl">Explanation</label>
        <textarea id="q-expl" rows="2" value={form.explanation} onChange={(e) => patch({ explanation: e.target.value })} />
      </div>

      <div className="divider" />

      <div className="field">
        <span className="field-label">Classification * — at least one Subject &gt; Area branch</span>
        {form.taxonomy.length === 0 && <Alert variant="warning">A question must be classified before it can be saved.</Alert>}
        {form.taxonomy.map((branch, index) => (
          <div className="question-row" key={`${branch.subject}-${branch.area}-${index}`}>
            <div className="q-main">
              <strong>{branch.subject}</strong>
              <span className="faint"> › {branch.area}{branch.subArea ? ` › ${branch.subArea}` : ''}</span>
              {index === 0 && <Badge variant="brand" >primary</Badge>}
            </div>
            <div className="q-actions">
              {index !== 0 && (
                <button
                  type="button" className="btn btn-xs"
                  title="Make this the primary branch"
                  onClick={() => patch({ taxonomy: [branch, ...form.taxonomy.filter((_, i) => i !== index)] })}
                >
                  Make primary
                </button>
              )}
              <button
                type="button" className="btn btn-xs btn-ghost" aria-label="Remove branch"
                onClick={() => patch({ taxonomy: form.taxonomy.filter((_, i) => i !== index) })}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <BranchPicker
          meta={meta}
          onAdd={(branch) => {
            const exists = form.taxonomy.some((b) => b.subject === branch.subject && b.area === branch.area && b.subArea === branch.subArea);
            if (!exists) patch({ taxonomy: [...form.taxonomy, branch] });
          }}
        />
      </div>

      <div className="field">
        <span className="field-label">Tags <span className="faint">optional</span></span>
        <div className="flex-gap mb-1">
          {form.tags.map((tag) => (
            <button
              key={tag} type="button" className="chip selected"
              onClick={() => patch({ tags: form.tags.filter((t) => t !== tag) })}
            >
              {tag} ✕
            </button>
          ))}
        </div>
        <div className="flex-gap">
          <input
            type="text" value={tagInput} placeholder="Add a tag and press Enter"
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const value = tagInput.trim();
              if (value && !form.tags.includes(value)) patch({ tags: [...form.tags, value] });
              setTagInput('');
            }}
          />
        </div>
      </div>
    </Modal>
  );
}
