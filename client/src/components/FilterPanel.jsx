/**
 * Taxonomy filter panel.
 *
 *     Subject  ->  Area / Topic  ->  Sub-Area / Sub-Topic  ->  Tags
 *
 * Each level is scoped by the one above it: choosing a subject narrows the
 * areas, choosing an area narrows both the sub-areas and the suggested tags.
 * When a parent selection is removed, children that no longer belong to it are
 * dropped too, so the filter can never describe an impossible branch.
 */

import { useEffect, useMemo, useState } from 'react';
import api from '../lib/api.js';
import { ChipSelect } from './ui.jsx';

export default function FilterPanel({ meta, rule, onChange, compact = false }) {
  const [areas, setAreas] = useState([]);
  const [subAreas, setSubAreas] = useState([]);
  const [tagQuery, setTagQuery] = useState('');
  const [tagOptions, setTagOptions] = useState([]);

  const subjects = useMemo(() => rule.subject || [], [rule.subject]);
  const selectedAreas = useMemo(() => rule.area || [], [rule.area]);

  const subjectKey = subjects.join('|');
  const areaKey = selectedAreas.join('|');

  // Areas cascade from the selected subjects. Pruning happens here rather than
  // in the click handler: only once the scoped list has arrived do we know
  // which of the already-selected areas still belong to the chosen subjects.
  useEffect(() => {
    let cancelled = false;
    api.questions.facet('area', subjects)
      .then((rows) => {
        if (cancelled) return;
        setAreas(rows);
        if (!subjects.length) return; // no scope, so nothing is out of scope
        const allowed = new Set(rows.map((r) => r.value));
        const kept = (rule.area || []).filter((a) => allowed.has(a));
        if (kept.length !== (rule.area || []).length) {
          onChange({ ...rule, area: kept, sub_area: kept.length ? rule.sub_area || [] : [] });
        }
      })
      .catch(() => !cancelled && setAreas([]));
    return () => { cancelled = true; };
  }, [subjectKey]);

  // Sub-areas cascade from the selected areas, pruned the same way.
  useEffect(() => {
    let cancelled = false;
    if (!selectedAreas.length) {
      setSubAreas([]);
      return () => { cancelled = true; };
    }
    api.questions.facet('sub_area', selectedAreas)
      .then((rows) => {
        if (cancelled) return;
        setSubAreas(rows);
        const allowed = new Set(rows.map((r) => r.value));
        const kept = (rule.sub_area || []).filter((s) => allowed.has(s));
        if (kept.length !== (rule.sub_area || []).length) onChange({ ...rule, sub_area: kept });
      })
      .catch(() => !cancelled && setSubAreas([]));
    return () => { cancelled = true; };
  }, [areaKey]);

  // Tag suggestions follow the branch, and fall back to the whole vocabulary.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.questions
        .tags(tagQuery, { subjects, areas: selectedAreas })
        .then((rows) => !cancelled && setTagOptions(rows))
        .catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tagQuery, subjectKey, areaKey]);

  const patch = (changes) => onChange({ ...rule, ...changes });

  // Selection handlers stay simple; the cascade effects above prune anything
  // that no longer fits once the newly scoped options arrive.
  const setSubjects = (next) => patch({ subject: next });

  const setAreasSelection = (next) => {
    const allowed = new Set(subAreas.filter((s) => next.includes(s.area)).map((s) => s.value));
    patch({
      area: next,
      sub_area: next.length ? (rule.sub_area || []).filter((s) => allowed.has(s)) : [],
    });
  };

  const areaOptions = areas.slice(0, compact ? 24 : 80);
  const subAreaOptions = subAreas.slice(0, compact ? 16 : 40);

  return (
    <>
      <div className="field">
        <span className="field-label">Question Type</span>
        <ChipSelect
          options={(meta?.questionTypes || []).map((value) => ({ value }))}
          selected={rule.question_type || []}
          onChange={(v) => patch({ question_type: v })}
          showCounts={false}
        />
      </div>

      <div className="field">
        <span className="field-label">Subject</span>
        <ChipSelect
          options={meta?.subjects || []}
          selected={subjects}
          onChange={setSubjects}
          emptyLabel="No subjects in the bank yet"
        />
      </div>

      <div className="field">
        <span className="field-label">
          Area / Topic
          {subjects.length > 0 && <span className="faint"> · in {subjects.join(', ')}</span>}
        </span>
        <ChipSelect
          options={areaOptions}
          selected={selectedAreas}
          onChange={setAreasSelection}
          emptyLabel="Select a subject to narrow the areas"
        />
        {areas.length > areaOptions.length && (
          <span className="field-hint">
            Showing {areaOptions.length} of {areas.length} areas — pick a subject to narrow the list.
          </span>
        )}
      </div>

      <div className="field">
        <span className="field-label">
          Sub-Area / Sub-Topic
          {selectedAreas.length > 0 && <span className="faint"> · in {selectedAreas.join(', ')}</span>}
        </span>
        <ChipSelect
          options={subAreaOptions}
          selected={rule.sub_area || []}
          onChange={(v) => patch({ sub_area: v })}
          emptyLabel={
            selectedAreas.length
              ? 'These areas have no sub-areas — the area itself is the finest level'
              : 'Select an area to see its sub-areas'
          }
        />
      </div>

      <div className="field">
        <span className="field-label">
          Tags <span className="faint">· optional</span>
        </span>
        <input
          type="search"
          placeholder={selectedAreas.length ? `Search tags in ${selectedAreas[0]}…` : 'Search tags…'}
          value={tagQuery}
          onChange={(e) => setTagQuery(e.target.value)}
          className="mb-1"
        />
        <div className="small muted mb-1">Include (question must carry any of these)</div>
        <ChipSelect
          options={tagOptions.slice(0, compact ? 16 : 40)}
          selected={rule.includeTags || []}
          onChange={(v) => patch({ includeTags: v })}
          showCounts={false}
          emptyLabel="No tags match"
        />
        <div className="small muted mt-1 mb-1">Exclude (question must carry none of these)</div>
        <div className="chip-select">
          {tagOptions.slice(0, compact ? 16 : 40).map((tag) => {
            const active = (rule.excludeTags || []).includes(tag.value);
            return (
              <button
                type="button"
                key={tag.value}
                className={`chip${active ? ' excluded' : ''}`}
                aria-pressed={active}
                onClick={() => patch({
                  excludeTags: active
                    ? rule.excludeTags.filter((t) => t !== tag.value)
                    : [...(rule.excludeTags || []), tag.value],
                })}
              >
                {active ? '✕ ' : ''}{tag.value}
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Difficulty</span>
        <ChipSelect
          options={(meta?.difficulties || []).map((value) => ({ value }))}
          selected={rule.difficulty || []}
          onChange={(v) => patch({ difficulty: v })}
          showCounts={false}
        />
      </div>

      <div className="field">
        <span className="field-label">Question Text Search</span>
        <input
          type="search"
          placeholder="Full-text search…"
          value={rule.search || ''}
          onChange={(e) => patch({ search: e.target.value })}
        />
      </div>
    </>
  );
}
