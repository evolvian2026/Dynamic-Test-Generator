/**
 * Smart generation blueprints (spec §26).
 *
 * A blueprint describes *what a test should look like* — total questions,
 * difficulty mix, topic coverage, type mix — and this module expands it into
 * concrete sections with concrete selection rules. Questions are always drawn
 * from the existing bank; nothing is ever invented.
 */

import { allocate } from '../core/distribution.js';
import { countMatching } from '../core/questions.js';

export const BLUEPRINTS = [
  {
    id: 'dsa-placement',
    name: 'DSA Placement Test',
    description: '50 questions balanced across the core data-structure topics.',
    totalQuestions: 50,
    difficultyMix: { Easy: 20, Medium: 50, Hard: 30 },
    questionTypeMix: { MCQ: 70, 'Multiple Select': 20, Coding: 10 },
    topics: ['Arrays', 'Strings', 'Linked List', 'Stack', 'Queue', 'Trees', 'Graph', 'Dynamic Programming'],
    marksPerQuestion: 2,
  },
  {
    id: 'quick-diagnostic',
    name: 'Quick Diagnostic',
    description: '20 easy-to-medium questions for a fast skills check.',
    totalQuestions: 20,
    difficultyMix: { Easy: 50, Medium: 50 },
    questionTypeMix: { MCQ: 100 },
    topics: ['Arrays', 'Strings', 'Sorting', 'Searching'],
    marksPerQuestion: 1,
  },
  {
    id: 'coding-round',
    name: 'Coding Round',
    description: 'Five substantial coding problems weighted towards the harder end.',
    totalQuestions: 5,
    difficultyMix: { Medium: 60, Hard: 40 },
    questionTypeMix: { Coding: 100 },
    topics: ['Arrays', 'Strings', 'Dynamic Programming', 'Graph'],
    marksPerQuestion: 10,
  },
  {
    id: 'db-screening',
    name: 'Database Screening',
    description: 'SQL concepts plus query writing.',
    totalQuestions: 25,
    difficultyMix: { Easy: 30, Medium: 50, Hard: 20 },
    questionTypeMix: { MCQ: 60, SQL: 40 },
    topics: ['SQL & Databases'],
    marksPerQuestion: 2,
  },
];

/**
 * Expands a blueprint into sections — one per question type — each carrying a
 * difficulty distribution. Every section is availability-checked so the user
 * sees up front whether the bank can deliver the blueprint.
 */
export function buildBlueprintSections(input) {
  const blueprint = input.blueprintId ? BLUEPRINTS.find((b) => b.id === input.blueprintId) : null;

  const totalQuestions = input.totalQuestions ?? blueprint?.totalQuestions ?? 50;
  const difficultyMix = input.difficultyMix ?? blueprint?.difficultyMix ?? { Easy: 20, Medium: 50, Hard: 30 };
  const questionTypeMix = input.questionTypeMix ?? blueprint?.questionTypeMix ?? { MCQ: 100 };
  const topics = input.topics?.length ? input.topics : blueprint?.topics ?? [];
  const marksPerQuestion = input.marksPerQuestion ?? blueprint?.marksPerQuestion ?? 1;

  const perType = allocate(totalQuestions, questionTypeMix);

  const sections = Object.entries(perType)
    .filter(([, count]) => count > 0)
    .map(([type, count], index) => {
      const rule = {
        question_type: [type],
        ...(topics.length ? { topic: topics } : {}),
        ...(input.includeTags?.length ? { includeTags: input.includeTags } : {}),
        ...(input.excludeTags?.length ? { excludeTags: input.excludeTags } : {}),
      };
      return {
        section_name: `${type}`,
        section_description: `${count} ${type} questions${topics.length ? ` across ${topics.length} topic(s)` : ''}.`,
        section_order: index + 1,
        question_count: count,
        marks_per_question: type === 'Coding' ? Math.max(marksPerQuestion, 10) : marksPerQuestion,
        negative_marks: type === 'Coding' || type === 'Subjective' ? 0 : Math.round(marksPerQuestion * 0.25 * 100) / 100,
        rule,
        distribution: { field: 'difficulty', mode: 'percentage', values: difficultyMix },
      };
    });

  // Report feasibility per section so the UI can flag gaps before generating.
  const feasibility = sections.map((section) => ({
    section: section.section_name,
    requested: section.question_count,
    available: countMatching(section.rule),
  }));

  return {
    blueprint: blueprint ? { id: blueprint.id, name: blueprint.name } : null,
    totalQuestions,
    totalMarks: sections.reduce((a, s) => a + s.question_count * s.marks_per_question, 0),
    sections,
    feasibility,
  };
}
