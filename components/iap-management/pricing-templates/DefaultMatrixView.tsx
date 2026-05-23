"use client";

import { useMemo, useState } from "react";

import {
  APPLE_CONTINENTS,
  type Continent,
} from "@/lib/iap-management/apple/territory-continent";
import type { MatrixData } from "@/lib/iap-management/queries/template-matrix";
import {
  buildCsv,
  csvFilename,
  triggerCsvDownload,
} from "@/lib/iap-management/csv-export";

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
    () => new Set(APPLE_CONTINENTS),
  );

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

  function handleExportCsv() {
    const csv = buildCsv({
      matrix,
      filteredMarkets: visibleMarkets,
      includeDefaultDiff: false,
    });
    triggerCsvDownload(csvFilename({ scope: "default" }), csv);
  }

  return (
    <div>
      <MatrixBreadcrumb
        trail={[
          { label: "Settings", href: "/iap-management/settings" },
          {
            label: "Pricing Tiers",
            href: "/iap-management/settings/pricing-tiers",
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
            {matrix.markets.length} territories · {matrix.tiers.length} tiers
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
        onExportCsv={handleExportCsv}
      />

      <MatrixTable matrix={matrix} visibleMarkets={visibleMarkets} showDiff={false} />

      <p className="text-xs text-slate-400 mt-2 italic">
        ⬅ Scroll horizontally to see all {matrix.markets.length} territories ·
        empty cell (·) = no override for that tier-territory pair (Apple
        auto-equalisation fills).
      </p>
    </div>
  );
}
