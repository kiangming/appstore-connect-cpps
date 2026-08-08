"use client";

import { Check, AlertTriangle, ArrowRight, XCircle, Pencil } from "lucide-react";

import type { PreviewRow, PreviewTierCandidate } from "./BulkImportWizard";

/** Sentinel for the dropdown's Custom entry. It is a TRIGGER ONLY and is
 *  intercepted in the change handler — it must never be stored as the
 *  row's tier selection. A sentinel that leaked into
 *  `chosenTierIdentifier` would reach
 *  `lookupTemplateEntriesForIdentifier`, which THROWS for a tier with no
 *  entries (bulk-import.ts:579-585), failing the whole batch. */
const CUSTOM_OPTION = "__custom__";

interface Props {
  rows: PreviewRow[];
  onRowDecisionChange: (rowNumber: number, decision: "overwrite" | "skip") => void;
  // Hotfix 19 — tier-selection plumbing.
  tierSelections: Record<number, string>;
  onTierSelectionChange: (rowNumber: number, identifier: string) => void;
  /** Per-item custom prices, keyed by SKU. Presence = the row has a set. */
  customPriceCounts?: Record<string, number>;
  /** SKUs whose customs will actually ship: a saved set on a row that is
   *  NOT set to Skip. Others render greyed as inactive.
   *
   *  ⚠ SCOPE — the pricing source is NOT part of this condition, and must
   *  not be re-added. Custom prices apply under ALL THREE sources; under
   *  Google Conversion they are a sparse overlay on the base price, which
   *  is the whole point of that path. This once read "source is a template
   *  AND the row isn't skipped", and restoring that clause would silently
   *  stop sending customs under Google Conversion again — the defect that
   *  the sparse-overlay work exists to fix. Skip is the ONLY deactivator. */
  activeCustomSkus?: ReadonlySet<string>;
  onOpenCustomDialog?: (sku: string) => void;
  /** Drops the row's custom set so it falls back to the batch pricing
   *  source. Named "clear", not "reset to template" — there is no template
   *  under Google Conversion. */
  onClearCustom?: (sku: string) => void;
  /** Reserved: currently always true, since custom applies under every
   *  source. Kept as a prop so a future surface can hide the trigger
   *  without another condition leaking into activeCustomSkus. */
  customEnabled?: boolean;
}

/** Hotfix 19: tier-dropdown option format Q2.C —
 *  "{identifier} — {VN price} VND · {N} regions" when a VN entry exists,
 *  "{identifier} — {N} regions" otherwise. VN price is formatted with
 *  thousands separators (Manager reads "27,000" not "27000"). */
function formatTierLabel(c: PreviewTierCandidate): string {
  const regionPart = `${c.regionCount} regions`;
  if (c.vnPriceDecimal && c.vnCurrency) {
    const [whole] = c.vnPriceDecimal.split(".");
    const formatted = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${c.identifier} — ${formatted} ${c.vnCurrency} · ${regionPart}`;
  }
  return `${c.identifier} — ${regionPart}`;
}

export function PreviewTable({
  rows,
  onRowDecisionChange,
  tierSelections,
  onTierSelectionChange,
  customPriceCounts = {},
  activeCustomSkus,
  onOpenCustomDialog,
  onClearCustom,
  customEnabled = false,
}: Props) {
  // overflow-x-auto (not overflow-hidden) so the 8-column table stays
  // horizontally scrollable inside the max-w-5xl wizard — the rightmost
  // "Action" column was previously clipped and unreachable. min-w keeps
  // columns at natural width so a scrollbar appears instead of squashing.
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
      <table className="w-full min-w-[960px]">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2.5">#</th>
            <th className="px-3 py-2.5">SKU</th>
            <th className="px-3 py-2.5">Default title</th>
            {/* Hotfix 28 — header was hardcoded "Base (USD)" pre-Hotfix-14
                migration when every row had to be the app's default
                currency. The Monetization API supports per-row currency,
                so the header is now currency-agnostic and each row shows
                its parser-resolved currency in the cell. */}
            <th className="px-3 py-2.5 text-right">Base price</th>
            <th className="px-3 py-2.5">Tier</th>
            <th className="px-3 py-2.5">Locales</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const defaultTitle =
              row.listings.find((l) => l.locale === "en-US")?.title ??
              row.listings[0]?.title ??
              "—";
            const locales = row.listings.map((l) => l.locale).join(", ");
            const isAmbiguous = row.tierCandidates.length > 1;
            const selection = tierSelections[row.rowNumber];
            // Q3.C: yellow row background + warning icon for ambiguous rows.
            // Bolder amber tint when Manager cleared the selection (defensive
            // edge-case, see BulkImportWizard tierStatus.pending).
            const selectionMissing = isAmbiguous && !selection;
            // undefined = no custom set for this SKU; a number = its entry count.
            const customCount = customPriceCounts[row.sku];
            const customIsActive =
              customCount !== undefined && (activeCustomSkus?.has(row.sku) ?? false);
            // Trigger hidden once a set exists (the chip owns re-open) and
            // under Google Conversion (Q4 — custom doesn't apply there).
            const customTriggerVisible =
              customEnabled && customCount === undefined && Boolean(onOpenCustomDialog);
            const rowClass = customIsActive
              ? "bg-violet-50 hover:bg-violet-100 transition"
              : selectionMissing
                ? "bg-amber-100 hover:bg-amber-200 transition"
                : isAmbiguous
                  ? "bg-amber-50 hover:bg-amber-100 transition"
                  : "hover:bg-slate-50 transition";
            return (
              <tr key={row.rowNumber} className={rowClass}>
                <td className="px-3 py-2.5 text-xs text-slate-400 font-mono">
                  {row.rowNumber}
                </td>
                <td className="px-3 py-2.5 text-xs font-mono text-slate-900">
                  <span className="inline-flex items-center gap-1.5">
                    {isAmbiguous && (
                      <AlertTriangle
                        className={
                          selectionMissing
                            ? "h-3.5 w-3.5 text-amber-700"
                            : "h-3.5 w-3.5 text-amber-600"
                        }
                      />
                    )}
                    {row.sku}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-700 max-w-[180px] truncate">
                  {defaultTitle}
                </td>
                <td className="px-3 py-2.5 text-xs text-right font-mono text-slate-700">
                  <span>{row.basePriceDecimal}</span>
                  {row.baseCurrency && (
                    <span className="ml-1 text-[10px] text-slate-500">
                      {row.baseCurrency}
                    </span>
                  )}
                  {/* Cycle 43 — cross-currency resolution outcome inline.
                      For same-currency rows nothing extra is shown (current
                      behavior bit-for-bit). */}
                  {row.resolution?.kind === "cross_currency_resolved" && (
                    <div className="flex items-center justify-end gap-1 text-[10px] text-emerald-700 mt-0.5">
                      <ArrowRight className="h-3 w-3" />
                      <span className="font-semibold">
                        {row.resolution.appCurrencyPrice.priceDecimal}
                      </span>
                      <span>{row.resolution.appCurrencyPrice.currency}</span>
                    </div>
                  )}
                  {row.resolution?.kind === "cross_currency_needs_choice" && (
                    <div className="text-[10px] text-amber-700 mt-0.5">
                      → pick tier
                    </div>
                  )}
                  {row.resolution?.kind === "cross_currency_refused" && (
                    <div
                      className="flex items-center justify-end gap-1 text-[10px] text-red-700 mt-0.5"
                      title={row.resolution.reason}
                    >
                      <XCircle className="h-3 w-3" />
                      <span className="font-semibold uppercase tracking-wide">
                        Refused
                      </span>
                    </div>
                  )}
                  {/* Mirrors the cross_currency_resolved arrow above: the
                      file value stays visible, the marker says what will
                      actually be sent. */}
                  {customIsActive && (
                    <div className="flex items-center justify-end gap-1 text-[10px] text-violet-700 mt-0.5">
                      <ArrowRight className="h-3 w-3" />
                      <span className="font-semibold">custom</span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-xs">
                  {customCount !== undefined ? (
                    /* Custom is a SEPARATE ROW ATTRIBUTE — it replaces the
                       tier display but is never the <select>'s value. */
                    <CustomChip
                      sku={row.sku}
                      count={customCount}
                      active={customIsActive}
                      onOpen={onOpenCustomDialog}
                      onClear={onClearCustom}
                    />
                  ) : row.tierCandidates.length === 0 ? (
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500 italic">
                        Auto-converted from USD
                      </span>
                      {customTriggerVisible && (
                        <>
                          <span className="text-slate-300">·</span>
                          <CustomTriggerButton
                            sku={row.sku}
                            onOpen={onOpenCustomDialog}
                          />
                        </>
                      )}
                    </div>
                  ) : row.tierCandidates.length === 1 ? (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-slate-600 italic">
                        {row.tierCandidates[0].identifier}
                      </span>
                      {customTriggerVisible && (
                        <>
                          <span className="text-slate-300">·</span>
                          <CustomTriggerButton
                            sku={row.sku}
                            onOpen={onOpenCustomDialog}
                          />
                        </>
                      )}
                    </div>
                  ) : (
                    <div>
                      <select
                        value={selection ?? ""}
                        onChange={(e) => {
                          // Intercept the sentinel: open the dialog and
                          // leave the tier selection untouched. It must
                          // never become chosenTierIdentifier.
                          if (e.target.value === CUSTOM_OPTION) {
                            onOpenCustomDialog?.(row.sku);
                            return;
                          }
                          onTierSelectionChange(row.rowNumber, e.target.value);
                        }}
                        className={
                          "text-xs border rounded px-1.5 py-1 font-mono w-full max-w-[280px] " +
                          (selectionMissing
                            ? "border-2 border-amber-500 bg-amber-50"
                            : "border-amber-400 bg-white")
                        }
                      >
                        <option value="" disabled hidden>
                          — Select a tier —
                        </option>
                        {row.tierCandidates.map((c) => (
                          <option key={c.identifier} value={c.identifier}>
                            {formatTierLabel(c)}
                          </option>
                        ))}
                        {customTriggerVisible && (
                          <>
                            <option disabled>──────────</option>
                            <option value={CUSTOM_OPTION}>
                              Custom… — set prices per country
                            </option>
                          </>
                        )}
                      </select>
                      {selectionMissing && (
                        <p className="text-[10px] text-amber-700 mt-0.5 font-semibold">
                          Selection cleared — pick a tier.
                        </p>
                      )}
                      {!selectionMissing &&
                        selection &&
                        row.defaultTierSelection &&
                        selection !== row.defaultTierSelection && (
                          <p className="text-[10px] text-blue-700 mt-0.5">
                            Changed from default ({row.defaultTierSelection})
                          </p>
                        )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-[10px] text-slate-500 font-mono max-w-[160px] truncate">
                  {locales || "—"}
                </td>
                <td className="px-3 py-2.5">
                  {row.exists ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                      <AlertTriangle className="h-3 w-3" />
                      Exists
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                      <Check className="h-3 w-3" />
                      New
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {row.exists ? (
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input
                          type="radio"
                          name={`row-${row.rowNumber}`}
                          checked={row.decision === "overwrite"}
                          onChange={() => onRowDecisionChange(row.rowNumber, "overwrite")}
                          className="text-amber-600 focus:ring-amber-500"
                        />
                        <span className="text-amber-700">Overwrite</span>
                      </label>
                      <label className="flex items-center gap-1 text-xs cursor-pointer">
                        <input
                          type="radio"
                          name={`row-${row.rowNumber}`}
                          checked={row.decision === "skip"}
                          onChange={() => onRowDecisionChange(row.rowNumber, "skip")}
                          className="text-slate-600 focus:ring-slate-500"
                        />
                        <span className="text-slate-600">Skip</span>
                      </label>
                    </div>
                  ) : (
                    <span className="text-[11px] text-emerald-700">
                      Create
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Opens the dialog for a row that has no custom set yet. */
function CustomTriggerButton({
  sku,
  onOpen,
}: {
  sku: string;
  onOpen?: (sku: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen?.(sku)}
      className="text-violet-700 font-medium hover:underline"
    >
      Custom…
    </button>
  );
}

/**
 * Custom row indicator. Custom must NEVER be an opaque state: the chip
 * names the country count, "View / edit" re-opens the dialog with the
 * saved values, and "Reset" returns the row to its template.
 *
 * Inactive rendering covers exactly ONE case now: the row is set to Skip,
 * so nothing is sent for it. The set is kept, not discarded, so un-skipping
 * restores it without retyping. Switching the pricing source does NOT
 * deactivate a set any more — custom applies under all three sources.
 */
function CustomChip({
  sku,
  count,
  active,
  onOpen,
  onClear,
}: {
  sku: string;
  count: number;
  active: boolean;
  onOpen?: (sku: string) => void;
  onClear?: (sku: string) => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            active
              ? "inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-800"
              : "inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500"
          }
        >
          <Pencil className="h-3 w-3" />
          Custom · {count} {count === 1 ? "country" : "countries"}
        </span>
        <button
          type="button"
          onClick={() => onOpen?.(sku)}
          className="text-[11px] font-medium text-violet-700 hover:underline"
        >
          View / edit
        </button>
        <span className="text-slate-300">·</span>
        <button
          type="button"
          onClick={() => onClear?.(sku)}
          className="text-[11px] text-slate-500 hover:text-slate-700 hover:underline"
        >
          Clear
        </button>
      </div>
      {!active && (
        <p className="text-[10px] text-slate-500 mt-0.5">
          inactive — this row is set to Skip, so nothing is sent
        </p>
      )}
    </div>
  );
}
