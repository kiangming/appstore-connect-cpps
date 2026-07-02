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
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Check,
  Minus,
  Trash2,
} from "lucide-react";

import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";
import { StatusDot, type StatusTone } from "@/components/ui/iap/StatusDot";
import {
  fetchWithTimeout,
  describeRefreshError,
  REFRESH_TIMEOUT_MS,
} from "@/lib/google-iap-management/client/refresh-fetch";
import {
  BulkStatusModal,
  type BulkStatusMode,
} from "./BulkStatusModal";

interface Props {
  packageName: string;
  appDisplayName: string | null;
  appLastSyncedAt: string | null;
  initialIaps: IapWithDefaultLocale[];
  /** True when the server-side list read threw (vs. a genuinely empty app).
   *  Drives an error state instead of the misleading "No IAPs" empty state. */
  loadError?: boolean;
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

function formatDetected(ts: string | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function IapListClient({
  packageName,
  appDisplayName,
  appLastSyncedAt,
  initialIaps,
  loadError = false,
}: Props) {
  const router = useRouter();
  const iaps = initialIaps;
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSummary, setRefreshSummary] = useState<string | null>(null);
  const [bulkMode, setBulkMode] = useState<BulkStatusMode | null>(null);

  // Soft-delete: split present-on-Google (live) from flagged deleted-on-Google.
  const liveItems = useMemo(
    () => iaps.filter((i) => !i.deleted_on_google_at),
    [iaps],
  );
  const flaggedItems = useMemo(
    () => iaps.filter((i) => i.deleted_on_google_at),
    [iaps],
  );

  // Flagged-section UI state.
  const [showFlagged, setShowFlagged] = useState(true);
  const [confirmingSku, setConfirmingSku] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [ackMessage, setAckMessage] = useState<string | null>(null);

  // Main list = LIVE items only (flagged shown separately, excluded from the
  // main pagination count).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return liveItems;
    return liveItems.filter((i) =>
      `${i.default_title ?? ""} ${i.sku}`.toLowerCase().includes(q),
    );
  }, [liveItems, search]);

  const meta = computePageMeta(filtered.length, page, PAGE_SIZE);
  const slice = filtered.slice(meta.startIndex, meta.endIndex);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSummary(null);
    try {
      const res = await fetchWithTimeout(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/refresh`,
        { method: "POST" },
        REFRESH_TIMEOUT_MS,
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        synced?: number;
        failed?: number;
        total?: number;
        flagged?: number;
        unflagged?: number;
        error?: string;
      };
      if (!res.ok) {
        setRefreshError(body.error ?? `Refresh failed (HTTP ${res.status}).`);
        return;
      }
      router.refresh();
      const flaggedNote =
        body.flagged || body.unflagged
          ? ` · ${body.flagged ?? 0} newly flagged, ${body.unflagged ?? 0} restored`
          : "";
      setRefreshSummary(
        `Synced ${body.synced ?? 0} of ${body.total ?? 0} IAPs${
          body.failed ? ` (${body.failed} failed)` : ""
        }${flaggedNote}.`,
      );
    } catch (err) {
      setRefreshError(describeRefreshError(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleAcknowledgeRemove(skus: string[]) {
    if (skus.length === 0) return;
    setRemoving(true);
    setAckMessage(null);
    try {
      const res = await fetchWithTimeout(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/acknowledge-remove`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skus }),
        },
        REFRESH_TIMEOUT_MS,
      );
      const body = (await res.json().catch(() => ({}))) as {
        removed?: number;
        error?: string;
      };
      if (!res.ok) {
        setAckMessage(body.error ?? `Remove failed (HTTP ${res.status}).`);
        return;
      }
      router.refresh();
      setAckMessage(`Removed ${body.removed ?? 0} deleted-on-Google item(s).`);
    } catch (err) {
      setAckMessage(describeRefreshError(err));
    } finally {
      setRemoving(false);
      setConfirmingSku(null);
      setBulkConfirmOpen(false);
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
            {/* Count chips: on-Google vs not-on-Google */}
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                {liveItems.length} on Google Play
              </span>
              {flaggedItems.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                  {flaggedItems.length} not on Google
                </span>
              )}
              {appLastSyncedAt && (
                <span className="text-[11px] text-slate-400">
                  synced {new Date(appLastSyncedAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setBulkMode("activate")}
            disabled={liveItems.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 border border-emerald-300 hover:bg-emerald-50 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check className="h-4 w-4" />
            Bulk Activate
          </button>
          <button
            type="button"
            onClick={() => setBulkMode("deactivate")}
            disabled={liveItems.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-700 border border-red-300 hover:bg-red-50 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Minus className="h-4 w-4" />
            Bulk Deactivate
          </button>
          <div className="w-px h-6 bg-slate-200 mx-0.5" aria-hidden="true" />
          <Link
            href={`/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/new`}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
          >
            <Plus className="h-4 w-4" />
            New IAP
          </Link>
          <Link
            href={`/google-iap-management/apps/${encodeURIComponent(packageName)}/bulk-import`}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg transition"
          >
            <Upload className="h-4 w-4" />
            Bulk import
          </Link>
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

      {/* ── WARNING BANNER (amber, not error-red): flagged items exist ── */}
      {flaggedItems.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-800">
              {flaggedItems.length} item
              {flaggedItems.length === 1 ? "" : "s"} exist in the tool&rsquo;s
              cache but are no longer on Google Play
            </p>
            <p className="text-[13px] text-amber-700/90 mt-0.5">
              Someone may have deleted or renamed them on the Play Console.
              They&rsquo;re still shown below (flagged) so nothing disappears
              silently — review and remove the ones that are genuinely gone.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowFlagged(true);
              document
                .getElementById("flagged-section")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-300 text-amber-800 hover:bg-amber-100 transition whitespace-nowrap"
          >
            Review flagged ↓
          </button>
        </div>
      )}

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
      {ackMessage && (
        <div className="mb-4 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          {ackMessage}
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

      {loadError ? (
        <div className="bg-white border border-red-200 rounded-xl p-10 text-center">
          <AlertCircle className="h-10 w-10 text-red-300 mx-auto mb-3" strokeWidth={1.5} />
          <p className="text-sm font-medium text-slate-700 mb-1">
            Failed to load IAPs
          </p>
          <p className="text-xs text-slate-500 mb-4">
            The list couldn&rsquo;t be loaded. Reload the page or click
            &ldquo;Refresh&rdquo; to try again.
          </p>
        </div>
      ) : iaps.length === 0 ? (
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
      ) : (
        <>
          {/* ── MAIN LIST (live items) ── */}
          {slice.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-6">
              {search
                ? `No items match “${search}”.`
                : "No items are currently on Google Play."}
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
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-slate-500">
                Showing {meta.displayStart}-{meta.displayEnd} of {filtered.length}{" "}
                on Google Play
                {flaggedItems.length > 0 && (
                  <span className="text-red-500">
                    {" "}
                    · {flaggedItems.length} flagged shown separately below
                  </span>
                )}
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

          {/* ── FLAGGED SECTION (deleted-on-Google), sorted to the bottom ── */}
          {flaggedItems.length > 0 && (
            <div id="flagged-section" className="mt-6">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-red-700">
                    ⚠ Not on Google Play · {flaggedItems.length} item
                    {flaggedItems.length === 1 ? "" : "s"}
                  </span>
                  {/* Show / hide filter chip */}
                  <button
                    type="button"
                    onClick={() => setShowFlagged((s) => !s)}
                    aria-pressed={showFlagged}
                    className={`inline-flex items-center gap-2 text-xs font-semibold px-2.5 py-1 rounded-full border transition ${
                      showFlagged
                        ? "bg-slate-100 border-slate-300 text-slate-700"
                        : "bg-white border-slate-300 text-slate-500"
                    }`}
                  >
                    {showFlagged ? "Hide" : "Show"} deleted-on-Google
                    <span className="inline-flex items-center px-1.5 rounded-full bg-red-100 text-red-700">
                      {flaggedItems.length}
                    </span>
                  </button>
                </div>
                {showFlagged && (
                  <button
                    type="button"
                    onClick={() => setBulkConfirmOpen(true)}
                    disabled={removing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-300 hover:bg-red-50 rounded-lg transition disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove all {flaggedItems.length}
                  </button>
                )}
              </div>

              {showFlagged ? (
                <div className="bg-white border border-red-200 rounded-xl overflow-hidden">
                  <table className="w-full">
                    <tbody className="divide-y divide-red-100">
                      {flaggedItems.map((iap) => (
                        <FlaggedRow
                          key={iap.id}
                          iap={iap}
                          confirming={confirmingSku === iap.sku}
                          removing={removing}
                          onAsk={() => setConfirmingSku(iap.sku)}
                          onCancel={() => setConfirmingSku(null)}
                          onConfirm={() => handleAcknowledgeRemove([iap.sku])}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="bg-red-50/60 border border-red-200 rounded-xl px-4 py-3 text-center">
                  <span className="text-[13px] text-red-700 font-medium">
                    {flaggedItems.length} deleted-on-Google item
                    {flaggedItems.length === 1 ? "" : "s"} hidden
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowFlagged(true)}
                    className="text-xs text-red-700 underline ml-2"
                  >
                    Show
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {bulkMode && (
        <BulkStatusModal
          open
          mode={bulkMode}
          packageName={packageName}
          iaps={liveItems}
          onClose={() => setBulkMode(null)}
          onComplete={() => router.refresh()}
        />
      )}

      {/* ── BULK REMOVE CONFIRM MODAL ── */}
      {bulkConfirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-6">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                <Trash2 className="h-5 w-5 text-red-500" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-900">
                  Remove all {flaggedItems.length} deleted items?
                </h3>
                <p className="text-[13px] text-slate-600 mt-1">
                  These items are in the tool&rsquo;s cache but no longer on
                  Google Play. Removing them clears the cache rows (and their
                  prices/listings). This cannot be undone — it does not affect
                  Google Play.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setBulkConfirmOpen(false)}
                disabled={removing}
                className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  handleAcknowledgeRemove(flaggedItems.map((i) => i.sku))
                }
                disabled={removing}
                className="px-3 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition disabled:opacity-50"
              >
                {removing ? "Removing…" : `Remove ${flaggedItems.length} items`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FlaggedRow({
  iap,
  confirming,
  removing,
  onAsk,
  onCancel,
  onConfirm,
}: {
  iap: IapWithDefaultLocale;
  confirming: boolean;
  removing: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <tr className="bg-red-50/40 hover:bg-red-50/70 transition">
        <td className="px-4 py-3">
          <span className="text-sm font-medium text-slate-700 line-through decoration-red-400/70">
            {iap.default_title ?? iap.sku}
          </span>
          <span className="ml-2 inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
            Deleted on Google
          </span>
        </td>
        <td className="px-4 py-3 text-xs font-mono text-slate-500">{iap.sku}</td>
        <td className="px-4 py-3 text-xs text-red-600">
          detected missing {formatDetected(iap.deleted_on_google_at)}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onAsk}
            disabled={removing || confirming}
            className="text-xs font-medium text-red-700 border border-red-300 hover:bg-red-50 rounded-lg px-2.5 py-1.5 transition disabled:opacity-50"
          >
            Acknowledge / Remove
          </button>
        </td>
      </tr>
      {confirming && (
        <tr className="bg-red-50/40">
          <td colSpan={4} className="px-4 py-3">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-white px-4 py-3">
              <p className="text-[13px] text-slate-700">
                <span className="font-semibold">
                  Remove &ldquo;{iap.default_title ?? iap.sku}&rdquo; from the
                  tool?
                </span>{" "}
                It&rsquo;s already gone from Google Play. This cannot be undone.
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={removing}
                  className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1.5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={removing}
                  className="text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg px-3 py-1.5 transition disabled:opacity-50"
                >
                  {removing ? "Removing…" : "Confirm remove"}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
