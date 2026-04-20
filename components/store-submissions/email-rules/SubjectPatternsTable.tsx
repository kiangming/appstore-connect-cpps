'use client';

import { useMemo } from 'react';
import { Plus, X } from 'lucide-react';

import {
  addRow,
  nextNumericField,
  removeRow,
  updateRow,
  type SubjectPatternDraft,
} from './helpers';
import { RegexInput } from './RegexInput';

export interface SubjectPatternsTableProps {
  patterns: SubjectPatternDraft[];
  onChange: (next: SubjectPatternDraft[]) => void;
}

const OUTCOMES = ['APPROVED', 'REJECTED', 'IN_REVIEW'] as const;

const OUTCOME_CHIP: Record<
  SubjectPatternDraft['outcome'],
  { label: string; cls: string }
> = {
  APPROVED: { label: 'APPROVED', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  REJECTED: { label: 'REJECTED', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  IN_REVIEW: { label: 'IN_REVIEW', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
};

const emptyPattern = (): SubjectPatternDraft => ({
  outcome: 'APPROVED',
  regex: '',
  priority: 100,
  example_subject: null,
  active: true,
});

export function SubjectPatternsTable({
  patterns,
  onChange,
}: SubjectPatternsTableProps) {
  // Render order = priority ASC. Editing a priority number re-sorts the
  // view on next render; spec risk §5 (rows may "jump") accepted.
  // We keep the underlying array unsorted so `updateRow(idx, …)` still
  // targets the row the user clicked — the index on the rendered view is
  // the same as the index in the source array because we map over the
  // sorted projection and use the source index it came from.
  const sortedView = useMemo(
    () =>
      patterns
        .map((p, sourceIdx) => ({ pattern: p, sourceIdx }))
        .sort((a, b) => a.pattern.priority - b.pattern.priority),
    [patterns],
  );

  const handleOutcomeChange = (
    sourceIdx: number,
    outcome: SubjectPatternDraft['outcome'],
  ) => onChange(updateRow(patterns, sourceIdx, { outcome }));

  const handleRegexChange = (sourceIdx: number, regex: string) =>
    onChange(updateRow(patterns, sourceIdx, { regex }));

  const handlePriorityChange = (sourceIdx: number, raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    // Clamp to schema bounds (0..10000) so out-of-range typing can't break
    // the Save button's zod validation path.
    const clamped = Math.max(0, Math.min(10_000, parsed));
    onChange(updateRow(patterns, sourceIdx, { priority: clamped }));
  };

  const handleActiveToggle = (sourceIdx: number) => {
    const current = patterns[sourceIdx];
    if (!current) return;
    onChange(updateRow(patterns, sourceIdx, { active: !current.active }));
  };

  const handleRemove = (sourceIdx: number) =>
    onChange(removeRow(patterns, sourceIdx));

  const handleAdd = () =>
    onChange(
      addRow(patterns, {
        ...emptyPattern(),
        priority: nextNumericField(patterns, 'priority'),
      }),
    );

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold">Subject Patterns</h2>
          <p className="text-[12.5px] text-slate-500 mt-0.5">
            Regex trên subject để xác định outcome. Match theo thứ tự
            priority, lấy pattern đầu tiên khớp.
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

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {patterns.length === 0 && (
          <div className="px-4 py-6 text-[12.5px] text-slate-500 italic">
            No subject patterns — every email will be marked ERROR (no match).
          </div>
        )}
        {sortedView.map(({ pattern, sourceIdx }) => {
          const chip = OUTCOME_CHIP[pattern.outcome];
          return (
            <div
              key={sourceIdx}
              className="grid grid-cols-[140px_1fr_90px_auto_auto] gap-3 items-start px-4 py-3 border-b border-slate-100 last:border-b-0"
            >
              <div className="space-y-1">
                <select
                  value={pattern.outcome}
                  onChange={(e) =>
                    handleOutcomeChange(
                      sourceIdx,
                      e.target.value as SubjectPatternDraft['outcome'],
                    )
                  }
                  aria-label="Outcome"
                  className={`w-full px-2 py-1 text-[11.5px] font-semibold uppercase tracking-wider rounded-md border ${chip.cls} focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20`}
                >
                  {OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>

              <RegexInput
                kind="subject"
                value={pattern.regex}
                onChange={(next) => handleRegexChange(sourceIdx, next)}
                placeholder="Review of your (?<app_name>.+) submission is complete\."
                ariaLabel="Subject regex"
              />

              <div>
                <label className="block text-[10.5px] text-slate-500 uppercase tracking-wider mb-0.5">
                  Priority
                </label>
                <input
                  type="number"
                  min={0}
                  max={10_000}
                  value={pattern.priority}
                  onChange={(e) => handlePriorityChange(sourceIdx, e.target.value)}
                  className="w-full px-2 py-1 border border-slate-200 rounded-md text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
                />
              </div>

              <label className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 cursor-pointer select-none mt-5">
                <input
                  type="checkbox"
                  checked={pattern.active}
                  onChange={() => handleActiveToggle(sourceIdx)}
                  className="h-3.5 w-3.5 accent-slate-900"
                />
                Active
              </label>

              <button
                type="button"
                aria-label="Remove pattern"
                onClick={() => handleRemove(sourceIdx)}
                className="text-slate-400 hover:text-red-600 p-1 mt-5"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
