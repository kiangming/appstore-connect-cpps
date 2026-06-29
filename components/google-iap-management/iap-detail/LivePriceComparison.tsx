"use client";

/**
 * Live-vs-stored per-territory price comparison panel (Google IAP detail).
 *
 * - "Price from tool" column renders immediately from the server-passed DB
 *   snapshot (iap_prices) — never gated on Google.
 * - "Price live on Google" column loads asynchronously from a display-only
 *   single-item fetch; a slow/failed call shows a spinner / retry in that
 *   column only and never breaks the page.
 * - Divergence (live ≠ tool, normalized by lib/price-comparison) is flagged
 *   amber, including territory-set mismatches in both directions.
 * - "Sync from Google" (light two-step confirm) replaces this item's stored
 *   prices with the live values; afterwards the two columns reconcile.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, AlertTriangle, Loader2, Check } from "lucide-react";

import {
  comparePrices,
  summarizeComparison,
  type RegionPrice,
} from "@/lib/google-iap-management/price-comparison";
import { regionNameFromCode } from "@/lib/google-iap-management/region-name";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";

interface Props {
  packageName: string;
  sku: string;
  /** DB-sourced prices (iap_prices) — rendered immediately. */
  toolPrices: RegionPrice[];
}

type LiveState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; prices: RegionPrice[] };

function fmt(price: { currency: string; price_micros: string } | null): string {
  if (!price) return "—";
  let dec: string;
  try {
    dec = microsToDecimal(price.price_micros, 2);
  } catch {
    dec = price.price_micros;
  }
  return `${price.currency} ${dec}`;
}

export function LivePriceComparison({ packageName, sku, toolPrices }: Props) {
  const router = useRouter();
  const [live, setLive] = useState<LiveState>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

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
        setLive({
          kind: "error",
          message: "error" in body ? body.error : `HTTP ${res.status}`,
        });
        return;
      }
      setLive({ kind: "loaded", prices: body.prices });
    } catch (err) {
      setLive({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
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
      // DB now equals the just-pulled live values; reflect both:
      setLive({ kind: "loaded", prices: body.prices });
      setConfirming(false);
      // Re-render the server page so the "tool" column picks up the new DB rows.
      router.refresh();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  const liveLoaded = live.kind === "loaded";
  const rows = liveLoaded ? comparePrices(toolPrices, live.prices) : [];
  const summary = liveLoaded ? summarizeComparison(rows) : null;

  return (
    <section
      className="mt-8 rounded-xl border border-slate-200 bg-white"
      aria-label="Live vs stored prices"
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            Per-country prices: tool vs live Google
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            &ldquo;Tool&rdquo; = last written by import / edit / refresh.
            &ldquo;Live&rdquo; = current on Google Play right now.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {summary && summary.diverged > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              {summary.diverged} divergent
            </span>
          )}
          {summary && summary.diverged === 0 && (
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
              <span className="text-slate-600">
                Replace the tool&apos;s stored prices with Google&apos;s live values?
              </span>
              <button
                type="button"
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex items-center gap-1 rounded-lg bg-[#0071E3] px-2.5 py-1.5 font-medium text-white transition hover:bg-[#0077ED] disabled:opacity-50"
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
      </header>

      {syncError && (
        <p className="px-4 pt-3 text-xs text-red-600">{syncError}</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2 font-medium">Country</th>
              <th className="px-4 py-2 font-medium">Price from tool</th>
              <th className="px-4 py-2 font-medium">
                Price live on Google
                {live.kind === "loading" && (
                  <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-slate-400" />
                )}
              </th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {/* Live still loading or failed → render tool column from props,
                live column shows the loading/error state. Tool column never
                blocked on Google. */}
            {!liveLoaded &&
              toolPrices.map((t) => (
                <tr key={t.region_code} className="border-b border-slate-50">
                  <td className="px-4 py-2 text-slate-700">
                    {regionNameFromCode(t.region_code)}{" "}
                    <span className="text-slate-400">({t.region_code})</span>
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-700">{fmt(t)}</td>
                  <td className="px-4 py-2 text-slate-400">
                    {live.kind === "loading" ? "Loading…" : "—"}
                  </td>
                  <td className="px-4 py-2 text-slate-400">—</td>
                </tr>
              ))}

            {live.kind === "error" && (
              <tr>
                <td colSpan={4} className="px-4 py-3">
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

            {liveLoaded &&
              rows.map((r) => {
                const diverged = r.status !== "match";
                return (
                  <tr
                    key={r.region_code}
                    className={`border-b border-slate-50 ${
                      diverged ? "bg-amber-50/60" : ""
                    }`}
                  >
                    <td className="px-4 py-2 text-slate-700">
                      {regionNameFromCode(r.region_code)}{" "}
                      <span className="text-slate-400">({r.region_code})</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-700">
                      {fmt(r.tool)}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-700">
                      {fmt(r.live)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                );
              })}

            {liveLoaded && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No per-country prices on either side.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusBadge({
  status,
}: {
  status: "match" | "diff" | "tool-only" | "live-only";
}) {
  if (status === "match") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <Check className="h-3 w-3" />
        Match
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
