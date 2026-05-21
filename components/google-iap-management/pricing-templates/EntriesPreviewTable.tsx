"use client";

import type { ParsedPricingEntry } from "@/lib/google-iap-management/parsers/pricing-template-parser";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";

interface Props {
  entries: ParsedPricingEntry[];
  totalEntryCount: number;
}

function tryDecimal(micros: string): string {
  try {
    return microsToDecimal(micros, 2);
  } catch {
    return micros;
  }
}

export function EntriesPreviewTable({ entries, totalEntryCount }: Props) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          Sample entries
        </h3>
        <p className="text-xs text-slate-500">
          Showing {entries.length} of {totalEntryCount}
        </p>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5">Tier</th>
              <th className="px-4 py-2.5">Region</th>
              <th className="px-4 py-2.5">Currency</th>
              <th className="px-4 py-2.5 text-right">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map((e, i) => (
              <tr key={i} className="hover:bg-slate-50 transition">
                <td className="px-4 py-2 text-xs font-mono text-slate-900">
                  {e.identifier}
                </td>
                <td className="px-4 py-2 text-xs font-mono text-slate-700">
                  {e.regionCode}
                </td>
                <td className="px-4 py-2 text-xs font-mono text-slate-600">
                  {e.currency}
                </td>
                <td className="px-4 py-2 text-xs text-right font-mono text-slate-900">
                  {tryDecimal(e.priceMicros)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
