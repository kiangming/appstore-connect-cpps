"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Search,
  ChevronLeft,
  Inbox,
  Plus,
  Pencil,
  FileText,
  Upload,
  Download,
  RefreshCw,
  Send,
  Loader2,
  ChevronRight,
  Eye,
  Globe,
  MinusCircle,
} from "lucide-react";
import type {
  InAppPurchase,
  InAppPurchaseType,
} from "@/types/iap-management/apple";
import type { IapDbRow } from "@/lib/iap-management/queries/iaps";
import { useAppIcon, getAvatarColor, getInitials } from "@/lib/use-app-icon";
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";
import { SubmitBatchModal } from "@/components/iap-management/SubmitBatchModal";
import {
  AvailabilitiesBulkModal,
  type BulkMode,
} from "@/components/iap-management/AvailabilitiesBulkModal";
import { AvailabilityCell } from "@/components/iap-management/AvailabilityCell";
import { ExportOptionsDialog } from "@/components/iap-management/ExportOptionsDialog";

const PAGE_SIZE = 100;

/**
 * Decision B — Apple's official per-reviewSubmission cap (confirmed via
 * Apple's "Submit an In-App Purchase" help docs, see
 * docs/iap-management/design-iap-v2-submission-migration.md §0 Q4).
 * Enforced client-side so a >200 selection can never reach Apple:
 * multi-select is capped at this many, and "select all" on a larger
 * filtered set is blocked entirely rather than silently truncated.
 */
const MAX_SUBMIT_SELECTION = 200;

interface Props {
  appId: string;
  appName: string;
  appBundleId: string;
  iaps: InAppPurchase[];
  /** Local-only drafts (apple_iap_id NULL). Editable; Apple-synced IAPs are read-only in v1. */
  drafts?: IapDbRow[];
  /** Apple-IAP-id → internal-UUID map for synced rows. Required for multi-select submit. */
  appleToInternal: Record<string, string>;
}

const TYPE_LABEL: Record<InAppPurchaseType, string> = {
  CONSUMABLE: "Consumable",
  NON_CONSUMABLE: "Non-Consumable",
  NON_RENEWING_SUBSCRIPTION: "Non-Renewing Sub",
};

const TYPE_BADGE: Record<InAppPurchaseType, string> = {
  CONSUMABLE: "bg-blue-50 text-blue-700 border-blue-200",
  NON_CONSUMABLE: "bg-purple-50 text-purple-700 border-purple-200",
  NON_RENEWING_SUBSCRIPTION: "bg-orange-50 text-orange-700 border-orange-200",
};

function stateBadge(state: string): string {
  switch (state) {
    case "READY_FOR_SALE":
    case "APPROVED":
      return "bg-green-50 text-green-700 border-green-200";
    case "IN_REVIEW":
    case "WAITING_FOR_REVIEW":
    case "PENDING_APPLE_RELEASE":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "REJECTED":
    case "DEVELOPER_ACTION_NEEDED":
      return "bg-red-50 text-red-700 border-red-200";
    case "REMOVED_FROM_SALE":
    case "DEVELOPER_REMOVED_FROM_SALE":
      return "bg-slate-50 text-slate-500 border-slate-200";
    case "MISSING_METADATA":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "READY_TO_SUBMIT":
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function stateLabel(state: string): string {
  return state.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function AppHeaderIcon({ name, bundleId }: { name: string; bundleId: string }) {
  const iconUrl = useAppIcon(bundleId);
  const [imgError, setImgError] = useState(false);

  if (iconUrl && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt={name}
        width={60}
        height={60}
        className="w-[60px] h-[60px] rounded-[16px] object-cover shadow-sm flex-shrink-0"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      className={`w-[60px] h-[60px] rounded-[16px] flex-shrink-0 flex items-center justify-center ${getAvatarColor(name)} shadow-sm`}
    >
      <span className="text-white text-[20px] font-bold tracking-tight">
        {getInitials(name)}
      </span>
    </div>
  );
}

export function IapListClient({
  appId,
  appName,
  appBundleId,
  iaps,
  drafts = [],
  appleToInternal,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<InAppPurchaseType | "ALL">("ALL");
  const [stateFilter, setStateFilter] = useState<string>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [page, setPage] = useState(1);
  // Cycle 39 Phase 2 — bulk modal state. Null = closed.
  // Hotfix 25: the modal now fetches availability on open via the
  // per-IAP API route — no prop drilling of pre-fetched state.
  const [bulkMode, setBulkMode] = useState<BulkMode | null>(null);

  const allStates = useMemo(() => {
    const s = new Set<string>();
    for (const iap of iaps) s.add(iap.attributes.state);
    return Array.from(s).sort();
  }, [iaps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return iaps.filter((iap) => {
      if (typeFilter !== "ALL" && iap.attributes.inAppPurchaseType !== typeFilter) {
        return false;
      }
      if (stateFilter !== "ALL" && iap.attributes.state !== stateFilter) {
        return false;
      }
      if (q) {
        const productId = iap.attributes.productId.toLowerCase();
        const name = iap.attributes.name.toLowerCase();
        if (!productId.includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
  }, [iaps, query, typeFilter, stateFilter]);

  // IAP.o.7b — Filter changes reset to page 1. computePageMeta clamps if
  // page > totalPages, but resetting on filter change gives the Manager a
  // predictable "see the top of the new result set" experience.
  useEffect(() => {
    setPage(1);
  }, [query, typeFilter, stateFilter]);

  const pageMeta = useMemo(
    () => computePageMeta(filtered.length, page, PAGE_SIZE),
    [filtered.length, page],
  );

  const paginated = useMemo(
    () => filtered.slice(pageMeta.startIndex, pageMeta.endIndex),
    [filtered, pageMeta.startIndex, pageMeta.endIndex],
  );

  // Internal UUIDs corresponding to the currently-selected Apple-side IAPs.
  const selectedInternalIds = useMemo(() => {
    const ids: string[] = [];
    for (const appleId of selected) {
      const internal = appleToInternal[appleId];
      if (internal) ids.push(internal);
    }
    return ids;
  }, [selected, appleToInternal]);

  // IAP.q.1.II — selectable = has local row AND Apple state === READY_TO_SUBMIT.
  // Prior to q.1 the only gate was "has local row" (`appleToInternal[iap.id]`),
  // which let Manager check MISSING_METADATA rows that the modal preflight
  // would later silently drop. Apple's state is the authoritative gate per
  // Q-IAP.h.3 — mirror that gate at the row level so eligibility is visible
  // upfront. Toggle-all + selection count derive from this same list.
  const selectableAppleIds = useMemo(
    () =>
      filtered
        .filter(
          (iap) =>
            appleToInternal[iap.id] &&
            iap.attributes.state === "READY_TO_SUBMIT",
        )
        .map((iap) => iap.id),
    [filtered, appleToInternal],
  );

  // Decision B — Apple's official 200-item-per-reviewSubmission cap,
  // enforced client-side so a >200 selection can never reach Apple.
  // Invariant maintained here: `selected.size` never exceeds
  // MAX_SUBMIT_SELECTION at any point, for either single-checkbox or
  // select-all interaction.
  function toggleOne(appleIapId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appleIapId)) {
        next.delete(appleIapId);
        return next;
      }
      if (next.size >= MAX_SUBMIT_SELECTION) {
        toast.warning(
          `Max ${MAX_SUBMIT_SELECTION} IAPs per submission (Apple's limit) — deselect one before adding another.`,
        );
        return prev;
      }
      next.add(appleIapId);
      return next;
    });
  }

  function toggleAll() {
    if (selectableAppleIds.every((id) => selected.has(id))) {
      // All selected → deselect
      setSelected(new Set());
      return;
    }
    if (selectableAppleIds.length > MAX_SUBMIT_SELECTION) {
      toast.error(
        `${selectableAppleIds.length} eligible IAPs, but Apple allows max ${MAX_SUBMIT_SELECTION} per submission. Select up to ${MAX_SUBMIT_SELECTION} manually and submit in batches.`,
      );
      return;
    }
    setSelected(new Set(selectableAppleIds));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/iap-management/apps/${appId}/iaps/sync-states`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error(data.error ?? `Refresh failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        synced_count: number;
        unchanged_count: number;
        inserted_count?: number;
        updated_count?: number;
        errors: string[];
      };
      // IAP.o.8b — Manager MV30 Issue 2 fix surfaces inserted vs updated
      // separately so the first-sync "discovered N new IAPs" path is
      // explicit. Falls back to the legacy "Refreshed N" toast when both
      // counters are zero (older API shape).
      const parts: string[] = [];
      if (data.inserted_count && data.inserted_count > 0) {
        parts.push(`${data.inserted_count} discovered`);
      }
      if (data.updated_count && data.updated_count > 0) {
        parts.push(`${data.updated_count} state changed`);
      }
      const summary =
        parts.length > 0
          ? parts.join(" · ")
          : `${data.synced_count} refreshed`;
      if (data.errors && data.errors.length > 0) {
        toast.warning(`${summary} · ${data.errors.length} error(s).`);
      } else {
        toast.success(summary);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setRefreshing(false);
    }
  }

  // Apple has no per-territory price cache, so export is a live per-IAP
  // fetch (2-3 Apple calls each) — a large app can take a few minutes.
  // Generous client-side ceiling so it doesn't look hung mid-way.
  const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

  async function handleConfirmExport(selectedTerritories: string[] | null) {
    setExportDialogOpen(false);
    setExporting(true);
    const toastId = toast.loading("Generating export… this can take a few minutes for large apps.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/iap-management/apps/${appId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ territories: selectedTerritories }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? `Export failed (${res.status})`, { id: toastId });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="?([^"]+)"?/.exec(disposition);
      const filename = match?.[1] ?? `Apple-IAP-export-${appId}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const count = res.headers.get("X-Export-Item-Count");
      const failedCount = Number(res.headers.get("X-Export-Failed-Count") ?? "0");
      const summary = count ? `Exported ${count} item${count === "1" ? "" : "s"}.` : "Export ready.";
      if (failedCount > 0) {
        toast.warning(`${summary} · ${failedCount} item(s) skipped (fetch failed).`, { id: toastId });
      } else {
        toast.success(summary, { id: toastId });
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `Export timed out after ${Math.round(EXPORT_TIMEOUT_MS / 60000)} min — the app may have many IAPs; try again.`
          : err instanceof Error
            ? err.message
            : "Network error";
      toast.error(message, { id: toastId });
    } finally {
      clearTimeout(timer);
      setExporting(false);
    }
  }

  const allSelected =
    selectableAppleIds.length > 0 &&
    selectableAppleIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/iap-management/apps"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition"
      >
        <ChevronLeft className="h-4 w-4" />
        All apps
      </Link>

      {/* App header */}
      <div className="flex items-center gap-4">
        <AppHeaderIcon name={appName} bundleId={appBundleId} />
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight truncate">
            {appName || "Loading…"}
          </h1>
          <p className="text-xs font-mono text-slate-400 truncate mt-0.5">
            {appBundleId}
          </p>
        </div>
        <span className="ml-auto inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
          {iaps.length} IAP{iaps.length === 1 ? "" : "s"}
        </span>
        {/* Cycle 39 Phase 2 Unit C — bulk Availabilities buttons (left-most
            position per Manager kickoff). The buttons render unconditionally
            so Manager always has the affordance; the modal handles empty
            states when no IAP currently sits in the eligible bucket. */}
        <button
          type="button"
          onClick={() => setBulkMode("set-all")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-teal-300 text-teal-700 hover:bg-teal-50 rounded-lg transition"
          title="Mark a multi-selection of items as available in all Apple territories"
        >
          <Globe className="h-3.5 w-3.5" />
          Set Availabilities
        </button>
        <button
          type="button"
          onClick={() => setBulkMode("remove")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-red-300 text-red-700 hover:bg-red-50 rounded-lg transition"
          title="Mark a multi-selection of items as Remove from Sales (destructive)"
        >
          <MinusCircle className="h-3.5 w-3.5" />
          Remove from Sales
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
          title="Re-fetch state from Apple"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh from Apple
        </button>
        <Link
          href={`/iap-management/apps/${appId}/bulk-import`}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
        >
          <Upload className="h-3.5 w-3.5" />
          Bulk Import
        </Link>
        <button
          type="button"
          onClick={() => setExportDialogOpen(true)}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
          title="Export all IAPs (live from Apple) to xlsx"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          Export list
        </button>
        <Link
          href={`/iap-management/apps/${appId}/iaps/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
        >
          <Plus className="h-3.5 w-3.5" />
          Create IAP
        </Link>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="rounded-xl border border-[#0071E3] bg-blue-50 px-4 py-2.5 flex items-center justify-between gap-4 sticky top-0 z-10">
          <p className="text-sm font-medium text-blue-900">
            {selected.size} IAP{selected.size === 1 ? "" : "s"} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="text-xs text-blue-700 hover:underline"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
            >
              <Send className="h-3.5 w-3.5" />
              Submit Selected
            </button>
          </div>
        </div>
      )}

      {/* Drafts section (local-only, editable) */}
      {drafts.length > 0 && (
        <section className="bg-white rounded-xl border border-amber-200 overflow-hidden">
          <header className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-700" />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              Local Drafts · {drafts.length}
            </h2>
            <span className="ml-auto text-[11px] text-amber-700">
              Not yet pushed to Apple — open to continue editing.
            </span>
          </header>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-2">Product ID</th>
                <th className="px-4 py-2">Reference Name</th>
                <th className="px-4 py-2 w-36">Type</th>
                <th className="px-4 py-2 w-32">Tier</th>
                <th className="px-4 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {drafts.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50 transition">
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">
                    {d.product_id}
                  </td>
                  <td className="px-4 py-2 text-slate-800 truncate max-w-[260px]">
                    {d.reference_name}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {d.type.replace(/_/g, " ").toLowerCase()}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-slate-500">
                    {d.tier_id ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/iap-management/apps/${appId}/iaps/${d.id}`}
                      className="inline-flex items-center gap-1 text-[#0071E3] hover:underline text-xs"
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Product ID or Reference Name…"
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-slate-200 bg-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as InAppPurchaseType | "ALL")}
          className="rounded-lg border border-slate-200 bg-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
        >
          <option value="ALL">All types</option>
          <option value="CONSUMABLE">Consumable</option>
          <option value="NON_CONSUMABLE">Non-Consumable</option>
          <option value="NON_RENEWING_SUBSCRIPTION">Non-Renewing Sub</option>
        </select>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
        >
          <option value="ALL">All states</option>
          {allStates.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <Inbox className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">
            {iaps.length === 0 ? "No IAPs for this app." : "No matches."}
          </p>
          {iaps.length === 0 && (
            <p className="text-xs text-slate-400 mt-1">
              Use Bulk Import or Create IAP to populate.
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="Select all"
                    className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3">Product ID</th>
                <th className="px-4 py-3">Reference Name</th>
                <th className="px-4 py-3 w-36">Type</th>
                <th className="px-4 py-3 w-44">State</th>
                {/* Cycle 39 Phase 2 Unit D — Availabilities column. */}
                <th className="px-4 py-3 w-44">Availabilities</th>
                <th className="px-4 py-3 w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paginated.map((iap) => {
                // IAP.q.1.II: row-level eligibility gate now includes Apple
                // state. Tooltip surfaces the reason a checkbox is disabled
                // so Manager sees it upfront instead of in the modal preflight.
                const hasLocalRow = Boolean(appleToInternal[iap.id]);
                const isReadyState =
                  iap.attributes.state === "READY_TO_SUBMIT";
                const eligible = hasLocalRow && isReadyState;
                const disabledReason = !hasLocalRow
                  ? "Not synced to local — click Refresh from Apple to enable selection."
                  : !isReadyState
                    ? `Cannot submit: state is ${stateLabel(iap.attributes.state)}. Fix prerequisites to reach Ready To Submit.`
                    : null;
                const isSelected = selected.has(iap.id);
                const internalId = appleToInternal[iap.id];
                const viewHref = internalId
                  ? `/iap-management/apps/${appId}/iaps/${internalId}/view`
                  : undefined;
                // IAP.o.8c → IAP.o.10b — row-wide click navigates to /view, AND
                // an explicit eye-icon "View" button sits next to Edit so
                // Manager doesn't have to discover the row-click affordance.
                // Stub-less Apple rows (no internal UUID) stay non-clickable
                // until Refresh from Apple seeds the local cache.
                return (
                  <tr
                    key={iap.id}
                    onClick={() => {
                      if (viewHref) router.push(viewHref);
                    }}
                    role={viewHref ? "button" : undefined}
                    tabIndex={viewHref ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (!viewHref) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        router.push(viewHref);
                      }
                    }}
                    aria-label={
                      viewHref
                        ? `View details for ${iap.attributes.productId}`
                        : undefined
                    }
                    className={`hover:bg-slate-50 transition ${isSelected ? "bg-blue-50/40" : ""} ${viewHref ? "cursor-pointer" : ""}`}
                  >
                    <td
                      className="px-3 py-2.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(iap.id)}
                        disabled={!eligible}
                        title={disabledReason ?? "Toggle selection"}
                        aria-label={
                          disabledReason ?? `Select ${iap.attributes.productId}`
                        }
                        className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                      {iap.attributes.productId}
                    </td>
                    <td className="px-4 py-2.5 text-slate-800 truncate max-w-[260px]">
                      {iap.attributes.name}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${TYPE_BADGE[iap.attributes.inAppPurchaseType]}`}
                      >
                        {TYPE_LABEL[iap.attributes.inAppPurchaseType]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${stateBadge(iap.attributes.state)}`}
                      >
                        {stateLabel(iap.attributes.state)}
                      </span>
                    </td>
                    {/* Cycle 39 Phase 2 Unit D — Availabilities cell.
                        Hotfix 25: lazy-loaded per-row via
                        IntersectionObserver + client concurrency queue. */}
                    <td className="px-4 py-2.5">
                      <AvailabilityCell internalIapId={appleToInternal[iap.id] ?? null} />
                    </td>
                    <td
                      className="px-4 py-2.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {internalId ? (
                        <div className="inline-flex items-center gap-3">
                          <Link
                            href={viewHref!}
                            aria-label={`View details for ${iap.attributes.productId}`}
                            className="inline-flex items-center gap-1 text-[#0071E3] hover:underline text-xs"
                          >
                            <Eye className="h-3 w-3" />
                            View
                          </Link>
                          <Link
                            href={`/iap-management/apps/${appId}/iaps/${internalId}`}
                            aria-label={`Edit ${iap.attributes.productId}`}
                            className="inline-flex items-center gap-1 text-slate-600 hover:text-[#0071E3] hover:underline text-xs"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </Link>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Pagination footer — IAP.o.7b. Hidden when ≤1 page so small
              lists stay visually clean (Manager apps with <100 IAPs). */}
          {pageMeta.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200 bg-slate-50">
              <p className="text-xs text-slate-500">
                Showing{" "}
                <span className="font-medium text-slate-700">
                  {pageMeta.displayStart}–{pageMeta.displayEnd}
                </span>{" "}
                of{" "}
                <span className="font-medium text-slate-700">{filtered.length}</span>
                {filtered.length !== iaps.length && (
                  <>
                    {" "}
                    <span className="text-slate-400">
                      (filtered from {iaps.length})
                    </span>
                  </>
                )}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={pageMeta.page <= 1}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </button>
                <span className="text-xs text-slate-500 tabular-nums">
                  Page{" "}
                  <span className="font-medium text-slate-700">{pageMeta.page}</span>{" "}
                  of{" "}
                  <span className="font-medium text-slate-700">
                    {pageMeta.totalPages}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPage((p) => Math.min(pageMeta.totalPages, p + 1))
                  }
                  disabled={pageMeta.page >= pageMeta.totalPages}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Next page"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <SubmitBatchModal
        open={modalOpen}
        appAppleId={appId}
        selectedIapIds={selectedInternalIds}
        onClose={() => setModalOpen(false)}
      />

      {/* Cycle 39 Phase 2 Unit C — bulk Availabilities modal. Operates on
          the full filtered table set (not paginated). Hotfix 25: modal
          fetches availability on open via the per-IAP API route. */}
      {bulkMode !== null && (
        <AvailabilitiesBulkModal
          open
          mode={bulkMode}
          iaps={filtered}
          appleToInternal={appleToInternal}
          onClose={() => setBulkMode(null)}
          onComplete={() => router.refresh()}
        />
      )}

      <ExportOptionsDialog
        open={exportDialogOpen}
        onCancel={() => setExportDialogOpen(false)}
        onExport={handleConfirmExport}
      />
    </div>
  );
}
