"use client";

/**
 * "Download template" button + locale-picker modal — THE single shared
 * call-site component for the bulk-import template download, used by
 * BOTH modules in BOTH places (apps-list page header + bulk-import
 * wizard header). Four call sites, one component: generation stays in
 * lib/xlsx-template.ts + each module's parsers/template-spec.ts, and
 * this component only collects a locale selection and triggers it.
 *
 * `getSpec` is a factory prop and `localeOptions` a data prop (not
 * imports) on purpose: the component must not import either module's
 * template-spec, or every consumer would bundle BOTH locale maps. Each
 * call site passes its own module's options + factory — Apple pages
 * never carry Google's 82-locale map and vice versa. xlsx stays in a
 * lazy chunk loaded on confirm (downloadXlsxTemplate dynamic-imports).
 *
 * Selection semantics (design-bulk-import-locale-picker.md §A):
 *   - NOTHING is pre-ticked and the selection is NOT remembered between
 *     opens — a stale unnoticed selection is worse than re-picking.
 *   - ZERO locales is a valid, first-class output (core columns only),
 *     and because nothing is pre-ticked it is the DEFAULT path: open →
 *     confirm. The zero-state banner explains what that file is rather
 *     than treating it as an error.
 *   - Only LOCALE columns are selectable; core/structural columns are
 *     always present and never appear here.
 */

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Search, X } from "lucide-react";

import {
  downloadXlsxTemplate,
  type LocaleOption,
  type XlsxTemplateSpec,
} from "@/lib/xlsx-template";

export interface DownloadTemplateButtonProps {
  /** This module's selectable locales (precomputed display strings). */
  localeOptions: readonly LocaleOption[];
  /** Module template spec factory. Receives the selected locale NAMES
   *  (possibly empty = core-only). */
  getSpec: (selectedLocaleNames: readonly string[]) => XlsxTemplateSpec;
  /** Visible label — explicit by design (discoverability), never an
   *  unlabeled icon. */
  label?: string;
  /** Full styling control per module (Apple blue vs Google emerald). */
  className?: string;
  /** Module accent for modal controls: Tailwind classes for the confirm
   *  button. */
  confirmClassName?: string;
  /** Extra module-specific caution rendered inside the zero-state
   *  banner (Google's overwrite-replaces-listings warning). */
  zeroLocaleCaution?: string;
  /** Route download errors into the caller's error UI; when omitted a
   *  small inline message renders under the button. */
  onError?: (message: string) => void;
}

const DEFAULT_CLASSES =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60";
const DEFAULT_CONFIRM =
  "inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60";

function matches(option: LocaleOption, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    option.language.toLowerCase().includes(q) ||
    option.country.toLowerCase().includes(q) ||
    option.code.toLowerCase().includes(q) ||
    option.name.toLowerCase().includes(q)
  );
}

export function DownloadTemplateButton({
  localeOptions,
  getSpec,
  label = "Download template",
  className = DEFAULT_CLASSES,
  confirmClassName = DEFAULT_CONFIRM,
  zeroLocaleCaution,
  onError,
}: DownloadTemplateButtonProps) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Every open starts empty (Manager lock: no pre-tick, no memory).
  useEffect(() => {
    if (open) {
      setSearch("");
      setSelected(new Set());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const visible = useMemo(
    () => localeOptions.filter((o) => matches(o, search)),
    [localeOptions, search],
  );

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** Select-all applies to the CURRENT FILTER, so searching "English"
   *  then Select all picks exactly its variants. */
  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const o of visible) next.add(o.name);
      return next;
    });
  }

  async function handleConfirm() {
    setDownloading(true);
    setInlineError(null);
    try {
      // Canonical column order comes from the spec, not from click
      // order — the selection is a SET of names.
      await downloadXlsxTemplate(getSpec([...selected]));
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Template download failed";
      if (onError) onError(message);
      else setInlineError(message);
    } finally {
      setDownloading(false);
    }
  }

  const count = selected.size;

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
      >
        <Download className="h-3.5 w-3.5" />
        {label}
      </button>
      {inlineError && (
        <span className="mt-1 text-[11px] text-red-600">{inlineError}</span>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Download bulk import template"
        >
          <div className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-xl bg-white shadow-2xl dark:bg-slate-900">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Download bulk import template
                </p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Pick the locales you want columns for. Core columns
                  (Product ID, price, …) are always included.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-slate-400 transition hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search language, country or code…"
                  className="w-full rounded-md border border-slate-200 py-1.5 pl-8 pr-2 text-xs placeholder:text-slate-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <button
                type="button"
                onClick={selectAllVisible}
                className="shrink-0 rounded-md border border-slate-200 px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
              >
                Select all shown
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="shrink-0 rounded-md border border-slate-200 px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
              >
                Clear all
              </button>
            </div>

            <p className="px-5 pt-3 text-[11px] text-slate-500 dark:text-slate-400">
              Selected <strong className="text-slate-900 dark:text-slate-100">{count}</strong>{" "}
              of {localeOptions.length} locales
            </p>

            {count === 0 && (
              <div className="mx-5 mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                No locales selected — the template will contain only the
                core columns (no Title/Description columns). That is a
                valid template: products import without localizations.
                {zeroLocaleCaution ? ` ${zeroLocaleCaution}` : ""}
              </div>
            )}

            <div className="mt-2 grid grid-cols-[28px_1fr_1fr_88px] gap-2 px-6 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <span />
              <span>Language</span>
              <span>Country / variant</span>
              <span className="text-right">Code</span>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pb-3">
              {visible.length === 0 && (
                <p className="px-3 py-4 text-xs text-slate-500">
                  No locale matches “{search}”.
                </p>
              )}
              {visible.map((o) => (
                <label
                  key={o.name}
                  className="grid cursor-pointer grid-cols-[28px_1fr_1fr_88px] items-center gap-2 rounded-md px-3 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.name)}
                    onChange={() => toggle(o.name)}
                    aria-label={`${o.language} (${o.code})`}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-slate-900 dark:text-slate-100">
                    {o.language}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {o.country}
                  </span>
                  <span className="text-right font-mono text-[10px] text-slate-400">
                    {o.code}
                  </span>
                </label>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs text-slate-500 transition hover:text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={downloading}
                className={confirmClassName}
              >
                {downloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {count === 0
                  ? "Download template (core columns only)"
                  : `Download template (${count} locale${count === 1 ? "" : "s"})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
