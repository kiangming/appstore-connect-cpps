"use client";

import { Check, AlertTriangle } from "lucide-react";

import type { PreviewRow } from "./BulkImportWizard";

interface Props {
  rows: PreviewRow[];
  onRowDecisionChange: (rowNumber: number, decision: "overwrite" | "skip") => void;
}

export function PreviewTable({ rows, onRowDecisionChange }: Props) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <table className="w-full">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2.5">#</th>
            <th className="px-3 py-2.5">SKU</th>
            <th className="px-3 py-2.5">Default title</th>
            <th className="px-3 py-2.5 text-right">Base (USD)</th>
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
            return (
              <tr key={row.rowNumber} className="hover:bg-slate-50 transition">
                <td className="px-3 py-2.5 text-xs text-slate-400 font-mono">
                  {row.rowNumber}
                </td>
                <td className="px-3 py-2.5 text-xs font-mono text-slate-900">
                  {row.sku}
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-700 max-w-[180px] truncate">
                  {defaultTitle}
                </td>
                <td className="px-3 py-2.5 text-xs text-right font-mono text-slate-700">
                  {row.basePriceDecimal}
                </td>
                <td className="px-3 py-2.5 text-[10px] text-slate-500 font-mono max-w-[200px] truncate">
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
