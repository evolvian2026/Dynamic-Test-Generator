/** One section of the test builder (spec §4, §6, §14). */

import { useState } from 'react';
import FilterPanel from './FilterPanel.jsx';
import RuleBuilder from './RuleBuilder.jsx';
import Availability from './Availability.jsx';
import { SetPicker } from './SavedSets.jsx';
import { DistributionBar } from './ui.jsx';

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

export default function SectionEditor({ meta, section, index, onChange, onRemove, excludeQids, canRemove }) {
  const [tab, setTab] = useState('filters');
  const patch = (changes) => onChange({ ...section, ...changes });
  const patchRule = (rule) => patch({ rule });
  const rule = section.rule || {};
  const hasExposure = Boolean(
    rule.neverUsed || rule.usedWithinDays || rule.maxUsageCount !== undefined || (rule.notUsedInTests || []).length,
  );

  const distribution = section.distribution;
  const distributionValues = distribution?.values || {};
  const distributionTotal = Object.values(distributionValues).reduce((a, v) => a + Number(v || 0), 0);
  const isPercentage = (distribution?.mode || 'percentage') === 'percentage';

  const toggleDistribution = () => {
    patch({
      distribution: distribution
        ? null
        : { field: 'difficulty', mode: 'percentage', values: { Easy: 20, Medium: 50, Hard: 30 } },
    });
  };

  const setDistributionValue = (key, value) => {
    patch({ distribution: { ...distribution, values: { ...distributionValues, [key]: Number(value) || 0 } } });
  };

  /** Applies a shortfall remedy offered by the availability checker (spec §7). */
  const applySuggestion = (suggestion) => {
    if (suggestion.action === 'reduce_count') {
      patch({ question_count: suggestion.value });
    } else if (suggestion.rule) {
      patch({ rule: suggestion.rule });
    }
  };

  // Counts shown per difficulty when a percentage distribution is in play.
  const allocation = (() => {
    if (!distribution || !isPercentage || distributionTotal === 0) return null;
    const total = Number(section.question_count) || 0;
    const entries = Object.entries(distributionValues).filter(([, v]) => v > 0);
    const exact = entries.map(([k, v]) => ({ k, exact: (Number(v) / distributionTotal) * total }));
    const out = Object.fromEntries(exact.map((e) => [e.k, Math.floor(e.exact)]));
    let remainder = total - Object.values(out).reduce((a, b) => a + b, 0);
    for (const item of [...exact].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
      if (remainder-- <= 0) break;
      out[item.k] += 1;
    }
    return out;
  })();

  // Which buckets a distribution offers depends on what it splits by. For the
  // taxonomy levels the choices are the section's own selection, because
  // distributing across all 293 areas would be meaningless.
  const distributionKeys = (() => {
    const field = distribution?.field;
    if (field === 'question_type') return meta?.questionTypes || [];
    if (field === 'subject') {
      return section.rule?.subject?.length
        ? section.rule.subject
        : (meta?.subjects || []).slice(0, 12).map((s) => s.value);
    }
    if (field === 'area') return section.rule?.area || [];
    return DIFFICULTIES;
  })();
  return (
    <div className="section-card">
      <div className="section-head">
        <div className="section-head-main">
          <span className="badge badge-brand">{index + 1}</span>
          <input
            className="section-name-input"
            value={section.section_name}
            onChange={(e) => patch({ section_name: e.target.value })}
            placeholder="Section name"
            aria-label={`Section ${index + 1} name`}
          />
        </div>
        <div className="flex-gap">
          <span className="badge">{section.question_count || 0} Q</span>
          <span className="badge">
            {((Number(section.question_count) || 0) * (Number(section.marks_per_question) || 0)).toFixed(
              Number.isInteger((Number(section.question_count) || 0) * (Number(section.marks_per_question) || 0)) ? 0 : 1,
            )} marks
          </span>
          {canRemove && (
            <button type="button" className="btn btn-xs btn-ghost" onClick={onRemove} aria-label="Remove section">✕</button>
          )}
        </div>
      </div>

      <div className="section-body">
        <div className="form-row mb-2">
          <div>
            <span className="field-label">Number of Questions</span>
            <input
              type="number" min="1" value={section.question_count}
              onChange={(e) => patch({ question_count: Number(e.target.value) })}
            />
          </div>
          <div>
            <span className="field-label">Marks per Question</span>
            <input
              type="number" min="0" step="0.5" value={section.marks_per_question}
              onChange={(e) => patch({ marks_per_question: Number(e.target.value) })}
            />
          </div>
          <div>
            <span className="field-label">Negative Marking</span>
            <input
              type="number" min="0" step="0.25" value={section.negative_marks}
              onChange={(e) => patch({ negative_marks: Number(e.target.value) })}
            />
          </div>
          <div>
            <span className="field-label">Section Time (min, optional)</span>
            <input
              type="number" min="1" value={section.time_limit_minutes ?? ''}
              placeholder="—"
              onChange={(e) => patch({ time_limit_minutes: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="field">
          <span className="field-label">Section Description</span>
          <input
            type="text" value={section.section_description || ''}
            placeholder="Shown to candidates above this section"
            onChange={(e) => patch({ section_description: e.target.value })}
          />
        </div>

        <div className="steps mb-2">
          {[['filters', 'Selection Rules'], ['distribution', 'Distribution'], ['exposure', 'Exposure'], ['advanced', 'Advanced Rule']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`step${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
              {key === 'distribution' && distribution && <span className="badge badge-brand">on</span>}
              {key === 'exposure' && hasExposure && <span className="badge badge-brand">on</span>}
              {key === 'advanced' && section.rule?.advanced && <span className="badge badge-brand">on</span>}
            </button>
          ))}
        </div>

        {tab === 'filters' && (
          <>
            <SetPicker onApply={(filter) => patchRule({ ...(filter || {}), advanced: section.rule?.advanced ?? (filter || {}).advanced ?? null })} />
            <FilterPanel meta={meta} rule={section.rule || {}} onChange={patchRule} compact />
          </>
        )}

        {tab === 'distribution' && (
          <>
            <div className="checkbox-row">
              <input
                id={`dist-${index}`} type="checkbox" checked={Boolean(distribution)} onChange={toggleDistribution}
              />
              <label htmlFor={`dist-${index}`}>
                Distribute this section across difficulty levels
                <span className="field-hint">
                  Instead of one flat filter, split the section — for example 20% Easy, 50% Medium, 30% Hard.
                </span>
              </label>
            </div>

            {distribution && (
              <>
                <div className="form-row mb-1">
                  <div>
                    <span className="field-label">Split by</span>
                    <select
                      value={distribution.field}
                      onChange={(e) => patch({ distribution: { ...distribution, field: e.target.value, values: {} } })}
                    >
                      <option value="difficulty">Difficulty</option>
                      <option value="question_type">Question Type</option>
                      <option value="subject">Subject</option>
                      <option value="area">Area / Topic</option>
                    </select>
                  </div>
                  <div>
                    <span className="field-label">Mode</span>
                    <select
                      value={distribution.mode}
                      onChange={(e) => patch({ distribution: { ...distribution, mode: e.target.value } })}
                    >
                      <option value="percentage">Percentage</option>
                      <option value="count">Exact counts</option>
                    </select>
                  </div>
                </div>

                {distributionKeys.map((key) => (
                  <div className="form-row mb-1" key={key}>
                    <div className="flex-gap">
                      <span style={{ minWidth: 130 }}>{key}</span>
                      <input
                        type="number" min="0" style={{ width: 90 }}
                        value={distributionValues[key] ?? ''}
                        placeholder="0"
                        onChange={(e) => setDistributionValue(key, e.target.value)}
                      />
                      <span className="muted small">
                        {isPercentage
                          ? `% ${allocation?.[key] != null ? `→ ${allocation[key]} question${allocation[key] === 1 ? '' : 's'}` : ''}`
                          : 'questions'}
                      </span>
                    </div>
                  </div>
                ))}

                <div className={`small ${isPercentage && Math.abs(distributionTotal - 100) > 0.5 ? 'alert alert-warning' : 'muted'}`}>
                  {isPercentage
                    ? `Total: ${distributionTotal}% ${Math.abs(distributionTotal - 100) > 0.5 ? '— must add up to 100%' : '✓'}`
                    : `Total: ${distributionTotal} question${distributionTotal === 1 ? '' : 's'} ${
                        distributionTotal === Number(section.question_count) ? '✓' : `— section requests ${section.question_count}`
                      }`}
                </div>

                {allocation && <DistributionBar counts={allocation} />}
              </>
            )}
          </>
        )}

        {tab === 'exposure' && (
          <>
            <p className="field-hint mb-2">
              Exposure control keeps a bank from leaking. It is measured from the tests actually generated,
              not from a stored counter, so it stays accurate.
            </p>

            <div className="checkbox-row">
              <input
                id={`never-used-${index}`} type="checkbox"
                checked={Boolean(rule.neverUsed)}
                onChange={(e) => patchRule({ ...rule, neverUsed: e.target.checked || undefined })}
              />
              <label htmlFor={`never-used-${index}`}>
                Only questions never used before
                <span className="field-hint">Useful for a brand-new sitting where nothing may have been seen.</span>
              </label>
            </div>

            <div className="form-row">
              <div className="field">
                <label htmlFor={`cooldown-${index}`}>Cooldown (days)</label>
                <input
                  id={`cooldown-${index}`} type="number" min="0" placeholder="—"
                  value={rule.usedWithinDays ?? ''}
                  onChange={(e) => patchRule({ ...rule, usedWithinDays: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
                <span className="field-hint">Exclude anything used in a test created within this window.</span>
              </div>
              <div className="field">
                <label htmlFor={`maxuse-${index}`}>Maximum previous uses</label>
                <input
                  id={`maxuse-${index}`} type="number" min="0" placeholder="—"
                  value={rule.maxUsageCount ?? ''}
                  onChange={(e) => patchRule({ ...rule, maxUsageCount: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
                <span className="field-hint">0 is equivalent to &ldquo;never used&rdquo;.</span>
              </div>
            </div>

            <div className="field">
              <label htmlFor={`exclude-tests-${index}`}>Exclude questions used in these tests</label>
              <input
                id={`exclude-tests-${index}`} type="text" placeholder="TST00012, TST00013"
                value={(rule.notUsedInTests || []).join(', ')}
                onChange={(e) => patchRule({
                  ...rule,
                  notUsedInTests: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                })}
              />
              <span className="field-hint">
                This is how parallel forms are built: form B excludes everything that appeared in form A.
              </span>
            </div>
          </>
        )}

        {tab === 'advanced' && (
          <RuleBuilder
            meta={meta}
            value={section.rule?.advanced || null}
            onChange={(advanced) => patchRule({ ...(section.rule || {}), advanced })}
          />
        )}

        <Availability
          section={section}
          excludeQids={excludeQids}
          onApplySuggestion={applySuggestion}
        />
      </div>
    </div>
  );
}
