"use client";

import { localeNameFromCode } from "@/lib/locale-utils";
import type { FormLocalization } from "@/lib/iap-management/validation";

interface Props {
  locale: string;
  value: FormLocalization | undefined;
  onChange: (next: FormLocalization) => void;
}

/**
 * Right-canvas editor for the currently-selected locale. Both fields are
 * required (Manager: "có cái nào import cái đó" pattern — partial fills are
 * surfaced as warnings via the checklist but don't break the form).
 */
export function LocaleEditor({ locale, value, onChange }: Props) {
  const displayName = value?.display_name ?? "";
  const description = value?.description ?? "";

  function patch(updates: Partial<FormLocalization>) {
    onChange({
      locale,
      display_name: displayName,
      description,
      ...updates,
    });
  }

  return (
    <div className="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {localeNameFromCode(locale)}
        </h3>
        <p className="text-xs font-mono text-slate-400 dark:text-slate-500 mt-0.5">{locale}</p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          Display Name
          <span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => patch({ display_name: e.target.value })}
          placeholder="Visible to customers in the App Store"
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
        />
        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          Localized name shown on the store page.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          Description
          <span className="text-red-500 ml-0.5">*</span>
        </label>
        <textarea
          rows={4}
          value={description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="Describes what the customer gets when they buy this IAP."
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition resize-none"
        />
      </div>
    </div>
  );
}
