/**
 * Quick filter panel (spec §5).
 *
 * Subtopic options are re-fetched whenever the selected topics change, so the
 * list is always scoped to the current topic (spec §5, "Subtopic should
 * preferably be dynamically populated based on the selected Topic").
 */

import { useEffect, useState } from 'react';
import api from '../lib/api.js';
import { ChipSelect } from './ui.jsx';

export default function FilterPanel({ meta, rule, onChange, compact = false }) {
  const [subtopics, setSubtopics] = useState([]);
  const [tagQuery, setTagQuery] = useState('');
  const [tagOptions, setTagOptions] = useState(meta?.tags || []);

  const topics = rule.topic || [];

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!topics.length) {
        const all = await api.questions.facet('subtopic').catch(() => []);
        if (!cancelled) setSubtopics(all);
        return;
      }
      const lists = await Promise.all(topics.map((topic) => api.questions.facet('subtopic', topic).catch(() => [])));
      if (cancelled) return;
      // Merge counts when several topics are selected.
      const merged = new Map();
      for (const list of lists) {
        for (const row of list) {
          merged.set(row.value, (merged.get(row.value) || 0) + row.count);
        }
      }
      setSubtopics([...merged].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count));
    };
    load();
    return () => { cancelled = true; };
  }, [topics.join('|')]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.questions.tags(tagQuery).then((rows) => !cancelled && setTagOptions(rows)).catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tagQuery]);

  const patch = (changes) => onChange({ ...rule, ...changes });

  // Dropping a topic must also drop subtopics that no longer belong to it.
  const setTopics = (next) => {
    const allowed = new Set(subtopics.map((s) => s.value));
    patch({
      topic: next,
      subtopic: next.length ? (rule.subtopic || []).filter((s) => allowed.has(s)) : rule.subtopic,
    });
  };

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
        <span className="field-label">Topic</span>
        <ChipSelect options={meta?.topics || []} selected={topics} onChange={setTopics} />
      </div>

      <div className="field">
        <span className="field-label">
          Subtopic
          {topics.length > 0 && <span className="faint"> · scoped to {topics.join(', ')}</span>}
        </span>
        <ChipSelect
          options={subtopics.slice(0, compact ? 12 : 40)}
          selected={rule.subtopic || []}
          onChange={(v) => patch({ subtopic: v })}
          emptyLabel="Select a topic to see its subtopics"
        />
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
        <span className="field-label">Tags</span>
        <input
          type="search"
          placeholder="Search tags…"
          value={tagQuery}
          onChange={(e) => setTagQuery(e.target.value)}
          className="mb-1"
        />
        <div className="small muted mb-1">Include (question must carry any of these)</div>
        <ChipSelect
          options={tagOptions.slice(0, compact ? 14 : 30)}
          selected={rule.includeTags || []}
          onChange={(v) => patch({ includeTags: v })}
        />
        <div className="small muted mt-1 mb-1">Exclude (question must carry none of these)</div>
        <div className="chip-select">
          {tagOptions.slice(0, compact ? 14 : 30).map((tag) => {
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
