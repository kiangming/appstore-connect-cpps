"use client";

import { Search, Download } from "lucide-react";

import { APPLE_CONTINENTS, type Continent } from "@/lib/iap-management/apple/territory-continent";

export interface MatrixFilterBarProps {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;

  currencyFilter: string;
  currenciesUsed: ReadonlyArray<string>;
  onCurrencyFilterChange: (value: string) => void;

  continentToggle: ReadonlySet<Continent>;
  continentCounts: Record<Continent, number>;
  onContinentToggle: (continent: Continent) => void;

  visibleMarketCount: number;
  totalMarketCount: number;

  onExportCsv: () => void;
}

export const CURRENCY_FILTER_ALL = "ALL";

export function MatrixFilterBar({
  searchQuery,
  onSearchQueryChange,
  currencyFilter,
  currenciesUsed,
  onCurrencyFilterChange,
  continentToggle,
  continentCounts,
  onContinentToggle,
  visibleMarketCount,
  totalMarketCount,
  onExportCsv,
}: MatrixFilterBarProps) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex-1 min-w-[220px] max-w-md relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="Search territory — country name or alpha-3 code"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500" htmlFor="currency-filter">
            Currency:
          </label>
          <select
            id="currency-filter"
            value={currencyFilter}
            onChange={(e) => onCurrencyFilterChange(e.target.value)}
            className="text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
          >
            <option value={CURRENCY_FILTER_ALL}>
              All currencies ({currenciesUsed.length})
            </option>
            {currenciesUsed.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onExportCsv}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-300 hover:bg-white rounded-lg transition"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>
        <div className="ml-auto text-xs text-slate-500">
          Showing{" "}
          <span className="font-semibold text-slate-900">{visibleMarketCount}</span>{" "}
          of {totalMarketCount} territories
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500">Continents:</span>
        {APPLE_CONTINENTS.map((continent) => {
          const on = continentToggle.has(continent);
          const count = continentCounts[continent];
          return (
            <button
              key={continent}
              type="button"
              onClick={() => onContinentToggle(continent)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs transition ${
                on
                  ? "bg-sky-50 border-sky-400 text-sky-700"
                  : "bg-white border-slate-300 text-slate-400 hover:text-slate-600"
              }`}
            >
              <span className="font-medium">{continent}</span>
              <span className={on ? "text-sky-600" : "text-slate-400"}>
                ({count})
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
