"use client";

import type {
  MatrixCell,
  MatrixData,
  MatrixMarket,
} from "@/lib/google-iap-management/queries/template-matrix";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";
import { getCurrencyDecimals } from "@/lib/google-iap-management/google/currency-precision";

export interface MatrixTableProps {
  matrix: MatrixData;
  visibleMarkets: ReadonlyArray<MatrixMarket>;
  /** When true, render the ★ marker on diffed cells (Per-App view). */
  showDiff: boolean;
}

function formatPrice(priceMicros: string, currency: string): string {
  try {
    return microsToDecimal(priceMicros, getCurrencyDecimals(currency));
  } catch {
    return priceMicros;
  }
}

const STICKY_COL_BASE =
  "sticky left-0 bg-white border-r-2 border-slate-300 w-[180px] min-w-[180px] max-w-[180px]";
const STICKY_COL_SHADOW = { boxShadow: "3px 0 6px -3px rgba(15, 23, 42, 0.18)" };

function CellContent({ cell, showDiff }: { cell: MatrixCell; showDiff: boolean }) {
  const formatted = formatPrice(cell.priceMicros, cell.currency);
  const isDiff = showDiff && cell.isDiff === true;
  const defaultFormatted =
    cell.defaultPriceMicros && cell.defaultCurrency
      ? formatPrice(cell.defaultPriceMicros, cell.defaultCurrency)
      : null;
  return (
    <span
      className={`inline-flex items-center gap-1 ${isDiff ? "text-amber-700" : ""}`}
      title={
        isDiff && defaultFormatted
          ? `Default: ${defaultFormatted} ${cell.defaultCurrency ?? ""} → Per-App: ${formatted} ${cell.currency}`
          : undefined
      }
    >
      <span>{formatted}</span>
      {isDiff && <span className="text-amber-500">★</span>}
    </span>
  );
}

export function MatrixTable({ matrix, visibleMarkets, showDiff }: MatrixTableProps) {
  if (visibleMarkets.length === 0) {
    return (
      <div className="border border-slate-200 rounded-lg p-10 text-center bg-white">
        <p className="text-sm text-slate-600">No markets match the active filters.</p>
        <p className="text-xs text-slate-400 mt-1">
          Clear the search, currency, or continent filters to see entries.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
      <div className="overflow-auto" style={{ maxHeight: "min(72vh, 720px)" }}>
        <table className="border-separate border-spacing-0 w-max min-w-full">
          <thead>
            <tr>
              <th
                scope="col"
                className={`sticky top-0 z-30 bg-slate-50 border-b border-slate-200 px-3 py-2 text-left text-[11px] uppercase tracking-wider text-slate-500 ${STICKY_COL_BASE}`}
                style={STICKY_COL_SHADOW}
              >
                Tier
              </th>
              {visibleMarkets.map((m) => (
                <th
                  key={m.code}
                  scope="col"
                  className="sticky top-0 z-20 bg-slate-50 border-b border-slate-200 border-r border-slate-100 px-3 py-2 text-right text-xs font-medium text-slate-700 whitespace-nowrap"
                  style={{ minWidth: "150px" }}
                >
                  <div className="flex items-baseline justify-end gap-1.5">
                    <span>{m.name}</span>
                    <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                      {m.currency}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.tiers.map((tier) => (
              <tr key={tier} className="group hover:bg-slate-50 transition">
                <th
                  scope="row"
                  className={`border-b border-slate-200 px-3 py-2 text-left text-xs font-mono text-slate-900 group-hover:bg-slate-50 z-10 ${STICKY_COL_BASE}`}
                  style={STICKY_COL_SHADOW}
                >
                  {tier}
                </th>
                {visibleMarkets.map((m) => {
                  const cell = matrix.cells[`${tier}|${m.code}`];
                  if (!cell) {
                    return (
                      <td
                        key={m.code}
                        className="border-b border-slate-200 border-r border-slate-100 px-3 py-2 text-right text-xs text-slate-300 font-mono"
                      >
                        ·
                      </td>
                    );
                  }
                  return (
                    <td
                      key={m.code}
                      className="border-b border-slate-200 border-r border-slate-100 px-3 py-2 text-right text-xs font-mono text-slate-900"
                    >
                      <CellContent cell={cell} showDiff={showDiff} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
