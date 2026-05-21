"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { ALL_APPLE_LOCALES } from "@/lib/locale-utils";

/**
 * Reuses the 39-locale Apple list as a v1 locale set for Google Play
 * (substantial overlap; Manager can expand later if specific Google-only
 * locales become required). Keyed by BCP-47 code ("en-US").
 */
export const GOOGLE_LOCALES = ALL_APPLE_LOCALES;

export interface FormListing {
  title: string;
  description: string;
}

interface Props {
  listings: Record<string, FormListing>;
  activeLocale: string;
  defaultLocale: string;
  /** App-level default locale from Google Play (Hotfix 4). Rendered with
   *  a distinct "App default" badge when present and different from the
   *  form's own default. */
  appDefaultLocale?: string | null;
  onSelect: (locale: string) => void;
}

export function GoogleLocaleSidebar({
  listings,
  activeLocale,
  defaultLocale,
  appDefaultLocale = null,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");

  const filledCount = Object.values(listings).filter(
    (l) => l.title.trim().length > 0,
  ).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GOOGLE_LOCALES;
    return GOOGLE_LOCALES.filter(
      (l) =>
        l.label.toLowerCase().includes(q) || l.value.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <aside className="w-[240px] flex-shrink-0 border border-slate-200 rounded-lg bg-white flex flex-col">
      <div className="p-3 border-b border-slate-200">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search locales…"
            className="w-full pl-8 pr-2 py-1.5 rounded-md border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
          />
        </div>
        <p className="mt-2 text-[10px] text-slate-400 uppercase tracking-wide">
          {filledCount} / {GOOGLE_LOCALES.length} filled
        </p>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[480px]">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-slate-400 text-center">No matches.</p>
        ) : (
          <ul className="py-1">
            {filtered.map((locale) => {
              const entry = listings[locale.value];
              const hasTitle = Boolean(entry?.title.trim());
              const hasDescription = Boolean(entry?.description.trim());
              const filled = hasTitle && hasDescription;
              const partial = hasTitle || hasDescription;
              const active = activeLocale === locale.value;
              const isDefault = defaultLocale === locale.value;
              const isAppDefault =
                appDefaultLocale !== null && appDefaultLocale === locale.value;
              return (
                <li key={locale.value}>
                  <button
                    type="button"
                    onClick={() => onSelect(locale.value)}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-xs transition ${
                      active
                        ? "bg-emerald-50 text-emerald-700 font-medium"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <span className="truncate flex-1">
                      {locale.label}
                      {isDefault && (
                        <span className="ml-1 text-[9px] uppercase font-semibold text-emerald-600">
                          ★ default
                        </span>
                      )}
                      {isAppDefault && !isDefault && (
                        <span className="ml-1 text-[9px] uppercase font-semibold text-emerald-700 bg-emerald-100 border border-emerald-200 rounded px-1">
                          app
                        </span>
                      )}
                    </span>
                    {filled ? (
                      <span
                        className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500"
                        title="Title + Description filled"
                      />
                    ) : partial ? (
                      <span
                        className="flex-shrink-0 w-2 h-2 rounded-full bg-amber-400"
                        title="Partial fill"
                      />
                    ) : (
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
