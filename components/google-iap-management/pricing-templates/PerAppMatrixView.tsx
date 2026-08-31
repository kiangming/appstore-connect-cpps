"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";

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

export interface PerAppMatrixViewProps {
  matrix: MatrixData;
  /** UUID của app trong `google_iap_mgmt.apps`. Route export cần nó để tìm
   *  đúng template per-app, và để kiểm app có thuộc account đang active. */
  appId: string;
  packageName: string;
  appDisplayName: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  /** True when a Default Template exists — drives whether the diff
   *  highlight checkbox is offered and whether the CSV export carries a
   *  `default_price` column. */
  defaultTemplateExists: boolean;
}

export function PerAppMatrixView({
  matrix,
  appId,
  packageName,
  appDisplayName,
  uploadedAt,
  uploadedBy,
  defaultTemplateExists,
}: PerAppMatrixViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState<string>(CURRENCY_FILTER_ALL);
  const [continentToggle, setContinentToggle] = useState<Set<Continent>>(
    () => new Set(CONTINENTS),
  );
  const [showDiff, setShowDiff] = useState(defaultTemplateExists);
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
        scope: "per-app",
        appId,
        regionCodes: visibleMarkets.map((m) => m.code),
        // ⚠ F1 — GỬI CÔNG TẮC, KHÔNG GỬI `defaultTemplateExists`.
        // Đây chính là chỗ đường CSV cũ nói khác màn: nó truyền
        // `includeDefaultDiff: defaultTemplateExists`, nên bỏ tick công tắc
        // thì màn sạch ★ mà file vẫn mang cột diff. Hai biến này KHÁC NHAU:
        // `defaultTemplateExists` chỉ nói "có Default để mà so", `showDiff`
        // nói "người dùng có đang muốn thấy so sánh hay không".
        showDiff,
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
          {
            label: "Per-App Templates",
            href: "/google-iap-management/settings/pricing-templates",
          },
          { label: appDisplayName ?? packageName },
        ]}
      />
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-1">
            Per-App Pricing Template — {appDisplayName ?? packageName}
          </h1>
          <p className="text-sm text-slate-500">
            <span className="font-mono">{packageName}</span> · {matrix.markets.length}{" "}
            markets · {matrix.tiers.length} tiers
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
            href="/google-iap-management/settings/pricing-templates"
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

      <MatrixTable matrix={matrix} visibleMarkets={visibleMarkets} showDiff={showDiff} />

      {defaultTemplateExists && showDiff && (
        <p className="text-xs text-slate-400 mt-2 italic">
          <span className="text-amber-500">★</span> = cell value differs from the
          Default Template at the same tier-market position · hover the cell for the
          Default value.
        </p>
      )}
    </div>
  );
}
