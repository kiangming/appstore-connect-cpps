"use client";

/**
 * "Export options" dialog — shared by Google IAP export and Apple IAP
 * export (docs/google-iap-management/design/export-options-dialog-mockup.html,
 * commit 6465178). ONE component, imported by both modules' IapListClient
 * — not duplicated per platform.
 *
 * Lets the operator pick which country/currency territory-price columns
 * to include before downloading. Default state = every catalog territory
 * selected, preserving today's export-everything behavior for anyone who
 * opens the dialog and clicks Export without touching anything.
 *
 * Selection contract (see the export routes): while nothing has been
 * deselected, `onExport` receives `null` — meaning "no filter," so the
 * backend exports every territory the live fetch actually found, exactly
 * like before this feature existed. This is deliberate, not just an
 * optimization: it makes the default path immune to any gap in this
 * catalog (~182 hand-curated territories vs. Apple/Google's real ~175-ish
 * sets, which may not match this list 1:1 in every edge case). Only once
 * the operator has explicitly deselected at least one territory does
 * `onExport` receive the literal list of remaining selected codes, which
 * the backend intersects against the real per-item territory union.
 *
 * Style: navy #0c447c + stone, matching the approved mockup. Tailwind's
 * built-in `stone-*` scale needs no config change; the accent color uses
 * arbitrary-value utilities (`bg-[#0c447c]` etc.) since it's not (yet) a
 * theme token. `dark:` variants rely on the app's existing global
 * `next-themes` + `darkMode: ["class"]` setup (already live elsewhere in
 * the Apple IAP module, e.g. AvailabilitiesBulkModal.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import {
  TERRITORY_CATALOG,
  TERRITORY_REGIONS,
  ALL_TERRITORY_CODES,
  type TerritoryEntry,
} from "@/lib/iap-management/territory-catalog";

export interface ExportOptionsDialogProps {
  open: boolean;
  onCancel: () => void;
  /** `null` = no filter (every territory the fetch found — default,
   *  untouched-selection path). A non-null array is the literal set of
   *  territory codes the operator left checked. */
  onExport: (selectedCodes: string[] | null) => void;
}

function matchesQuery(t: TerritoryEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    t.name.toLowerCase().includes(q) ||
    t.code.toLowerCase().includes(q) ||
    t.currency.toLowerCase().includes(q)
  );
}

export function ExportOptionsDialog({
  open,
  onCancel,
  onExport,
}: ExportOptionsDialogProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ALL_TERRITORY_CODES),
  );

  // Reset to the default (all-selected, empty search) every time the
  // dialog opens — a stale partial selection from a prior open would be
  // a confusing silent trap otherwise.
  useEffect(() => {
    if (open) {
      setSearch("");
      setSelected(new Set(ALL_TERRITORY_CODES));
    }
  }, [open]);

  const visible = useMemo(
    () => TERRITORY_CATALOG.filter((t) => matchesQuery(t, search)),
    [search],
  );

  const grouped = useMemo(() => {
    const byRegion = new Map<string, TerritoryEntry[]>();
    for (const t of visible) {
      const list = byRegion.get(t.region) ?? [];
      list.push(t);
      byRegion.set(t.region, list);
    }
    return TERRITORY_REGIONS.map((region) => ({
      region,
      entries: byRegion.get(region) ?? [],
    })).filter((g) => g.entries.length > 0);
  }, [visible]);

  if (!open) return null;

  const total = ALL_TERRITORY_CODES.length;
  const count = selected.size;
  const isAllSelected = count === total;

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(ALL_TERRITORY_CODES));
  }

  function clearAll() {
    setSelected(new Set());
  }

  function handleExport() {
    onExport(isAllSelected ? null : Array.from(selected));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 shadow-xl">
        {/* Header */}
        <div className="px-5 pt-[18px] pb-3.5 border-b border-stone-100 dark:border-stone-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100">
                Export options
              </h3>
              <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
                Choose which countries &amp; currencies to include in the exported file.
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="flex-shrink-0 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-stone-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search country, code, or currency…"
              className="w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 pl-8 pr-3 py-2 text-[13px] text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#0c447c]/30 focus:border-[#0c447c] transition"
            />
          </div>

          {/* Select all / clear all + live count */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={selectAll}
                className="text-xs font-semibold text-stone-500 hover:text-[#0c447c] dark:text-stone-400 dark:hover:text-[#7ea8d8]"
              >
                Select all
              </button>
              <span className="text-stone-300 dark:text-stone-700">|</span>
              <button
                type="button"
                onClick={clearAll}
                className="text-xs font-semibold text-stone-500 hover:text-[#0c447c] dark:text-stone-400 dark:hover:text-[#7ea8d8]"
              >
                Clear all
              </button>
            </div>
            <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
              {count} of {total} selected
            </span>
          </div>

          {/* List */}
          <div className="max-h-[360px] overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-800">
            {grouped.length === 0 ? (
              <div className="py-9 px-4 text-center text-[13px] text-stone-400">
                No countries match &ldquo;{search}&rdquo;.
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.region}>
                  <div className="sticky top-0 z-[1] bg-stone-100 dark:bg-stone-800/80 text-stone-500 dark:text-stone-400 text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 border-b border-stone-200 dark:border-stone-700">
                    {group.region}
                  </div>
                  {group.entries.map((t) => (
                    <label
                      key={t.code}
                      className="flex items-center gap-2.5 px-3 py-[7px] border-b border-stone-100 dark:border-stone-800 last:border-b-0 cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(t.code)}
                        onChange={() => toggle(t.code)}
                        className="h-3.5 w-3.5 flex-shrink-0 rounded border-stone-300 dark:border-stone-600 accent-[#0c447c]"
                      />
                      <span className="flex-1 min-w-0 truncate text-[13px] text-stone-900 dark:text-stone-100">
                        {t.name}
                      </span>
                      <span className="flex-shrink-0 rounded-md bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 text-[11px] px-1.5 py-0.5 font-mono">
                        {t.code} · {t.currency}
                      </span>
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-100 dark:border-stone-800 bg-stone-50 dark:bg-stone-950/40 rounded-b-2xl flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 text-sm font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={count === 0}
            className="px-4 py-2 text-sm font-medium bg-[#0c447c] hover:bg-[#0d4f8f] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {count === 0
              ? "Select at least 1 country"
              : `Export ${count} countr${count === 1 ? "y" : "ies"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
