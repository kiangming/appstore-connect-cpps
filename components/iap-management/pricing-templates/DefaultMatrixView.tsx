"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  APPLE_CONTINENTS,
  type Continent,
} from "@/lib/iap-management/apple/territory-continent";
import type { MatrixData } from "@/lib/iap-management/queries/template-matrix";
import { downloadMatrixExport } from "@/lib/iap-management/matrix-export-download";

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
  const [exporting, setExporting] = useState(false);

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
    const toastId = toast.loading("Building the .xlsx…");
    try {
      const error = await downloadMatrixExport({
        scope: "default",
        territories: visibleMarkets.map((m) => m.code),
        // ⚠ MÀN DEFAULT KHÔNG CÓ CÔNG TẮC "Highlight differences" — không có
        // template nào để so, và `MatrixTable` dưới đây nhận `showDiff={false}`
        // cứng. Gửi `false` là chép lại đúng thứ màn đang hiện, không phải một
        // mặc định tiện tay.
        showDiff: false,
      });
      if (error) toast.error(error, { id: toastId });
      else
        toast.success(
          `Exported ${matrix.tiers.length} tiers × ${visibleMarkets.length} territories.`,
          { id: toastId },
        );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.", {
        id: toastId,
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <MatrixBreadcrumb
        trail={[
          { label: "Settings", href: "/iap-management/settings" },
          {
            label: "Pricing Templates",
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
        onExport={handleExport}
        isExporting={exporting}
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
