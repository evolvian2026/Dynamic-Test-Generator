/**
 * Live availability indicator (spec §14, §24).
 *
 * Re-queries the bank whenever any filter changes, so the user always knows
 * whether the section they are describing can actually be filled — before
 * they try to generate.
 */

import { useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { Spinner } from './ui.jsx';

export default function Availability({ section, excludeQids = [], onResult, onApplySuggestion }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const key = useDebounced(JSON.stringify({ section, excludeQids }), 350);
  const controllerRef = useRef(null);

  useEffect(() => {
    const parsed = JSON.parse(key);
    if (!parsed.section || !parsed.section.question_count) {
      setResult(null);
      return undefined;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);

    api.tests
      .sectionAvailability(parsed.section, parsed.excludeQids, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult(data);
        onResult?.(data);
      })
      .catch((err) => {
        if (err.name === 'AbortError' || controller.signal.aborted) return;
        setError(err.message);
      })
      .finally(() => !controller.signal.aborted && setLoading(false));

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (error) return <div className="availability-bar empty">⚠ {error}</div>;
  if (!result && loading) return <div className="availability-bar ok"><Spinner label="Checking availability…" /></div>;
  if (!result) return null;

  const { requested, available, deliverable, sufficient, buckets, suggestions } = result;
  const tone = sufficient ? 'ok' : deliverable === 0 ? 'empty' : 'short';
  const pct = requested > 0 ? Math.min(100, (deliverable / requested) * 100) : 0;

  return (
    <>
      <div className={`availability-bar ${tone}`}>
        <span>
          {sufficient
            ? `✓ ${requested} of ${available.toLocaleString()} matching questions available`
            : `⚠ Insufficient — only ${deliverable} of ${requested} can be filled`}
        </span>
        <span className="availability-meter"><span style={{ width: `${pct}%` }} /></span>
        {loading && <span className="spinner" aria-label="Refreshing" />}
      </div>

      {buckets?.length > 1 && (
        <div className="flex-gap small mt-1">
          {buckets.map((bucket) => (
            <span
              key={bucket.label}
              className={`badge${bucket.sufficient ? '' : ' badge-warning'}`}
              title={`${bucket.label}: requested ${bucket.requested}, available ${bucket.available}`}
            >
              {bucket.label}: {bucket.requested}/{bucket.available}
            </span>
          ))}
        </div>
      )}

      {!sufficient && suggestions?.length > 0 && (
        <div className="alert alert-warning mt-1 mb-0">
          <span className="alert-icon" aria-hidden="true">⚠</span>
          <div className="alert-body">
            <strong>Only {deliverable} question{deliverable === 1 ? ' is' : 's are'} available. You requested {requested}.</strong>
            <div className="flex-gap mt-1">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.action + suggestion.label}
                  type="button"
                  className="btn btn-xs"
                  onClick={() => onApplySuggestion?.(suggestion)}
                  title={suggestion.available != null ? `${suggestion.available} questions would match` : undefined}
                >
                  {suggestion.label}
                  {suggestion.available != null && <span className="faint"> ({suggestion.available})</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
