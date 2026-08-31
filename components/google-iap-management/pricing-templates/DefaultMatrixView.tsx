"use client";

import { useMemo, useState } from "react";

import { CONTINENTS, type Continent } from "@/lib/google-iap-management/region-continent";
import type { MatrixData } from "@/lib/google-iap-management/queries/template-matrix";
import {
  describeMatrixExportError,
  downloadMatrixExport,
  truncatedCellsNotice,
} from "@/lib/google-iap-management/matrix-export-download";

import { MatrixBreadcrumb } from "./MatrixBreadcrumb";
import {
  MatrixFilterBar,
  CURRENCY_FILTER_ALL,
} from "./MatrixFilterBar";
import { MatrixTable } from "./MatrixTable";

export interface DefaultMatrixViewProps {
  matrix: MatrixData;
  uploadedAt: string | null;
  uploadedBy: string | null;
}

export function DefaultMatrixView({
  matrix,
  uploadedAt,
  uploadedBy,
}: DefaultMatrixViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState<string>(CURRENCY_FILTER_ALL);
  const [continentToggle, setContinentToggle] = useState<Set<Continent>>(
    () => new Set(CONTINENTS),
  );
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const visibleMarkets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return matrix.markets.filter((m) => {
      if (q) {
        const matchesName = m.name.toLowerCase().includes(q);
        const matchesCode = m.code.toLowerCase().includes(q);
        if (!matchesName && !matchesCode) return false;
      }
      if (currencyFilter !== CURRENCY_FILTER_ALL && m.currency !== currencyFilter) {
        return false;
      }
      if (m.continent && !continentToggle.has(m.continent)) return false;
      return true;
    });
  }, [matrix.markets, searchQuery, currencyFilter, continentToggle]);

  function toggleContinent(c: Continent) {
    setContinentToggle((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const result = await downloadMatrixExport({
        scope: "default",
        regionCodes: visibleMarkets.map((m) => m.code),
        // ⚠ `false` LÀ CỐ Ý, KHÔNG PHẢI QUÊN. Màn Default không có công tắc
        // "Highlight differences" — nó truyền `showDiff={false}` cứng xuống
        // MatrixTable (xem dòng ~150 của chính file này), vì Default không có
        // gì để so. File phải nói đúng thứ màn nói, nên nó cũng là `false`.
        showDiff: false,
      });
      setExportNotice(truncatedCellsNotice(result.truncatedCells));
    } catch (err) {
      setExportError(describeMatrixExportError(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <MatrixBreadcrumb
        trail={[
          { label: "Settings", href: "/google-iap-management" },
          {
            label: "Pricing Templates",
            href: "/google-iap-management/settings/pricing-templates",
          },
          { label: "Default Template" },
        ]}
      />
      <div className="flex items-start justify-between mb-4 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-1">
            Default Pricing Template
          </h1>
          <p className="text-sm text-slate-500">
            {matrix.markets.length} markets · {matrix.tiers.length} tiers
            {uploadedBy && (
              <>
                {" "}
                · uploaded by{" "}
                <span className="font-mono text-slate-700">{uploadedBy}</span>
              </>
            )}
            {uploadedAt && (
              <>
                {" "}
                ·{" "}
                <span className="text-slate-700">
                  {new Date(uploadedAt).toLocaleDateString()}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      <MatrixFilterBar
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        currencyFilter={currencyFilter}
        currenciesUsed={matrix.currenciesUsed}
        onCurrencyFilterChange={setCurrencyFilter}
        continentToggle={continentToggle}
        continentCounts={matrix.continentCounts}
        onContinentToggle={toggleContinent}
        visibleMarketCount={visibleMarkets.length}
        totalMarketCount={matrix.markets.length}
        onExport={() => void handleExport()}
        exporting={exporting}
      />

      {exportError && (
        <p
          role="alert"
          className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3"
        >
          {exportError}
        </p>
      )}
      {exportNotice && (
        <p
          role="status"
          className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3"
        >
          {exportNotice}
        </p>
      )}

      <MatrixTable matrix={matrix} visibleMarkets={visibleMarkets} showDiff={false} />

      <p className="text-xs text-slate-400 mt-2 italic">
        ⬅ Scroll horizontally to see all {matrix.markets.length} markets · empty cell
        (·) = no override for that tier-market pair (Google auto-equalisation fills).
      </p>
    </div>
  );
}
