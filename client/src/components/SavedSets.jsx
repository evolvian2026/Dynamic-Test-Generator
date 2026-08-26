/**
 * Saved question sets.
 *
 * A template saves a whole test; this saves a *filter* on its own. The same
 * awkward rule — "active Hard coding items in DSA that no test has used in the
 * last 90 days" — gets rebuilt by hand over and over, so naming it once and
 * recalling it is worth a small panel.
 *
 * The count shown is live: a set that matched 300 questions last month may
 * match 40 today, and that is exactly what a user needs to see before reusing it.
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from './Toast.jsx';
import { Card, Badge, Alert, Spinner, EmptyState } from './ui.jsx';

/** True when a rule would select the whole bank — not worth saving. */
function isEmptyRule(rule) {
  if (!rule) return true;
  return Object.entries(rule).every(([, value]) => {
    if (value === null || value === undefined || value === '') return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  });
}

export default function SavedSets({ rule, onApply, title = 'Saved sets' }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const [sets, setSets] = useState(null);
  const [error, setError] = useState(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.sets.list().then(setSets).catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.sets.create({ name: name.trim(), filter: rule || {}, is_shared: shared });
      toast.success(`Saved “${name.trim()}”.`);
      setName('');
      setNaming(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (set) => {
    if (!window.confirm(`Delete the saved set “${set.name}”? Tests already built from it are unaffected.`)) return;
    try {
      await api.sets.remove(set.id);
      toast.success('Saved set deleted.');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const canSave = can('sets:write') && !isEmptyRule(rule);

  return (
    <Card
      title={title}
      bodyClass="tight"
      actions={can('sets:write') && (
        <button
          type="button" className="btn btn-xs"
          disabled={!canSave && !naming}
          title={canSave ? 'Save the current filters under a name' : 'Set some filters first'}
          onClick={() => setNaming((v) => !v)}
        >
          {naming ? 'Cancel' : '+ Save current'}
        </button>
      )}
    >
      {error && <Alert variant="error">{error}</Alert>}

      {naming && (
        <form onSubmit={save} className="mb-2">
          <div className="field">
            <label htmlFor="set-name">Name</label>
            <input
              id="set-name" type="text" required maxLength={120} autoFocus
              placeholder="Hard DSA, unused this quarter"
              value={name} onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="checkbox-row">
            <input id="set-shared" type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <label htmlFor="set-shared">
              Share with everyone
              <span className="field-hint">Unshared sets are visible only to you.</span>
            </label>
          </div>
          <button type="submit" className="btn btn-sm btn-primary mt-1" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save set'}
          </button>
        </form>
      )}

      {!sets && !error && <Spinner label="Loading saved sets…" />}

      {sets?.length === 0 && (
        <EmptyState title="No saved sets yet" icon="☆">
          Build a filter you expect to use again, then save it here.
        </EmptyState>
      )}

      {sets?.length > 0 && (
        <ul className="saved-set-list">
          {sets.map((set) => (
            <li key={set.id} className="saved-set">
              <div className="saved-set-main">
                <button type="button" className="qid-link" onClick={() => onApply?.(set.filter)}>
                  {set.name}
                </button>
                <div className="q-meta">
                  <Badge variant={set.available > 0 ? 'brand' : 'warning'}>
                    {set.available === null ? 'filter invalid' : `${set.available.toLocaleString()} available`}
                  </Badge>
                  {!set.is_shared && <Badge>private</Badge>}
                  {set.created_by_name && <span className="faint small">{set.created_by_name}</span>}
                </div>
              </div>
              {can('sets:write') && (set.created_by === user.id || can('users:write')) && (
                <button type="button" className="btn btn-xs btn-ghost" title="Delete" onClick={() => remove(set)}>✕</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="field-hint mt-1">
        Applying a set replaces the current filters. Counts are recalculated each time this panel loads.
      </p>
    </Card>
  );
}

/**
 * Compact recall of a saved set, for places with no room for the full panel —
 * currently a section's selection rules. Applying merges the set's filter over
 * whatever the section already had, so a saved set can seed a rule and still be
 * adjusted afterwards.
 */
export function SetPicker({ onApply, label = 'Start from a saved set' }) {
  const [sets, setSets] = useState([]);

  useEffect(() => { api.sets.list().then(setSets).catch(() => setSets([])); }, []);

  if (!sets.length) return null;

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <select
        value=""
        onChange={(e) => {
          const set = sets.find((s) => String(s.id) === e.target.value);
          if (set) onApply(set.filter);
        }}
      >
        <option value="">Choose a saved set…</option>
        {sets.map((set) => (
          <option key={set.id} value={set.id}>
            {set.name}{set.available === null ? '' : ` — ${set.available.toLocaleString()} available`}
          </option>
        ))}
      </select>
      <span className="field-hint">Its filters replace the ones set here; you can still adjust them afterwards.</span>
    </div>
  );
}
