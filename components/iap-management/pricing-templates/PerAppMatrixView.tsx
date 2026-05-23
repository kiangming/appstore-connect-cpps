"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";

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

export interface PerAppMatrixViewProps {
  matrix: MatrixData;
  appName: string;
  bundleId: string;
  uploadedAt: string | null;
  uploadedBy: string | null;
  /** True when a Default Template exists — drives whether the diff
   *  highlight checkbox is offered and whether the CSV export carries
   *  a default_customer_price column. */
  defaultTemplateExists: boolean;
}

export function PerAppMatrixView({
  matrix,
  appName,
  bundleId,
  uploadedAt,
  uploadedBy,
  defaultTemplateExists,
}: PerAppMatrixViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState<string>(CURRENCY_FILTER_ALL);
  const [continentToggle, setContinentToggle] = useState<Set<Continent>>(
    () => new Set(APPLE_CONTINENTS),
  );
  const [showDiff, setShowDiff] = useState(defaultTemplateExists);

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
      includeDefaultDiff: defaultTemplateExists,
    });
    triggerCsvDownload(csvFilename({ scope: "per-app", bundleId }), csv);
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
          {
            label: "Per-App Templates",
            href: "/iap-management/settings/pricing-tiers",
          },
          { label: appName },
        ]}
      />
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-1">
            Per-App Pricing Template — {appName}
          </h1>
          <p className="text-sm text-slate-500">
            <span className="font-mono">{bundleId}</span> · {matrix.markets.length}{" "}
            territories · {matrix.tiers.length} tiers
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
        <div className="flex items-center gap-3">
          {defaultTemplateExists && (
            <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showDiff}
                onChange={(e) => setShowDiff(e.target.checked)}
                className="rounded border-slate-300"
              />
              <span>
                Highlight differences from Default{" "}
                <span className="text-amber-500">★</span>
              </span>
            </label>
          )}
          <Link
            href="/iap-management/settings/pricing-tiers"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-600 border border-slate-300 hover:bg-slate-50 rounded-lg transition"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to list
          </Link>
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

      <MatrixTable matrix={matrix} visibleMarkets={visibleMarkets} showDiff={showDiff} />

      {defaultTemplateExists && showDiff && (
        <p className="text-xs text-slate-400 mt-2 italic">
          <span className="text-amber-500">★</span> = cell value differs from the
          Default Template at the same tier-territory position · hover the cell
          for the Default value.
        </p>
      )}
    </div>
  );
}
