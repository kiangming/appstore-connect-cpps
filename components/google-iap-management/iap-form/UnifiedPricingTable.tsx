"use client";

/**
 * Unified per-country pricing table — Zone B of the redesigned IAP detail.
 *
 * ONE table that merges the old editable "Region overrides" block with the
 * read-only live-vs-Google comparison (formerly the separate
 * LivePriceComparison panel). Columns: Country · Price from tool (EDITABLE) ·
 * Price live on Google (READ-ONLY reference) · Status.
 *
 * EDIT SAFETY (the cardinal rule): the editable column mutates the SAME
 * `regionOverrides` array IapForm saves, via the existing index handlers
 * (onUpdateOverride/onRemoveOverride) plus onAddOverrideForRegion for
 * inherit/live-only rows. The live column is display-only and is NEVER part of
 * the save payload. Collapsing matched rows is presentation only — collapsed
 * regions remain in regionOverrides and still save.
 *
 * Live load is async + non-blocking (tool column renders instantly); a failed
 * fetch degrades to "couldn't load · retry"; per-item "Sync from Google"
 * (light confirm) reuses the sync-prices route → syncIapFromGoogle.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  AlertTriangle,
  Loader2,
  Check,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import {
  buildUnifiedPricingRows,
  summarizeUnifiedPricing,
  partitionPricingRows,
  type UnifiedPricingRow,
  type UnifiedStatus,
} from "@/lib/google-iap-management/unified-pricing";
import type { RegionPrice } from "@/lib/google-iap-management/price-comparison";
import type { RegionOverrideRow } from "@/lib/google-iap-management/form-state";
import { regionNameFromCode } from "@/lib/google-iap-management/region-name";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";

interface Props {
  packageName: string;
  sku: string;
  regionOverrides: RegionOverrideRow[];
  baseCurrency: string;
  basePriceDecimal: string;
  fieldErrors: Record<string, string>;
  onUpdateOverride: (index: number, updates: Partial<RegionOverrideRow>) => void;
  onRemoveOverride: (index: number) => void;
  onAddOverrideForRegion: (region: string, currency: string) => void;
}

type LiveState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; prices: RegionPrice[] };

function fmtLive(price: { currency: string; price_micros: string } | null): string {
  if (!price) return "—";
  try {
    return `${price.currency} ${microsToDecimal(price.price_micros, 2)}`;
  } catch {
    return `${price.currency} ${price.price_micros}`;
  }
}

export function UnifiedPricingTable({
  packageName,
  sku,
  regionOverrides,
  baseCurrency,
  basePriceDecimal,
  fieldErrors,
  onUpdateOverride,
  onRemoveOverride,
  onAddOverrideForRegion,
}: Props) {
  const router = useRouter();
  const [live, setLive] = useState<LiveState>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showCollapsed, setShowCollapsed] = useState(false);

  const base = `/api/google-iap-management/apps/${encodeURIComponent(
    packageName,
  )}/iaps/${encodeURIComponent(sku)}`;

  const loadLive = useCallback(async () => {
    setLive({ kind: "loading" });
    try {
      const res = await fetch(`${base}/live-prices`);
      const body = (await res.json()) as
        | { ok: true; prices: RegionPrice[] }
        | { error: string };
      if (!res.ok || !("ok" in body)) {
        setLive({ kind: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
        return;
      }
      setLive({ kind: "loaded", prices: body.prices });
    } catch (err) {
      setLive({ kind: "error", message: err instanceof Error ? err.message : "Network error" });
    }
  }, [base]);

  useEffect(() => {
    void loadLive();
  }, [loadLive]);

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch(`${base}/sync-prices`, { method: "POST" });
      const body = (await res.json()) as
        | { ok: true; prices: RegionPrice[] }
        | { error: string };
      if (!res.ok || !("ok" in body)) {
        setSyncError("error" in body ? body.error : `Sync failed (HTTP ${res.status})`);
        return;
      }
      setLive({ kind: "loaded", prices: body.prices });
      setConfirming(false);
      // Re-render the server page so the edit form reloads regionOverrides
      // from the freshly-synced DB (tool column now equals live).
      router.refresh();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  const rows = useMemo(
    () =>
      buildUnifiedPricingRows({
        regionOverrides,
        livePrices: live.kind === "loaded" ? live.prices : [],
        baseCurrency,
        basePriceDecimal,
      }),
    [regionOverrides, live, baseCurrency, basePriceDecimal],
  );
  const summary = summarizeUnifiedPricing(rows);
  const { visible, collapsed } = partitionPricingRows(rows);
  const liveLoaded = live.kind === "loaded";

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">Per-country pricing</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            <span className="font-semibold text-slate-700">Tool</span> is editable (your overrides).{" "}
            <span className="font-semibold text-slate-700">Live on Google</span> is read-only — the
            current store value right now.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {liveLoaded && summary.diverged > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              {summary.diverged} divergent
            </span>
          )}
          {liveLoaded && summary.diverged === 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <Check className="h-3 w-3" />
              In sync
            </span>
          )}
          {!confirming ? (
            <button
              type="button"
              onClick={() => {
                setSyncError(null);
                setConfirming(true);
              }}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-200 disabled:opacity-50"
              title="Replace the tool's stored prices for this item with Google's live values"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              Sync from Google
            </button>
          ) : (
            <span className="inline-flex items-center gap-2 text-xs">
              <span className="text-slate-600">Replace the tool&apos;s stored prices with Google&apos;s live values?</span>
              <button
                type="button"
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={syncing}
                className="rounded-lg px-2.5 py-1.5 font-medium text-slate-500 transition hover:text-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>

      {syncError && <p className="px-5 pt-3 text-xs text-red-600">{syncError}</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
            <th className="px-5 py-2 font-medium">Country</th>
            <th className="px-5 py-2 font-medium">Price from tool · editable</th>
            <th className="px-5 py-2 font-medium">
              Price live on Google · reference
              {live.kind === "loading" && (
                <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-slate-400" />
              )}
            </th>
            <th className="px-5 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {live.kind === "error" && (
            <tr>
              <td colSpan={4} className="px-5 py-3">
                <div className="flex items-center gap-2 text-xs text-amber-700">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  <span>Couldn&apos;t load live prices: {live.message}</span>
                  <button
                    type="button"
                    onClick={() => void loadLive()}
                    className="rounded border border-amber-300 px-2 py-0.5 font-medium text-amber-800 transition hover:bg-amber-100"
                  >
                    Retry
                  </button>
                </div>
              </td>
            </tr>
          )}

          {visible.map((r) => (
            <PricingRow
              key={r.region_code}
              row={r}
              fieldError={
                r.override ? fieldErrors[`override_${r.override.index}`] : undefined
              }
              onUpdateOverride={onUpdateOverride}
              onRemoveOverride={onRemoveOverride}
              onAddOverrideForRegion={onAddOverrideForRegion}
            />
          ))}

          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-5 py-6 text-center text-slate-400">
                {live.kind === "loading"
                  ? "Loading live prices…"
                  : "No per-country prices on either side. Google auto-equalizes the base price."}
              </td>
            </tr>
          )}

          {collapsed.length > 0 && (
            <tr>
              <td colSpan={4} className="px-5 py-2.5 text-center">
                <button
                  type="button"
                  onClick={() => setShowCollapsed((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
                >
                  {showCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {showCollapsed ? "Hide" : "Show"} {collapsed.length} auto-equalized
                  {" "}territories that match live Google
                </button>
              </td>
            </tr>
          )}

          {showCollapsed &&
            collapsed.map((r) => (
              <PricingRow
                key={r.region_code}
                row={r}
                fieldError={
                  r.override ? fieldErrors[`override_${r.override.index}`] : undefined
                }
                onUpdateOverride={onUpdateOverride}
                onRemoveOverride={onRemoveOverride}
                onAddOverrideForRegion={onAddOverrideForRegion}
              />
            ))}
        </tbody>
      </table>

      <div className="px-5 py-2.5 border-t border-slate-100 text-[11px] text-slate-400">
        {liveLoaded
          ? `${rows.length} territories · ${rows.length - summary.diverged} matching live · ${summary.diverged} flagged`
          : "Editable tool prices shown; live comparison loading…"}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: UnifiedStatus }) {
  if (status === "match" || status === "auto-eq") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <Check className="h-3 w-3" />
        {status === "auto-eq" ? "Match (auto-eq)" : "Match"}
      </span>
    );
  }
  const label =
    status === "diff"
      ? "Differs"
      : status === "tool-only"
        ? "In tool, not on Google"
        : "On Google, not in tool";
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
      <AlertTriangle className="h-3 w-3" />
      {label}
    </span>
  );
}

function PricingRow({
  row,
  fieldError,
  onUpdateOverride,
  onRemoveOverride,
  onAddOverrideForRegion,
}: {
  row: UnifiedPricingRow;
  fieldError?: string;
  onUpdateOverride: (index: number, updates: Partial<RegionOverrideRow>) => void;
  onRemoveOverride: (index: number) => void;
  onAddOverrideForRegion: (region: string, currency: string) => void;
}) {
  const diverged = row.status !== "match" && row.status !== "auto-eq";
  return (
    <tr className={diverged ? "bg-amber-50/50" : ""}>
      <td className="px-5 py-2.5 text-slate-700 align-top">
        {regionNameFromCode(row.region_code)}{" "}
        <span className="text-slate-400 font-mono text-xs">({row.region_code})</span>
      </td>
      <td className="px-5 py-2.5 align-top">
        {row.override ? (
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 ${
                fieldError ? "border-red-400" : "border-slate-300"
              }`}
            >
              <span className="text-[11px] font-semibold text-slate-500">
                {row.override.currency.toUpperCase()}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={row.override.priceDecimal}
                placeholder="add override"
                onChange={(e) =>
                  onUpdateOverride(row.override!.index, { priceDecimal: e.target.value })
                }
                className="w-20 border-0 bg-transparent p-0 text-xs font-mono text-slate-900 placeholder:text-slate-300 focus:outline-none"
                aria-label={`Tool price for ${row.region_code}`}
              />
            </span>
            <button
              type="button"
              onClick={() => onRemoveOverride(row.override!.index)}
              className="text-slate-300 hover:text-red-500 transition"
              aria-label={`Remove override for ${row.region_code}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 italic px-2 py-1 rounded-md border border-dashed border-slate-300">
            inherits base ·{" "}
            <button
              type="button"
              onClick={() =>
                onAddOverrideForRegion(row.region_code, row.live?.currency ?? "USD")
              }
              className="not-italic font-medium text-emerald-700 hover:underline"
            >
              override
            </button>
          </span>
        )}
        {fieldError && <p className="mt-1 text-[11px] text-red-500">{fieldError}</p>}
      </td>
      <td className="px-5 py-2.5 align-top font-mono text-slate-600">
        {fmtLive(row.live)}
        {row.live && (
          <span className="ml-1.5 text-[9px] uppercase tracking-wide text-slate-300 border border-slate-200 rounded px-1 py-0.5">
            live
          </span>
        )}
      </td>
      <td className="px-5 py-2.5 align-top">
        <StatusBadge status={row.status} />
      </td>
    </tr>
  );
}
