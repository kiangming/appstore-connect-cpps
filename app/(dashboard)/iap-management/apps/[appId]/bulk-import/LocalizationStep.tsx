"use client";

/**
 * Bulk Import — the Localization step. Arc `[BULKIMPORT-loc-step]` C3.
 *
 * ⚠ WHY THIS STEP EXISTS. The import template is a faithful dump of what App
 * Store Connect already holds, so it always carries localization content even
 * when the job is "change the prices". On 2026-09-22 that cost 20 of 88 rows a
 * `409 Cannot edit InAppPurchaseLocalization when it is in ACTIVE state` — rows
 * that never needed a localization write. Before this step there was ONE number
 * in the preview (a `Loc` column counting locales), so there was no way to see
 * what was about to be written, and no way to decline it.
 *
 * ⚠⚠ SCOPE — READ BEFORE ADDING THE OBVIOUS MISSING FEATURE.
 * This step shows what is IN THE FILE. It does NOT compare against Apple.
 * Comparing (and the "identical to Apple ⇒ untick automatically" behaviour, the
 * per-cell ACTIVE warning, the four cell states) was designed, mocked up, and
 * then deliberately deferred by the Manager on 2026-09-23: *"tại thời điểm này
 * để user tự check tự xử lý."* It is tracked as `[BULKIMPORT-loc-compare-apple]`.
 * ⇒ Default here is TICK-ALL, which is exactly the pre-arc behaviour.
 *
 * ⚠ THE BLOCKER IT USED TO CITE IS GONE, AND THE PICTURE CHANGED UNDER IT.
 * This said the feature was blocked on "does Apple populate `state` on the
 * localization list?". Arc `[LOC-V2-model]` answered that (yes — KB §33.1) and
 * then made it irrelevant: under Apple's real model a localization has NO
 * state at all; the lifecycle belongs to the VERSION that owns it. The server
 * work this step would need now exists (`syncLocalizationsToVersion` already
 * reads the approved baseline and computes which locales differ, with three
 * distinct skip reasons — KB §32.11). What is missing is the UI half, and the
 * request budget for reading Apple at preview time.
 *
 * M-1 (Manager): each cell shows `Name` and `Desc` on their OWN labelled lines.
 * The point is being able to see WHICH field carries what, at a glance. The
 * arrow/amber "old → new" treatment from the mockup needs the Apple comparison
 * and is therefore not here.
 */
import { useMemo, useRef, useState } from "react";
import type { ParsedIapItem } from "@/lib/iap-management/parsers/iap-items";
import { useClickOutside } from "@/lib/hooks/use-click-outside";

export interface LocalizationSelectionState {
  ignoreAll: boolean;
  /** productId → locales that MAY be written. Absent item ⇒ all of its locales. */
  selected: Record<string, string[]>;
}

/** One (item × locale) cell — the unit the Manager ticks and the unit counted. */
interface Cell {
  productId: string;
  locale: string;
  localeName: string;
  displayName: string;
  description: string;
}

export interface LocalizationStepProps {
  items: ParsedIapItem[];
  value: LocalizationSelectionState;
  onChange: (next: LocalizationSelectionState) => void;
}

/**
 * Locales in file order, de-duplicated. Column order follows the spreadsheet so
 * the table reads like the file the Manager is holding.
 */
function localeColumns(items: ReadonlyArray<ParsedIapItem>) {
  const seen = new Map<string, string>();
  for (const it of items) {
    for (const l of it.localizations) {
      if (!seen.has(l.locale)) seen.set(l.locale, l.locale_name);
    }
  }
  return [...seen.entries()].map(([locale, locale_name]) => ({ locale, locale_name }));
}

function isTicked(
  value: LocalizationSelectionState,
  productId: string,
  locale: string,
): boolean {
  if (value.ignoreAll) return false;
  const row = value.selected[productId];
  // ⚠ ABSENT MEANS "ALL", MATCHING THE SERVER. `localization-selection.ts`
  // treats an unlisted product as "process everything" so a client/server skew
  // can never silently mass-skip. The UI must agree, or the boxes would lie.
  if (!row) return true;
  return row.includes(locale);
}

export function LocalizationStep({ items, value, onChange }: LocalizationStepProps) {
  const columns = useMemo(() => localeColumns(items), [items]);
  const rows = useMemo(() => items.filter((i) => i.localizations.length > 0), [items]);

  // Half-filled locale pairs. The parser drops them and records a per-item
  // warning that, until now, NOTHING rendered — `items[i].warnings` had no
  // consumer anywhere in the repo. A pair silently dropped is the same class of
  // problem this whole step exists to remove, so it is surfaced here.
  const droppedPairs = useMemo(
    () => items.filter((i) => i.warnings.length > 0).map((i) => ({ productId: i.product_id, warnings: i.warnings })),
    [items],
  );

  const totalCells = useMemo(
    () => items.reduce((n, i) => n + i.localizations.length, 0),
    [items],
  );
  const tickedCells = useMemo(() => {
    if (value.ignoreAll) return 0;
    let n = 0;
    for (const it of items) {
      for (const l of it.localizations) {
        if (isTicked(value, it.product_id, l.locale)) n++;
      }
    }
    return n;
  }, [items, value]);

  function setCell(productId: string, locale: string, on: boolean) {
    const item = items.find((i) => i.product_id === productId);
    if (!item) return;
    const current =
      value.selected[productId] ?? item.localizations.map((l) => l.locale);
    const next = on
      ? current.includes(locale)
        ? current
        : [...current, locale]
      : current.filter((l) => l !== locale);
    onChange({ ...value, selected: { ...value.selected, [productId]: next } });
  }

  /**
   * Column header — tri-state.
   * ⚠ FULL HEADER CLEARS THE COLUMN. Manager's explicit call: the default here
   * is everything ticked, so the real job is SUBTRACTING. (Do NOT port the
   * "never remove" rule from the territory picker — different default, opposite
   * work.)
   */
  function setColumn(locale: string, on: boolean) {
    const selected = { ...value.selected };
    for (const it of items) {
      if (!it.localizations.some((l) => l.locale === locale)) continue;
      const current =
        selected[it.product_id] ?? it.localizations.map((l) => l.locale);
      selected[it.product_id] = on
        ? current.includes(locale)
          ? current
          : [...current, locale]
        : current.filter((l) => l !== locale);
    }
    onChange({ ...value, selected });
  }

  function columnState(locale: string): "all" | "none" | "partial" {
    const cells = items.flatMap((it) =>
      it.localizations
        .filter((l) => l.locale === locale)
        .map((l) => isTicked(value, it.product_id, l.locale)),
    );
    if (cells.length === 0) return "none";
    if (cells.every(Boolean)) return "all";
    if (cells.every((c) => !c)) return "none";
    return "partial";
  }

  // ── Q7.1 — the file has no localization columns at all ───────────────────
  // ⚠ The step still RENDERS. Skipping it would make the stepper jump a
  // number, which is the exact bug class C1 removed; and a step that silently
  // disappears is a step the Manager cannot learn from.
  if (totalCells === 0) {
    return (
      <section
        data-testid="localization-step"
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6"
      >
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
          Localization
        </h2>
        <p
          data-testid="localization-empty"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          This file has no localization content — nothing to process in this
          step. Display names and descriptions on Apple will be left exactly as
          they are.
        </p>
        {droppedPairs.length > 0 && <DroppedPairs dropped={droppedPairs} />}
      </section>
    );
  }

  return (
    <section
      data-testid="localization-step"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
    >
      <div className="px-5 pt-5 pb-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
          Localization
        </h2>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Everything below is what the FILE contains. Untick anything this run
          should leave alone on Apple — the prices are unaffected either way.
        </p>
      </div>

      <div className="px-5 py-2 flex items-center gap-3 border-y border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            data-testid="localization-ignore-all"
            checked={value.ignoreAll}
            onChange={(e) => onChange({ ...value, ignoreAll: e.target.checked })}
          />
          <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
            Ignore all localizations
          </span>
        </label>
        <span className="text-[11px] text-slate-500">— update prices only</span>
        <span
          data-testid="localization-counter"
          className="ml-auto text-[11px] text-slate-600 dark:text-slate-300"
        >
          <strong>{tickedCells}</strong> / {totalCells} cells will be processed
        </span>
      </div>

      {/* ⚠ Sticky first column + sticky header, reusing MatrixTable's PATTERN
          (not its component — it takes tier × territory data, a different
          shape). N locale columns scroll horizontally; the Product ID must
          stay readable or the row means nothing. */}
      <div
        className={`overflow-auto ${value.ignoreAll ? "opacity-40 pointer-events-none" : ""}`}
        style={{ maxHeight: "min(60vh, 560px)" }}
        data-testid="localization-table-scroll"
      >
        <table className="border-separate border-spacing-0 w-max min-w-full">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 bg-slate-50 dark:bg-slate-800 border-b border-r-2 border-slate-300 dark:border-slate-700 px-3 py-2 text-left text-[11px] uppercase tracking-wider text-slate-500 w-[220px] min-w-[220px] max-w-[220px]">
                Product ID
              </th>
              {columns.map((c) => {
                const st = columnState(c.locale);
                return (
                  <th
                    key={c.locale}
                    className="sticky top-0 z-20 bg-slate-50 dark:bg-slate-800 border-b border-r border-slate-200 dark:border-slate-700 px-3 py-2 text-left align-top min-w-[260px]"
                  >
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid={`localization-col-${c.locale}`}
                        checked={st === "all"}
                        ref={(el) => {
                          // Tri-state: "partial" is a real third answer and has
                          // to LOOK like one, or a column with one cell unticked
                          // reads as fully off.
                          if (el) el.indeterminate = st === "partial";
                        }}
                        onChange={() => setColumn(c.locale, st !== "all")}
                      />
                      <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                        {c.locale_name}
                      </span>
                    </label>
                    <span className="block text-[10px] text-slate-400 mt-0.5 pl-6">
                      {st === "partial" ? "partial" : st === "all" ? "all" : "none"}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr key={it.product_id}>
                <td className="sticky left-0 z-10 bg-white dark:bg-slate-900 border-b border-r-2 border-slate-300 dark:border-slate-700 px-3 py-2 w-[220px] min-w-[220px] max-w-[220px] align-top">
                  <div className="font-mono text-[11px] text-slate-800 dark:text-slate-200 break-all">
                    {it.product_id}
                  </div>
                  <div className="text-[10px] text-slate-400">{it.reference_name}</div>
                </td>
                {columns.map((c) => {
                  const loc = it.localizations.find((l) => l.locale === c.locale);
                  if (!loc) {
                    return (
                      <td
                        key={c.locale}
                        className="border-b border-r border-slate-100 dark:border-slate-800 px-3 py-2 align-top text-[11px] text-slate-300"
                      >
                        —
                      </td>
                    );
                  }
                  return (
                    <td
                      key={c.locale}
                      className="border-b border-r border-slate-100 dark:border-slate-800 px-3 py-2 align-top min-w-[260px]"
                    >
                      <LocalizationCell
                        cell={{
                          productId: it.product_id,
                          locale: loc.locale,
                          localeName: loc.locale_name,
                          displayName: loc.display_name,
                          description: loc.description,
                        }}
                        ticked={isTicked(value, it.product_id, loc.locale)}
                        onToggle={(on) => setCell(it.product_id, loc.locale, on)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {droppedPairs.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800">
          <DroppedPairs dropped={droppedPairs} />
        </div>
      )}
    </section>
  );
}

/**
 * ⚠ M-1 — `Name` and `Desc` each get their OWN labelled line.
 * Manager's words: *"nhìn vào KHÔNG BIẾT cái đổi là display name hay
 * description."* It costs vertical space and that was accepted explicitly.
 */
function LocalizationCell({
  cell,
  ticked,
  onToggle,
}: {
  cell: Cell;
  ticked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useClickOutside(popRef, () => setOpen(false), open);

  return (
    <div className={`flex gap-2 ${ticked ? "" : "opacity-45"}`}>
      <input
        type="checkbox"
        data-testid={`localization-cell-${cell.productId}-${cell.locale}`}
        checked={ticked}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex gap-1.5 text-[11px]">
          <span className="shrink-0 w-9 text-slate-400 uppercase tracking-wide">Name</span>
          <span className="text-slate-800 dark:text-slate-200 break-words">
            {cell.displayName}
          </span>
        </div>
        <div className="flex gap-1.5 text-[11px] mt-0.5">
          <span className="shrink-0 w-9 text-slate-400 uppercase tracking-wide">Desc</span>
          <span className="text-slate-600 dark:text-slate-400 break-words line-clamp-2">
            {cell.description}
          </span>
        </div>
        <div className="relative">
          <button
            type="button"
            className="mt-1 text-[10px] text-[#0071E3] hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            detail
          </button>
          {open && (
            <div
              ref={popRef}
              data-testid={`localization-detail-${cell.productId}-${cell.locale}`}
              className="absolute z-40 mt-1 w-72 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-3"
            >
              <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
                {cell.localeName} · {cell.locale}
              </p>
              <p className="text-[11px] font-medium text-slate-500">Display Name</p>
              <p className="text-[11px] text-slate-800 dark:text-slate-200 break-words mb-2">
                {cell.displayName}
              </p>
              <p className="text-[11px] font-medium text-slate-500">Description</p>
              <p className="text-[11px] text-slate-700 dark:text-slate-300 break-words">
                {cell.description}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ⚠ A PAIR MISSING ONE HALF IS DROPPED BY THE PARSER, AND UNTIL NOW NOBODY WAS
 * TOLD. `iap-items.ts` records the reason on `items[i].warnings` — an array with
 * no consumer anywhere in the repo before this component. Rendering it turns a
 * silent skip into a stated one, which is the same value this whole step adds.
 */
function DroppedPairs({
  dropped,
}: {
  dropped: Array<{ productId: string; warnings: string[] }>;
}) {
  return (
    <div
      data-testid="localization-dropped-pairs"
      className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3"
    >
      <p className="text-[11px] font-medium text-amber-900 dark:text-amber-200">
        {dropped.length} row(s) had a locale filled in on only one side — the
        parser skipped those pairs, so they are not listed above and will not be
        written.
      </p>
      <ul className="mt-1 space-y-0.5">
        {dropped.map((d) => (
          <li key={d.productId} className="text-[10px] text-amber-800 dark:text-amber-300">
            <span className="font-mono">{d.productId}</span>: {d.warnings.join(" · ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
