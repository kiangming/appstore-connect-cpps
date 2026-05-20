"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  Plus,
  Upload,
  Package2,
  Search,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";
import { StatusDot, type StatusTone } from "@/components/ui/iap/StatusDot";

interface Props {
  packageName: string;
  appDisplayName: string | null;
  appLastSyncedAt: string | null;
  initialIaps: IapWithDefaultLocale[];
}

const PAGE_SIZE = 20;

function toneForStatus(status: string): StatusTone {
  if (status === "active") return "success";
  return "neutral";
}

function formatPrice(
  priceMicros: string | null,
  currency: string | null,
): string {
  if (!priceMicros || !currency) return "—";
  try {
    const decimal = microsToDecimal(priceMicros, 2);
    return `${decimal} ${currency}`;
  } catch {
    return "—";
  }
}

export function IapListClient({
  packageName,
  appDisplayName,
  appLastSyncedAt,
  initialIaps,
}: Props) {
  const router = useRouter();
  const iaps = initialIaps;
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return iaps;
    return iaps.filter((i) =>
      `${i.default_title ?? ""} ${i.sku}`.toLowerCase().includes(q),
    );
  }, [iaps, search]);

  const meta = computePageMeta(filtered.length, page, PAGE_SIZE);
  const slice = filtered.slice(meta.startIndex, meta.endIndex);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSummary(null);
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/refresh`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        synced?: number;
        failed?: number;
        total?: number;
        error?: string;
      };
      if (!res.ok) {
        setRefreshError(body.error ?? `Refresh failed (HTTP ${res.status}).`);
        return;
      }
      router.refresh();
      setRefreshSummary(
        `Synced ${body.synced ?? 0} of ${body.total ?? 0} IAPs${
          body.failed ? ` (${body.failed} failed)` : ""
        }.`,
      );
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <Package2 className="h-6 w-6 text-emerald-600" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-slate-900 truncate">
              {appDisplayName ?? packageName}
            </h1>
            <p className="text-xs text-slate-500 font-mono mt-0.5 truncate">
              {packageName}
            </p>
            {appLastSyncedAt && (
              <p className="text-[11px] text-slate-400 mt-0.5">
                Apps cache synced{" "}
                {new Date(appLastSyncedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href={`/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/new`}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
          >
            <Plus className="h-4 w-4" />
            New IAP
          </Link>
          <button
            disabled
            title="Bulk import coming in g1.i"
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-500 border border-slate-200 rounded-lg cursor-not-allowed opacity-60"
          >
            <Upload className="h-4 w-4" />
            Bulk import
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-emerald-200 text-emerald-700 hover:bg-emerald-50 rounded-lg transition disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {refreshError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{refreshError}</span>
        </div>
      )}
      {refreshSummary && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {refreshSummary}
        </div>
      )}

      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search by SKU or name…"
          className="w-full rounded-lg border border-slate-300 pl-10 pr-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
        />
      </div>

      {iaps.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <Package2 className="h-10 w-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
          <p className="text-sm font-medium text-slate-700 mb-1">
            No IAPs cached yet
          </p>
          <p className="text-xs text-slate-500 mb-4">
            Click &ldquo;Refresh&rdquo; to import from Google Play, or
            &ldquo;New IAP&rdquo; to create one.
          </p>
        </div>
      ) : slice.length === 0 ? (
        <p className="text-sm text-slate-400 italic text-center py-6">
          No IAPs match &ldquo;{search}&rdquo;.
        </p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">SKU</th>
                <th className="px-4 py-2.5 text-right">Price</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Last synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {slice.map((iap) => (
                <tr key={iap.id} className="hover:bg-slate-50 transition">
                  <td className="px-4 py-3">
                    <Link
                      href={`/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/${encodeURIComponent(iap.sku)}`}
                      className="text-sm font-medium text-slate-900 hover:text-emerald-700"
                    >
                      {iap.default_title ?? (
                        <span className="text-slate-400 italic">— no title —</span>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-slate-600">
                    {iap.sku}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-900 text-right">
                    {formatPrice(iap.default_price_micros, iap.default_currency)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusDot tone={toneForStatus(iap.status)} label={iap.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 capitalize">
                    {iap.purchase_type}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {iap.last_synced_at
                      ? new Date(iap.last_synced_at).toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > PAGE_SIZE && (
        <div className="mt-6 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Showing {meta.displayStart}-{meta.displayEnd} of {filtered.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={meta.page <= 1}
              className="p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-default transition"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-3 text-xs text-slate-600">
              Page {meta.page} of {meta.totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={meta.page >= meta.totalPages}
              className="p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-default transition"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
