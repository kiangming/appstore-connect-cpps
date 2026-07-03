"use client";

import { Check, AlertTriangle, ArrowRight, XCircle } from "lucide-react";

import type { PreviewRow, PreviewTierCandidate } from "./BulkImportWizard";

interface Props {
  rows: PreviewRow[];
  onRowDecisionChange: (rowNumber: number, decision: "overwrite" | "skip") => void;
  // Hotfix 19 — tier-selection plumbing.
  tierSelections: Record<number, string>;
  onTierSelectionChange: (rowNumber: number, identifier: string) => void;
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
            const rowClass = selectionMissing
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
                </td>
                <td className="px-3 py-2.5 text-xs">
                  {row.tierCandidates.length === 0 ? (
                    <span className="text-slate-500 italic">
                      Auto-converted from USD
                    </span>
                  ) : row.tierCandidates.length === 1 ? (
                    <span className="font-mono text-slate-600 italic">
                      {row.tierCandidates[0].identifier}
                    </span>
                  ) : (
                    <div>
                      <select
                        value={selection ?? ""}
                        onChange={(e) =>
                          onTierSelectionChange(row.rowNumber, e.target.value)
                        }
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
