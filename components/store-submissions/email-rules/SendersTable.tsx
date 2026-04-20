'use client';

import { Plus, X } from 'lucide-react';

import {
  addRow,
  removeRow,
  setPrimarySender,
  updateRow,
  type SenderDraft,
} from './helpers';

export interface SendersTableProps {
  senders: SenderDraft[];
  onChange: (next: SenderDraft[]) => void;
}

const emptySender = (): SenderDraft => ({
  email: '',
  is_primary: false,
  active: true,
});

export function SendersTable({ senders, onChange }: SendersTableProps) {
  const handleEmailChange = (idx: number, email: string) =>
    onChange(updateRow(senders, idx, { email }));

  const handleActiveToggle = (idx: number) => {
    const current = senders[idx];
    if (!current) return;
    onChange(updateRow(senders, idx, { active: !current.active }));
  };

  const handlePrimaryToggle = (idx: number) => {
    const current = senders[idx];
    if (!current) return;
    onChange(setPrimarySender(senders, idx, !current.is_primary));
  };

  const handleRemove = (idx: number) => onChange(removeRow(senders, idx));

  const handleAdd = () => onChange(addRow(senders, emptySender()));

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold">Senders</h2>
          <p className="text-[12.5px] text-slate-500 mt-0.5">
            Email từ sender này sẽ được nhận diện là platform này. Email
            không match sẽ bị drop.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
          Add sender
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {senders.length === 0 && (
          <div className="px-4 py-6 text-[12.5px] text-amber-700 italic">
            No senders configured — every inbound email will be dropped.
          </div>
        )}
        {senders.map((s, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 items-center px-4 py-2.5 border-b border-slate-100 last:border-b-0"
          >
            <label
              className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 cursor-pointer select-none"
              title="At most one sender can be marked primary. Unchecking leaves no primary."
            >
              <input
                type="checkbox"
                checked={s.is_primary}
                onChange={() => handlePrimaryToggle(idx)}
                className="h-3.5 w-3.5 accent-slate-900"
              />
              Primary
            </label>
            <input
              type="email"
              value={s.email}
              onChange={(e) => handleEmailChange(idx, e.target.value)}
              placeholder="no-reply@apple.com"
              className="px-2.5 py-1.5 border border-slate-200 rounded-md text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
            />
            <label className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={s.active}
                onChange={() => handleActiveToggle(idx)}
                className="h-3.5 w-3.5 accent-slate-900"
              />
              Active
            </label>
            <button
              type="button"
              aria-label="Remove sender"
              onClick={() => handleRemove(idx)}
              className="text-slate-400 hover:text-red-600 p-1"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
