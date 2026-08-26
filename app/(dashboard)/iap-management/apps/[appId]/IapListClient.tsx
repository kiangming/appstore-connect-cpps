"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  MapPin,
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
import {
  asOfLabel,
  asOfSummary,
  type AvailabilityMirrorByAppleId,
  type AvailabilityMirrorRecord,
} from "@/lib/iap-management/apple/availability-as-of";
import { ExportItemWizard } from "@/components/iap-management/export-wizard/ExportItemWizard";
import { ExportResultSummary } from "@/components/iap-management/export-wizard/ExportResultSummary";

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
  /** SC6 — Apple IAP id → that item's own base_territory, for the
   *  Set Availabilities confirm advisory. Bases differ across a batch. */
  baseTerritoryByAppleId?: Record<string, string>;
  /**
   * C5 — the availability mirror, read from the local DB by the server
   * component. Items ABSENT from this map have never been synced: their cell
   * falls back to the original lazy fetch, and they are counted as Unknown in
   * the as-of line. Absence is never rendered as a verdict.
   */
  availabilityByAppleId?: AvailabilityMirrorByAppleId;
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
  baseTerritoryByAppleId = {},
  availabilityByAppleId = {},
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<InAppPurchaseType | "ALL">("ALL");
  const [stateFilter, setStateFilter] = useState<string>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportWizardOpen, setExportWizardOpen] = useState(false);
  const [exportResult, setExportResult] = useState<{
    exported: number;
    partial: number;
    failed: number;
    notAttempted: number;
    stopped: boolean;
    selectedCount: number | null;
  } | null>(null);
  const [page, setPage] = useState(1);
  // Cycle 39 Phase 2 — bulk modal state. Null = closed.
  // Hotfix 25: the modal now fetches availability on open via the
  // per-IAP API route — no prop drilling of pre-fetched state.
  const [bulkMode, setBulkMode] = useState<BulkMode | null>(null);

  /**
   * C6 — verdicts learned by cells DURING this page's life, on top of what the
   * server render knew.
   *
   * ⚠ Without this the as-of line would be a lie the moment a cell resolved:
   * the server said "40 never synced", ten cells then read Apple and filled
   * the mirror, and the line would still say 40 until a reload. The count on
   * screen has to mean the items on screen, now.
   */
  const [resolvedAvailability, setResolvedAvailability] = useState<
    Record<string, AvailabilityMirrorRecord>
  >({});

  const handleAvailabilityResolved = useCallback(
    (appleIapId: string, record: AvailabilityMirrorRecord) => {
      setResolvedAvailability((prev) => {
        const existing = prev[appleIapId];
        // ⚠ Newer only. A slow response landing after a fresher one must not
        //   push the older answer back — same rule the cell itself applies.
        if (existing && existing.syncedAt >= record.syncedAt) return prev;
        return { ...prev, [appleIapId]: record };
      });
    },
    [],
  );

  /**
   * ⚠ SERVER FIRST, CLIENT OVERLAY SECOND — and that order matters after a
   * `router.refresh()`. Refresh from Apple sweeps availability server-side and
   * re-renders with a fresher `availabilityByAppleId`; if the client overlay
   * won, every item a cell had read earlier would be pinned to its stale
   * pre-refresh verdict and the column would look frozen — the exact M3
   * symptom this arc exists to remove. The overlay only fills gaps the server
   * render did not know about, and the per-record `syncedAt` comparison in the
   * cell settles the rest.
   */
  const availabilityMirror = useMemo(() => {
    const merged: Record<string, AvailabilityMirrorRecord> = {
      ...resolvedAvailability,
    };
    for (const [appleId, record] of Object.entries(availabilityByAppleId)) {
      const overlay = merged[appleId];
      if (!overlay || record.syncedAt >= overlay.syncedAt) {
        merged[appleId] = record;
      }
    }
    return merged;
  }, [availabilityByAppleId, resolvedAvailability]);

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
        // C4 — the availability sweep's own counters, reported separately
        // because they answer a different question than the state counters.
        availability_read_count?: number;
        availability_failed_count?: number;
        availability_not_attempted_count?: number;
        availability_stopped?: boolean;
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
      // ⚠ [EXPORT-availability-filter] C4 — A STOPPED SWEEP MUST BE VISIBLE.
      //    Refresh now also reads availability for every item, and that half
      //    can stop early on Apple's rate limit while the state half succeeded
      //    completely. Reporting only "N refreshed" would leave the Manager
      //    believing the Availabilities column is current when part of it is
      //    still yesterday's answer — the same class of quiet staleness this
      //    whole arc was opened over. The untouched items keep their old
      //    as-of timestamp, and the as-of line under the filters shows it.
      const availabilityRead = data.availability_read_count ?? 0;
      const notAttempted = data.availability_not_attempted_count ?? 0;
      const availabilityFailed = data.availability_failed_count ?? 0;
      const availabilityNote =
        availabilityRead > 0 || notAttempted > 0 || availabilityFailed > 0
          ? ` · availability: ${availabilityRead} read${
              availabilityFailed > 0 ? `, ${availabilityFailed} failed` : ""
            }${notAttempted > 0 ? `, ${notAttempted} not read` : ""}`
          : "";

      if (data.availability_stopped) {
        toast.warning(
          `${summary}${availabilityNote} — availability stopped on Apple's rate limit. Items not read keep their previous "as of" time.`,
        );
      } else if (data.errors && data.errors.length > 0) {
        toast.warning(`${summary}${availabilityNote} · ${data.errors.length} error(s).`);
      } else {
        toast.success(`${summary}${availabilityNote}`);
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

  async function handleConfirmExport(args: {
    selectedIds: string[];
    territories: string[] | null;
  }) {
    const { selectedIds, territories: selectedTerritories } = args;
    setExportWizardOpen(false);
    setExporting(true);
    const toastId = toast.loading("Generating export… this can take a few minutes for large apps.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/iap-management/apps/${appId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ⚠ `selectedIds` is sent from this commit on, but the route does
        //    NOT read it yet — chunk 2e adds that, together with the
        //    per-id honesty guarantees (dead ids surface in the failure
        //    sheet rather than being filtered away). Until then the export
        //    is still whole-app; the two commits ship together.
        body: JSON.stringify({ territories: selectedTerritories, selectedIds }),
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

      // ⚠ Read from the headers 2a pinned — no new header was added for any
      //   of this, and none of their meanings changed.
      const count = res.headers.get("X-Export-Item-Count");
      const exported = Number(count ?? "0");
      const failedCount = Number(res.headers.get("X-Export-Failed-Count") ?? "0");
      const partialCount = Number(res.headers.get("X-Export-Partial-Count") ?? "0");
      const notAttemptedCount = Number(
        res.headers.get("X-Export-Not-Attempted-Count") ?? "0",
      );
      const stopped = res.headers.get("X-Export-Stopped") === "rate_limit";
      const selectedCount = selectedIds.length > 0 ? selectedIds.length : null;

      // ⚠ WITH A SELECTION THE DENOMINATOR IS THE ASK, NOT THE APP. "Exported
      //   38 items" against a 40-item pick hides that 2 are missing; "38 of 40
      //   selected" is the same number telling the truth. X is
      //   X-Export-Item-Count unchanged — the count was never redefined, only
      //   given the denominator it always implied.
      const summary = !count
        ? "Export ready."
        : selectedCount !== null
          ? `Exported ${count} of ${selectedCount} selected.`
          : `Exported ${count} item${count === "1" ? "" : "s"}.`;

      if (stopped) {
        // ⚠ A stopped run is NOT a failed run — most items already landed.
        toast.warning(`${summary} · stopped on Apple's rate limit.`, { id: toastId });
      } else if (failedCount > 0) {
        toast.warning(`${summary} · ${failedCount} item(s) skipped (fetch failed).`, { id: toastId });
      } else {
        toast.success(summary, { id: toastId });
      }

      // The panel only appears when a toast cannot carry it honestly — three
      // separate outcomes do not fit in one line, and a clean run needs no
      // dialog.
      if (stopped || failedCount > 0 || notAttemptedCount > 0 || partialCount > 0) {
        setExportResult({
          exported,
          partial: partialCount,
          failed: failedCount,
          notAttempted: notAttemptedCount,
          stopped,
          selectedCount,
        });
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
        {/* D1 — the entry point for per-territory selection. Built in SC6 and
            reachable from nothing until this button landed: the modal, route,
            orchestrator and tests all supported "set-territories" while
            nothing set that mode, so the feature shipped dead. Placed between
            the two all-or-nothing presets because it is the middle ground
            between them. */}
        <button
          type="button"
          onClick={() => setBulkMode("set-territories")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-blue-300 text-blue-700 hover:bg-blue-50 rounded-lg transition"
          title="Choose exactly which Apple territories a multi-selection of items sells in"
        >
          <MapPin className="h-3.5 w-3.5" />
          Choose territories
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
          onClick={() => setExportWizardOpen(true)}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
          title="Choose items, then countries, then export to xlsx"
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

      {/* C6 — how old the Availabilities column is, in the same words the
          export wizard uses (one shared `asOfLabel`, so the two surfaces can
          never tell the Manager different things about the same data).
          ⚠ Scoped to the CURRENT PAGE's rows, not the whole app: those are the
          cells actually on screen, and dating them by items the Manager cannot
          see would be the same lie in the other direction. */}
      {paginated.length > 0 && (
        <p
          data-testid="list-availability-as-of"
          className="text-[11px] text-slate-400 -mt-3"
        >
          {asOfLabel(asOfSummary(paginated.map((iap) => iap.id), availabilityMirror))}
        </p>
      )}

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
                      <AvailabilityCell
                        internalIapId={appleToInternal[iap.id] ?? null}
                        mirror={availabilityMirror[iap.id] ?? null}
                        onResolved={(record) =>
                          handleAvailabilityResolved(iap.id, record)
                        }
                      />
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
          baseTerritoryByAppleId={baseTerritoryByAppleId}
          /* ⚠ Drafts were never passed here. They are not "filtered out" of
             the modal — they were never in it, so a Manager looking for one
             had no explanation on screen. Shown-but-disabled, per the lock. */
          drafts={drafts}
          onClose={() => setBulkMode(null)}
          onComplete={() => router.refresh()}
        />
      )}

      {/* ⚠ Two steps, both free. The wizard renders the SHARED
          `ExportOptionsDialog` itself as step 2 — unmodified, three props —
          rather than this page rendering it directly (P8: that dialog is
          Google's too). */}
      <ExportItemWizard
        open={exportWizardOpen}
        iaps={iaps}
        drafts={drafts.map((d) => ({
          id: d.id,
          product_id: d.product_id,
          reference_name: d.reference_name,
        }))}
        appleToInternal={appleToInternal}
        /* ⚠ The MERGED map, not the raw server prop — so an item a cell read
           moments ago is already Available/Removed in the picker instead of
           Unknown. The wizard still issues zero requests; it reads what the
           page already has. */
        availabilityByAppleId={availabilityMirror}
        exporting={exporting}
        onCancel={() => setExportWizardOpen(false)}
        onExport={handleConfirmExport}
      />

      {exportResult && (
        <ExportResultSummary
          {...exportResult}
          onClose={() => setExportResult(null)}
        />
      )}
    </div>
  );
}
