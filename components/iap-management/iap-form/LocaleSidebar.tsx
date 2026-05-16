"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ALL_APPLE_LOCALES } from "@/lib/locale-utils";
import { filledLocalizationCount } from "@/lib/iap-management/validation";
import type { FormLocalization } from "@/lib/iap-management/validation";

interface Props {
  /** Map of localeCode → form fields. */
  localizations: Record<string, FormLocalization>;
  /** Currently selected locale code (e.g. "en-US"). */
  activeLocale: string;
  onSelect: (locale: string) => void;
}

/**
 * 240px sidebar with searchable list of all 39 Apple locales. Each row shows
 * a "has data" dot when both Display Name + Description are filled for that
 * locale. Default selection: English (U.S.) (en-US).
 */
export function LocaleSidebar({
  localizations,
  activeLocale,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");

  const filledCount = filledLocalizationCount(localizations);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_APPLE_LOCALES;
    return ALL_APPLE_LOCALES.filter(
      (l) =>
        l.label.toLowerCase().includes(q) || l.value.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <aside className="w-[240px] flex-shrink-0 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 flex flex-col">
      <div className="p-3 border-b border-slate-200 dark:border-slate-800">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search locales…"
            className="w-full pl-8 pr-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs placeholder:text-slate-400 dark:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
          />
        </div>
        <p className="mt-2 text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">
          {filledCount} / {ALL_APPLE_LOCALES.length} filled
        </p>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[480px]">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-slate-400 dark:text-slate-500 text-center">No matches.</p>
        ) : (
          <ul className="py-1">
            {filtered.map((locale) => {
              const entry = localizations[locale.value];
              const hasData = Boolean(
                entry?.display_name.trim() && entry?.description.trim(),
              );
              const partial = Boolean(
                !hasData &&
                  (entry?.display_name.trim() || entry?.description.trim()),
              );
              const active = activeLocale === locale.value;
              return (
                <li key={locale.value}>
                  <button
                    type="button"
                    onClick={() => onSelect(locale.value)}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-xs transition ${
                      active
                        ? "bg-blue-50 text-[#0071E3] font-medium"
                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    }`}
                  >
                    <span className="truncate flex-1">{locale.label}</span>
                    {hasData && (
                      <span
                        className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500"
                        title="Display Name + Description filled"
                      >
                        <span className="sr-only">filled</span>
                      </span>
                    )}
                    {partial && (
                      <span
                        className="flex-shrink-0 w-2 h-2 rounded-full bg-amber-400"
                        title="Partial fill"
                      />
                    )}
                    {!hasData && !partial && (
                      <span
                        className="flex-shrink-0 w-2 h-2 rounded-full bg-slate-200"
                        aria-hidden
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

