/**
 * Question distribution (spec §6).
 *
 * A section can be described either by a flat filter ("10 Hard MCQs") or by a
 * distribution ("20 questions: 20% Easy / 50% Medium / 30% Hard"). This module
 * turns percentages or explicit counts into exact integer allocations that
 * always sum to the requested total.
 */

import { FilterError } from './filterEngine.js';

/**
 * Largest-remainder (Hare–Niemeyer) apportionment: converts weights into
 * integers summing exactly to `total`, so 20 questions at 20/50/30 yields
 * 4/10/6 rather than a rounding drift.
 */
export function allocate(total, weights) {
  const entries = Object.entries(weights).filter(([, w]) => Number(w) > 0);
  if (!entries.length) return {};

  const sum = entries.reduce((acc, [, w]) => acc + Number(w), 0);
  const exact = entries.map(([key, w]) => ({ key, exact: (Number(w) / sum) * total }));

  const result = {};
  let assigned = 0;
  for (const item of exact) {
    result[item.key] = Math.floor(item.exact);
    assigned += result[item.key];
  }

  const remainder = total - assigned;
  const byRemainder = [...exact].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.key.localeCompare(b.key),
  );
  for (let i = 0; i < remainder; i += 1) {
    result[byRemainder[i % byRemainder.length].key] += 1;
  }

  return result;
}

/**
 * Expands a section's `distribution` block into concrete buckets, each with
 * its own filter and question count.
 *
 * Supported shapes:
 *   { field: 'difficulty', mode: 'percentage', values: { Easy: 20, Medium: 50, Hard: 30 } }
 *   { field: 'question_type', mode: 'count', values: { MCQ: 10, Coding: 5 } }
 *
 * Returns `[{ label, field, value, count, rule }]`. With no distribution the
 * section resolves to a single bucket carrying its own rule.
 */
export function expandBuckets(section) {
  const baseRule = section.rule || {};
  const requested = Number(section.question_count ?? section.questionCount ?? 0);
  const dist = section.distribution;

  if (!dist || !dist.values || Object.keys(dist.values).length === 0) {
    return [{ label: 'All', field: null, value: null, count: requested, rule: baseRule }];
  }

  const field = dist.field || 'difficulty';
  const mode = dist.mode || 'percentage';
  const values = dist.values;

  let counts;
  if (mode === 'count') {
    counts = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.max(0, Math.round(Number(v) || 0))]));
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    if (requested && sum !== requested) {
      throw new FilterError(
        `Distribution for "${section.section_name || 'section'}" allocates ${sum} questions but the section requests ${requested}.`,
      );
    }
  } else {
    const pctSum = Object.values(values).reduce((a, b) => a + Number(b || 0), 0);
    if (Math.abs(pctSum - 100) > 0.5) {
      throw new FilterError(
        `Distribution percentages for "${section.section_name || 'section'}" total ${pctSum}%, they must total 100%.`,
      );
    }
    counts = allocate(requested, values);
  }

  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([value, count]) => ({
      label: `${value}`,
      field,
      value,
      count,
      // Bucket value overrides the base rule for that one field.
      rule: { ...baseRule, [field]: [value] },
    }));
}

/** Sum of the counts a section will actually request. */
export function sectionRequestedCount(section) {
  const buckets = expandBuckets(section);
  return buckets.reduce((acc, b) => acc + b.count, 0);
}
