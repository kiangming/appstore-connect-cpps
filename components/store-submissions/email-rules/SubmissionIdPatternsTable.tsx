'use client';

import { Plus, X } from 'lucide-react';

import {
  addRow,
  removeRow,
  updateRow,
  type SubmissionIdPatternDraft,
} from './helpers';
import { RegexInput } from './RegexInput';

export interface SubmissionIdPatternsTableProps {
  patterns: SubmissionIdPatternDraft[];
  onChange: (next: SubmissionIdPatternDraft[]) => void;
}

const emptyPattern = (): SubmissionIdPatternDraft => ({
  body_regex: '',
  active: true,
});

export function SubmissionIdPatternsTable({
  patterns,
  onChange,
}: SubmissionIdPatternsTableProps) {
  // Submission-ID patterns have no priority / sort_order — the classifier
  // scans every active row and returns the first match (source order). We
  // render in source order too so the Manager sees what the engine sees.

  const handleRegexChange = (idx: number, body_regex: string) =>
    onChange(updateRow(patterns, idx, { body_regex }));

  const handleActiveToggle = (idx: number) => {
    const current = patterns[idx];
    if (!current) return;
    onChange(updateRow(patterns, idx, { active: !current.active }));
  };

  const handleRemove = (idx: number) => onChange(removeRow(patterns, idx));

  const handleAdd = () => onChange(addRow(patterns, emptyPattern()));

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold">Submission ID Patterns</h2>
          <p className="text-[12.5px] text-slate-500 mt-0.5">
            Extract submission ID từ body để cross-reference ticket threads.
            Optional — empty list thì bỏ qua Step 5.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
          Add pattern
        </button>
      </div>

      {patterns.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-200 rounded-xl px-4 py-6 text-[12.5px] text-slate-500 italic">
          No submission ID patterns — Step 5 skipped on every email.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {patterns.map((p, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_auto_auto] gap-3 items-start px-4 py-3 border-b border-slate-100 last:border-b-0"
            >
              <RegexInput
                kind="submission_id"
                value={p.body_regex}
                onChange={(next) => handleRegexChange(idx, next)}
                placeholder="Submission ID: (?<submission_id>[A-Z0-9-]+)"
                ariaLabel="Submission ID regex"
              />
              <label className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 cursor-pointer select-none mt-2">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={() => handleActiveToggle(idx)}
                  className="h-3.5 w-3.5 accent-slate-900"
                />
                Active
              </label>
              <button
                type="button"
                aria-label="Remove pattern"
                onClick={() => handleRemove(idx)}
                className="text-slate-400 hover:text-red-600 p-1 mt-2"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
