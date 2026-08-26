/**
 * Bulk import wizard.
 *
 * Two phases, mirroring the API: preview shows exactly what would happen and
 * writes nothing, then commit writes only the rows the operator accepted. The
 * preview is where the value is — it says which rows matched the taxonomy,
 * which are near-duplicates of questions already in the bank, and which need a
 * human before they can be imported.
 *
 * CSV is parsed in the browser; .xlsx is converted by the caller.
 */

import { useState } from 'react';
import api from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { Modal, Alert, Badge, Spinner, EmptyState } from './ui.jsx';

/** RFC4180-ish CSV parse: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((cell) => String(cell).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

const statusBadge = (item) => {
  if (item.duplicateOf) return <Badge variant="warning">possible duplicate</Badge>;
  if (!item.valid) return <Badge variant="danger">needs attention</Badge>;
  if (item.taxonomyConfidence !== null && item.taxonomyConfidence < 0.85) return <Badge variant="warning">check taxonomy</Badge>;
  return <Badge variant="success">ready</Badge>;
};

export default function ImportWizard({ onClose, onImported }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showOnly, setShowOnly] = useState('all');

  const readFile = async (file) => {
    setError(null);
    setPreview(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (!parsed.length) throw new Error('That file has no data rows.');
      setRows(parsed);
    } catch (e) {
      setError(e.message);
      setRows(null);
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.questions.importPreview(rows));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const result = await api.questions.importCommit(preview.items);
      toast.success(`Imported ${result.created} question${result.created === 1 ? '' : 's'}.`);
      if (result.skipped.length) toast.warning(`${result.skipped.length} row(s) were skipped.`);
      onImported(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const visible = (preview?.items || []).filter((item) => {
    if (showOnly === 'ready') return item.valid;
    if (showOnly === 'attention') return !item.valid;
    return true;
  });

  return (
    <Modal
      size="lg"
      title="Import questions"
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {preview
              ? `${preview.totals.ready} of ${preview.totals.rows} rows ready to import`
              : rows ? `${rows.length} rows parsed` : ''}
          </span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {rows && !preview && (
            <button type="button" className="btn btn-primary" onClick={runPreview} disabled={busy}>
              {busy ? 'Analysing…' : 'Preview import'}
            </button>
          )}
          {preview && (
            <button type="button" className="btn btn-primary" onClick={commit} disabled={busy || preview.totals.ready === 0}>
              {busy ? 'Importing…' : `Import ${preview.totals.ready} question(s)`}
            </button>
          )}
        </>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      {!rows && (
        <>
          <Alert variant="info" title="What the file should contain">
            One row per question. <strong>question_text</strong>, <strong>subject</strong> and <strong>area</strong> are
            required; qid, type, difficulty, marks, sub_area and tags are recommended. Option columns may be named
            <code> option_a … option_h</code> with a <code>correct_option</code> column holding the letter.
            Any column we do not recognise is imported as an extensible attribute.
          </Alert>
          <div className="field">
            <label htmlFor="import-file">CSV file</label>
            <input
              id="import-file" type="file" accept=".csv,text/csv"
              onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
            />
            <span className="field-hint">
              Subjects and areas are matched against the taxonomy, so close spellings such as
              &ldquo;Operating Systems&rdquo; resolve automatically. Anything uncertain is flagged rather than guessed.
            </span>
          </div>
        </>
      )}

      {rows && !preview && (
        <Alert variant="success">
          Parsed <strong>{rows.length}</strong> rows from {fileName}. Nothing has been written yet —
          preview first to see what would be imported.
        </Alert>
      )}

      {busy && !preview && <Spinner label="Matching against the taxonomy…" />}

      {preview && (
        <>
          <div className="grid grid-4 mb-2">
            <div className="stat"><div className="stat-label">Rows</div><div className="stat-value">{preview.totals.rows}</div></div>
            <div className="stat"><div className="stat-label">Ready</div><div className="stat-value" style={{ color: 'var(--success)' }}>{preview.totals.ready}</div></div>
            <div className="stat"><div className="stat-label">Need attention</div><div className="stat-value" style={{ color: 'var(--warning)' }}>{preview.totals.needsAttention}</div></div>
            <div className="stat"><div className="stat-label">Possible duplicates</div><div className="stat-value" style={{ color: 'var(--danger)' }}>{preview.totals.duplicates}</div></div>
          </div>

          {preview.columns.attributeColumns.length > 0 && (
            <Alert variant="info">
              Unrecognised columns imported as attributes: {preview.columns.attributeColumns.join(', ')}
            </Alert>
          )}

          <div className="flex-gap mb-2">
            {[['all', 'All'], ['ready', 'Ready'], ['attention', 'Needs attention']].map(([key, label]) => (
              <button
                key={key} type="button"
                className={`chip${showOnly === key ? ' selected' : ''}`}
                onClick={() => setShowOnly(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <EmptyState title="Nothing to show in this view" icon="⌕" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Row</th><th>Status</th><th>QID</th><th>Question</th><th>Resolved taxonomy</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {visible.slice(0, 200).map((item) => (
                    <tr key={item.row}>
                      <td className="faint small">{item.row}</td>
                      <td>{statusBadge(item)}</td>
                      <td className="mono small">{item.qid || <span className="faint">auto</span>}</td>
                      <td style={{ maxWidth: 280 }}><span className="q-text">{item.question_text}</span></td>
                      <td className="small">
                        {item.taxonomy ? (
                          <>
                            {item.taxonomy.subject} › {item.taxonomy.area}
                            {item.taxonomy.subArea && <> › {item.taxonomy.subArea}</>}
                            {item.taxonomyConfidence !== null && item.taxonomyConfidence < 1 && (
                              <div className="faint">
                                matched from &ldquo;{[item.source.subject, item.source.area].filter(Boolean).join(' › ')}&rdquo;
                                {' '}({Math.round(item.taxonomyConfidence * 100)}%)
                              </div>
                            )}
                          </>
                        ) : <span className="faint">unresolved</span>}
                      </td>
                      <td className="small">
                        {item.issues.length
                          ? <ul style={{ margin: 0, paddingLeft: 16 }}>{item.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
                          : <span className="faint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {visible.length > 200 && <p className="field-hint">Showing the first 200 of {visible.length} rows.</p>}
        </>
      )}
    </Modal>
  );
}
