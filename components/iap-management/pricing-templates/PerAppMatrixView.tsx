"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

import {
  APPLE_CONTINENTS,
  type Continent,
} from "@/lib/iap-management/apple/territory-continent";
import type { MatrixData } from "@/lib/iap-management/queries/template-matrix";
import {
  downloadMatrixExport,
  downloadMatrixExportForEditing,
  editExportSuccessMessage,
} from "@/lib/iap-management/matrix-export-download";

import { MatrixBreadcrumb } from "./MatrixBreadcrumb";
import {
  MatrixFilterBar,
  CURRENCY_FILTER_ALL,
} from "./MatrixFilterBar";
import { MatrixTable } from "./MatrixTable";
import { MatrixImport } from "./MatrixImport";

export interface PerAppMatrixViewProps {
  matrix: MatrixData;
  /** UUID nội bộ của app (iap_mgmt.apps.id) — route cần nó để biết đọc
   *  template Per-App nào. ⚠ KHÔNG phải Apple numeric id, và KHÔNG phải
   *  bundleId: `fetchPerAppMatrix` khoá theo `scope_app_id`. */
  appId: string;
  appName: string;
  bundleId: string;
  uploadedAt: string | null;
  uploadedBy: string | null;
  /** True when a Default Template exists — quyết định có HIỆN checkbox
   *  "Highlight differences" hay không, và giá trị KHỞI TẠO của nó.
   *  ⚠ KHÔNG được dùng làm thứ gửi lên export: cái file bám là `showDiff`,
   *  tức trạng thái công tắc lúc bấm nút (F1). */
  defaultTemplateExists: boolean;
}

export function PerAppMatrixView({
  matrix,
  appId,
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
  const [exporting, setExporting] = useState(false);
  const [exportingForEditing, setExportingForEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

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
        scope: "per-app",
        appId,
        territories: visibleMarkets.map((m) => m.code),
        // ⚠ F1 — CÔNG TẮC, KHÔNG PHẢI `defaultTemplateExists`. Đường CSV cũ
        // gửi `includeDefaultDiff: defaultTemplateExists`, nên tắt highlight
        // thì màn sạch mà file vẫn có cột diff. File là ảnh chụp của MÀN, và
        // thứ màn đang hiện do `showDiff` quyết (MatrixTable nhận đúng biến
        // này ở dưới).
        showDiff,
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

  async function handleExportForEditing() {
    setExportingForEditing(true);
    const toastId = toast.loading("Building the file for editing…");
    try {
      // ⚠ Not the visible territories: the file for editing is the whole
      // template (Q-B). The server reads it; nothing from this screen decides it.
      const res = await downloadMatrixExportForEditing({ scope: "per-app", appId });
      if (!res.ok) toast.error(res.error, { id: toastId });
      else toast.success(editExportSuccessMessage(res), { id: toastId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.", { id: toastId });
    } finally {
      setExportingForEditing(false);
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
        onExport={handleExport}
        isExporting={exporting}
        onExportForEditing={handleExportForEditing}
        isExportingForEditing={exportingForEditing}
        // Per-App import is open to members — the same gate as uploading a
        // Per-App template (Hotfix 11).
        onImportEdited={() => importInput.current?.click()}
        isImporting={importing}
      />
      <MatrixImport
        target={{ kind: "APP", appId }}
        label={`Per-App template · ${appName} (${bundleId})`}
        isPerApp
        tierNames={matrix.tiers}
        inputRef={importInput}
        onBusyChange={setImporting}
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
