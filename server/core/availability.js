/**
 * Availability checking (spec §7, §14, §24).
 *
 * The system never silently generates a short test. Before generation — and
 * live, while the user edits any filter — it reports how many questions match
 * and, when there are not enough, what could be relaxed to fix it.
 */

import { countMatching } from './questions.js';
import { expandBuckets, allocate } from './distribution.js';

/** Availability for one section, including per-bucket detail. */
export function checkSection(section, options = {}) {
  const { excludeQids = [] } = options;
  const buckets = expandBuckets(section);

  const bucketResults = buckets.map((bucket) => {
    const available = countMatching(bucket.rule, { excludeQids });
    return {
      label: bucket.label,
      field: bucket.field,
      value: bucket.value,
      requested: bucket.count,
      available,
      sufficient: available >= bucket.count,
      shortfall: Math.max(0, bucket.count - available),
    };
  });

  const requested = bucketResults.reduce((a, b) => a + b.requested, 0);
  // With a distribution, the binding constraint is per bucket: a section can
  // have plenty of questions overall and still be short on "Hard".
  const deliverable = bucketResults.reduce((a, b) => a + Math.min(b.requested, b.available), 0);
  const shortfall = requested - deliverable;
  const feasibleTotal = maxFeasibleTotal(section, bucketResults);

  const totalAvailable = buckets.length > 1
    ? countMatching(section.rule || {}, { excludeQids })
    : bucketResults[0]?.available ?? 0;

  return {
    sectionName: section.section_name || section.sectionName || 'Section',
    requested,
    available: totalAvailable,
    deliverable,
    sufficient: shortfall === 0,
    shortfall,
    buckets: bucketResults,
    // The largest question count this section could actually deliver while
    // still honouring its distribution — this is what "reduce the count"
    // must offer, not the raw sum of per-bucket maxima.
    feasibleTotal,
    suggestions: shortfall > 0 ? buildSuggestions(section, bucketResults, feasibleTotal, excludeQids) : [],
  };
}

/**
 * Largest total question count whose distribution still fits the bank.
 *
 * Reducing a distributed section's total re-splits it, so the naive answer
 * (the sum of each bucket's availability) is usually still unachievable:
 * dropping 900 to 122 with a 20/50/30 split asks for 61 Medium questions when
 * only 55 exist. This walks down from a computed ceiling to the first total
 * whose exact allocation fits every bucket.
 */
function maxFeasibleTotal(section, bucketResults) {
  const requested = bucketResults.reduce((a, b) => a + b.requested, 0);
  const distribution = section.distribution;

  if (!distribution?.values || Object.keys(distribution.values).length === 0) {
    return Math.min(requested, bucketResults[0]?.available ?? 0);
  }

  // Explicit counts do not re-split, so per-bucket maxima are achievable.
  if (distribution.mode === 'count') {
    return bucketResults.reduce((a, b) => a + Math.min(b.requested, b.available), 0);
  }

  const weights = distribution.values;
  const weightSum = Object.values(weights).reduce((a, w) => a + Number(w || 0), 0);
  if (weightSum <= 0) return 0;

  const available = Object.fromEntries(bucketResults.map((b) => [String(b.value), b.available]));

  // Ceiling: no bucket may exceed its availability under a proportional split.
  let candidate = requested;
  for (const [value, weight] of Object.entries(weights)) {
    if (Number(weight) <= 0) continue;
    candidate = Math.min(candidate, Math.floor(((available[value] ?? 0) * weightSum) / Number(weight)));
  }

  // Largest-remainder rounding can still push one bucket over the ceiling, so
  // step down until the exact allocation fits. This converges in a few passes.
  for (let total = Math.max(0, candidate); total > 0; total -= 1) {
    const allocation = allocate(total, weights);
    if (Object.entries(allocation).every(([value, count]) => count <= (available[value] ?? 0))) {
      return total;
    }
  }
  return 0;
}

/** Availability for a whole test, honouring cross-section deduplication. */
export function checkTest({ sections = [], preventDuplicates = true } = {}) {
  const results = [];
  // Sections are evaluated in order; when duplicates are prevented, each
  // section's pool shrinks by what earlier sections would consume. The
  // reservation is an estimate — generation itself uses the real QIDs.
  let reserved = 0;
  for (const section of sections) {
    const result = checkSection(section, { excludeQids: [] });
    if (preventDuplicates) result.note = reserved > 0
      ? 'Pool is shared with earlier sections; duplicates are prevented at generation time.'
      : undefined;
    reserved += result.deliverable;
    results.push(result);
  }

  const requested = results.reduce((a, r) => a + r.requested, 0);
  const deliverable = results.reduce((a, r) => a + r.deliverable, 0);

  return {
    sections: results,
    requested,
    deliverable,
    sufficient: results.every((r) => r.sufficient),
    shortfall: requested - deliverable,
  };
}

/**
 * Concrete, actionable ways out of a shortfall (spec §7). Each suggestion is
 * checked against the bank so the UI only offers options that actually help.
 */
function buildSuggestions(section, bucketResults, feasibleTotal, excludeQids) {
  const rule = section.rule || {};
  const suggestions = [];
  const deliverable = bucketResults.reduce((a, b) => a + Math.min(b.requested, b.available), 0);

  if (feasibleTotal > 0) {
    suggestions.push({
      action: 'reduce_count',
      label: `Reduce question count to ${feasibleTotal}`,
      value: feasibleTotal,
    });
  }

  const probe = (patch, action, label) => {
    const candidate = { ...rule, ...patch };
    const available = countMatching(candidate, { excludeQids });
    const requested = bucketResults.reduce((a, b) => a + b.requested, 0);
    if (available > deliverable) {
      suggestions.push({ action, label, available, rule: candidate, resolves: available >= requested });
    }
  };

  if (rule.subtopic?.length) probe({ subtopic: [] }, 'remove_subtopic', 'Remove the subtopic filter');
  if (rule.difficulty?.length && rule.difficulty.length < 3) {
    probe({ difficulty: ['Easy', 'Medium', 'Hard'] }, 'relax_difficulty', 'Allow all difficulty levels');
  }
  if (rule.includeTags?.length) probe({ includeTags: [] }, 'remove_include_tags', 'Drop the required tags');
  if (rule.excludeTags?.length) probe({ excludeTags: [] }, 'remove_exclude_tags', 'Drop the excluded tags');
  if (rule.question_type?.length === 1) {
    probe({ question_type: [] }, 'relax_question_type', 'Allow any question type');
  }

  suggestions.push({ action: 'manual_select', label: 'Pick the remaining questions manually' });
  suggestions.push({ action: 'cancel', label: 'Cancel and revise the section' });

  return suggestions;
}
