"use client";

import { Search, Download, FilePen, Upload } from "lucide-react";

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

  onExport: () => void;
  /** True while the server is building the workbook — chặn bấm hai lần. */
  isExporting?: boolean;

  /** PA2.3 (Manager Q-B) — "Export for editing": the WHOLE template, whatever
   *  the filters show, as a file that can be imported back. */
  onExportForEditing: () => void;
  isExportingForEditing?: boolean;
  /** PA2.3 (Q-E) — "Import edited file", next to the exports. Absent ⇒ no
   *  button (a member on the Default matrix: the import is admin-only, the
   *  same gate as uploading a Default template). */
  onImportEdited?: () => void;
  /** From choosing a file until its dialog closes (a write included) — one
   *  file at a time. */
  isImporting?: boolean;
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
  onExport,
  isExporting = false,
  onExportForEditing,
  isExportingForEditing = false,
  onImportEdited,
  isImporting = false,
}: MatrixFilterBarProps) {
  // ⚠ 0 nước ⇒ không có gì để xuất. Màn ở trạng thái đó đang hiện "No
  // territories match the active filters" (MatrixTable), và route từ chối
  // `territories: []` bằng 400 — nút vô hiệu ở đây là để hai đầu nói cùng một
  // chuyện, không phải để giấu lỗi 400.
  const nothingToExport = visibleMarketCount === 0;
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
          onClick={onExport}
          disabled={nothingToExport || isExporting}
          title={
            nothingToExport
              ? "No territories match the active filters — nothing to export."
              : undefined
          }
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-300 hover:bg-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <Download className="h-4 w-4" />
          {isExporting ? "Exporting…" : "Export XLSX"}
        </button>
        {/* ⚠ NOT disabled by the filters: "for editing" is the whole template,
            never the filtered view (a filtered file would DELETE the hidden
            territories' overrides on import — Q-B). */}
        <button
          type="button"
          onClick={onExportForEditing}
          disabled={isExportingForEditing}
          title="Every territory of the template, in a file you can edit and import back."
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-300 hover:bg-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <FilePen className="h-4 w-4" />
          {isExportingForEditing ? "Exporting…" : "Export for editing"}
        </button>
        {onImportEdited && (
          <button
            type="button"
            onClick={onImportEdited}
            disabled={isImporting}
            title='Import a file made with "Export for editing" — the template becomes exactly the file.'
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-[#0071E3] hover:bg-[#0077ED] rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Upload className="h-4 w-4" />
            {isImporting ? "Importing…" : "Import edited file"}
          </button>
        )}
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
