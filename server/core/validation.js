/**
 * Test validation (spec §22).
 *
 * Returns a structured report rather than throwing, so the UI can show every
 * problem at once with a clear message per rule.
 */

import { checkSection } from './availability.js';
import { expandBuckets, sectionRequestedCount } from './distribution.js';
import { FilterError } from './filterEngine.js';

const OPTION_TYPES = new Set(['MCQ', 'Multiple Select', 'True/False']);

export function validateTestDefinition(test, sections, options = {}) {
  const { checkAvailability = true, selection = null } = options;
  const errors = [];
  const warnings = [];

  const add = (rule, message, section) => errors.push({ rule, message, section });
  const warn = (rule, message, section) => warnings.push({ rule, message, section });

  if (!test?.test_name || !String(test.test_name).trim()) {
    add('test_name', 'Test name is required.');
  }
  if (!(Number(test?.duration_minutes) > 0)) {
    add('duration', 'Test duration must be greater than zero minutes.');
  }
  if (test?.starts_at && test?.ends_at && test.starts_at >= test.ends_at) {
    add('schedule', 'The test end time must be after its start time.');
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    add('sections', 'A test must contain at least one section.');
    return report(errors, warnings, 0, 0);
  }

  let totalQuestions = 0;
  let totalMarks = 0;
  const seenNames = new Set();

  sections.forEach((section, index) => {
    const name = section.section_name || `Section ${index + 1}`;

    if (!section.section_name || !String(section.section_name).trim()) {
      add('section_name', 'Every section needs a name.', name);
    }
    const key = String(section.section_name || '').trim().toLowerCase();
    if (key && seenNames.has(key)) add('section_name', `Duplicate section name "${section.section_name}".`, name);
    seenNames.add(key);

    const count = Number(section.question_count ?? section.questionCount ?? 0);
    if (!Number.isInteger(count) || count <= 0) {
      add('question_count', `"${name}" must request a whole number of questions greater than zero.`, name);
    }

    const marksPer = Number(section.marks_per_question ?? section.marksPerQuestion ?? 0);
    if (!(marksPer > 0)) {
      add('marks', `"${name}" must define marks per question greater than zero.`, name);
    }

    const negative = Number(section.negative_marks ?? section.negativeMarks ?? 0);
    if (negative < 0) add('negative_marks', `"${name}" has a negative-marking value below zero.`, name);
    if (negative > marksPer) {
      warn('negative_marks', `"${name}" deducts more for a wrong answer than it awards for a right one.`, name);
    }

    if (section.time_limit_minutes != null && Number(section.time_limit_minutes) <= 0) {
      add('section_time', `"${name}" has an invalid section time limit.`, name);
    }

    // Distribution integrity (throws a FilterError with a precise message).
    let buckets = [];
    try {
      buckets = expandBuckets(section);
      const allocated = sectionRequestedCount(section);
      if (count && allocated !== count) {
        add('distribution', `"${name}" distributes ${allocated} questions but requests ${count}.`, name);
      }
    } catch (error) {
      if (error instanceof FilterError) add('distribution', error.message, name);
      else throw error;
    }

    // Question types must be compatible with how the section is scored.
    const types = section.rule?.question_type || [];
    if (Array.isArray(types) && types.length) {
      const hasSubjective = types.some((t) => t === 'Subjective');
      if (hasSubjective && negative > 0) {
        warn('type_compat', `"${name}" applies negative marking to Subjective questions, which are graded manually.`, name);
      }
      const mixed = types.some((t) => OPTION_TYPES.has(t)) && types.some((t) => !OPTION_TYPES.has(t));
      if (mixed) {
        warn('type_compat', `"${name}" mixes option-based and free-form question types; check the marks scheme.`, name);
      }
    }

    if (!section.rule || Object.keys(section.rule).length === 0) {
      warn('filters', `"${name}" has no filters and will draw from the entire active bank.`, name);
    }

    if (checkAvailability && count > 0 && buckets.length) {
      try {
        const availability = checkSection(section);
        if (!availability.sufficient) {
          add(
            'availability',
            `"${name}": only ${availability.deliverable} of ${availability.requested} requested questions are available.`,
            name,
          );
        }
      } catch (error) {
        if (error instanceof FilterError) add('filters', `"${name}": ${error.message}`, name);
        else throw error;
      }
    }

    totalQuestions += count;
    totalMarks += count * (marksPer || 0);
  });

  // Duplicate QIDs (spec §9) — checked against the concrete selection.
  if (selection) {
    const seen = new Map();
    for (const section of selection.sections || []) {
      for (const q of section.questions || []) {
        if (seen.has(q.qid)) {
          add('duplicates', `${q.qid} appears in both "${seen.get(q.qid)}" and "${section.sectionName}".`, section.sectionName);
        } else {
          seen.set(q.qid, section.sectionName);
        }
      }
    }
    const delivered = (selection.sections || []).reduce((a, s) => a + s.delivered, 0);
    const selectionMarks = (selection.sections || []).reduce((a, s) => a + s.marks, 0);
    if (test?.total_marks != null && Number(test.total_marks) > 0 && Math.abs(Number(test.total_marks) - selectionMarks) > 0.001) {
      warn('total_marks', `Declared total marks (${test.total_marks}) differ from the computed total (${selectionMarks}).`);
    }
    return report(errors, warnings, delivered, selectionMarks);
  }

  return report(errors, warnings, totalQuestions, totalMarks);
}

function report(errors, warnings, totalQuestions, totalMarks) {
  return { valid: errors.length === 0, errors, warnings, totalQuestions, totalMarks };
}
