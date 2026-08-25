/** Adds extra questions to an existing section (spec §8, hybrid mode). */

import { useState } from 'react';
import api from '../lib/api.js';
import { useToast } from './Toast.jsx';
import ManualPicker from './ManualPicker.jsx';

export default function AddQuestionsModal({ testId, section, usedQids, onClose, onAdded }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const confirm = async (qids) => {
    const additions = qids.filter((qid) => !usedQids.includes(qid));
    if (!additions.length) {
      toast.warning('Those questions are already in this test.');
      return;
    }
    setBusy(true);
    try {
      await api.tests.addQuestions(testId, section.id, additions);
      toast.success(`Added ${additions.length} question${additions.length === 1 ? '' : 's'}.`);
      onAdded();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ManualPicker
      section={{
        section_name: `${section.section_name} — add questions`,
        // Reuse the section's own rule so additions stay on-brief.
        rule: section.selection_rules?.rule || {},
        question_count: 0,
        qids: [],
      }}
      excludeQids={usedQids}
      onClose={busy ? () => {} : onClose}
      onConfirm={confirm}
    />
  );
}
