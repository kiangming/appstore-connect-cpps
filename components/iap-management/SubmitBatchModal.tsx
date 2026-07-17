"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  X,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Info,
  Send,
} from "lucide-react";
import { useRouter } from "next/navigation";

interface PreflightRow {
  iap_id: string;
  apple_iap_id: string;
  product_id: string;
  reference_name: string;
  state: string;
  hint?: string;
}

interface NotOnAppleRow {
  iap_id: string;
  product_id: string;
  reference_name: string;
}

interface PreflightResponse {
  phase: "preflight";
  total: number;
  ready: PreflightRow[];
  missing_metadata: PreflightRow[];
  other: PreflightRow[];
  not_on_apple: NotOnAppleRow[];
}

interface ExecuteResultRow {
  iap_id: string;
  apple_iap_id: string;
  /** IAP.q.1.IV: `SKIPPED_BY_STATE_GUARD` added — server-side state guard
   *  blocked a row whose Apple state was not `READY_TO_SUBMIT`. */
  status: "SUCCESS" | "ERROR" | "SKIPPED_BY_STATE_GUARD";
  state?: string;
  error?: string;
}

interface ExecuteResponse {
  phase: "execute";
  submitted: number;
  failed: number;
  /** IAP.q.1.IV — count of rows blocked by the server-side state guard. */
  skipped?: number;
  results: ExecuteResultRow[];
  /** Hub-tracking run id — always null here (this phase is always
   *  terminal; the run has already been finalized server-side). */
  hub_run_id?: string | null;
}

/** v2 only — Decision A conflict dialog data. No Apple writes have
 *  happened yet when this phase is returned. */
interface ForeignItemsSummary {
  count: number;
  byKind: Record<string, number>;
  typesKnown: boolean;
}

interface ConflictResponse {
  phase: "conflict";
  reviewSubmissionId: string;
  eligibleCount: number;
  foreignItemsSummary: ForeignItemsSummary;
  /** Hub-tracking run id — the run stays RUNNING while this dialog shows.
   *  Threaded into the cancel call or the confirmConflict re-POST. */
  hub_run_id?: string | null;
}

/** v2 only — some reviewSubmissionItem adds (or the final submit) failed.
 *  Mirrors CPP's proceed-with-partial / rollback UX. */
interface PartialFailItem {
  iap_id: string;
  apple_iap_id: string;
  status: "SUCCESS" | "ERROR";
  error?: string;
  orphanedVersionWarning?: boolean;
}

interface PartialFailResponse {
  phase: "partial-fail";
  reviewSubmissionId: string;
  reused: boolean;
  items: PartialFailItem[];
  skipped: ExecuteResultRow[];
  /** Hub-tracking run id. Non-null when the run stays RUNNING pending
   *  proceedPartial/rollback; null when the confirm-PATCH-failed-after-
   *  all-adds-succeeded sub-case already finalized this run as FAILED. */
  hub_run_id?: string | null;
}

interface ConfirmedResponse {
  phase: "confirmed";
}

interface RolledBackResponse {
  phase: "rolled-back";
  deleted: boolean;
}

type ExecutePhaseResponse =
  | ExecuteResponse
  | ConflictResponse
  | PartialFailResponse;

const KIND_LABELS: Record<string, string> = {
  appCustomProductPageVersion: "Custom Product Page",
  inAppPurchaseVersion: "other In-App Purchase",
  appStoreVersion: "App Version",
  appEvent: "In-App Event",
  subscriptionVersion: "Subscription",
  subscriptionGroupVersion: "Subscription Group",
  backgroundAssetVersion: "Background Asset",
  unknown: "other item",
};

function kindLabel(kind: string, count: number): string {
  const label = KIND_LABELS[kind] ?? kind;
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

interface Props {
  open: boolean;
  appAppleId: string;
  /** Internal UUIDs of the IAPs the Manager selected on the list page. */
  selectedIapIds: string[];
  onClose: () => void;
}

type Stage =
  | { kind: "loading" }
  | { kind: "preflight"; data: PreflightResponse }
  | { kind: "submitting" }
  | { kind: "conflict"; data: ConflictResponse }
  | { kind: "partial-fail"; data: PartialFailResponse }
  | { kind: "resolving" }
  | { kind: "result"; data: ExecuteResponse }
  | { kind: "error"; message: string };

/**
 * Two-phase Submit Selected modal (IAP.o.6b).
 *
 * Phase 1 — preflight: opens, POSTs to /submit-batch (execute=false), shows
 * a fresh-from-Apple bucket preview (ready / missing / other / not_on_apple).
 *
 * Phase 2 — execute: Manager clicks Submit, POSTs again with execute=true,
 * the endpoint submits each READY_TO_SUBMIT IAP via concurrency 5 and returns
 * per-IAP results.
 */
export function SubmitBatchModal({
  open,
  appAppleId,
  selectedIapIds,
  onClose,
}: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStage({ kind: "loading" });
    (async () => {
      try {
        const res = await fetch(
          `/api/iap-management/apps/${appAppleId}/iaps/submit-batch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ iap_ids: selectedIapIds, execute: false }),
          },
        );
        const data = (await res.json()) as
          | PreflightResponse
          | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in data) {
          setStage({
            kind: "error",
            message: "error" in data ? data.error : `Preflight failed (${res.status})`,
          });
          return;
        }
        setStage({ kind: "preflight", data });
      } catch (err) {
        if (cancelled) return;
        setStage({
          kind: "error",
          message: err instanceof Error ? err.message : "Network error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, appAppleId, selectedIapIds]);

  // Remembers the ready iap_ids for this modal session so a conflict-dialog
  // "confirm" retry (or the initial execute call) always resends the same
  // selection.
  const readyIapIdsRef = useRef<string[]>([]);

  // ─── Hub tracking — three-state cancel guard (design doc §2/§B) ─────────
  // `hubRunIdRef` mirrors whatever `hub_run_id` the server last returned
  // (conflict / partial-fail) so it survives across the dialog round-trips
  // and is readable from the `beforeunload` handler without a stale closure.
  const hubRunIdRef = useRef<string | null>(null);
  // Permanent — set true the instant the write phase is known to have
  // begun and NEVER reset. Distinct from Bulk Import's `executeStartedRef`:
  // "started" here (the first execute POST) is not the same moment as
  // "committed to a real Apple write" once a conflict dialog intervenes.
  // State 1 (not started): no run exists, ref stays false.
  // State 2 (started, conflict dialog showing, zero Apple writes): ref
  //   stays false — cancel is allowed (conflict dialog Cancel / modal
  //   close / beforeunload all fire a real CANCEL, nothing to undo).
  // State 3 (committed, partial-fail dialog showing, writes already
  //   happened): ref is true — client-side cancel is suppressed; the
  //   proceedPartial/rollback request itself finalizes the run.
  const executeCommittedRef = useRef(false);

  // Best-effort — fire the SAME /hub-tracking/cancel route Bulk Import
  // uses. Only ever called while `!executeCommittedRef.current` (state 2).
  async function cancelHubRun() {
    const runId = hubRunIdRef.current;
    if (!runId) return;
    try {
      await fetch("/api/iap-management/hub-tracking/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      });
    } catch {
      // Best-effort — a failed cancel call must not block the user from
      // closing the modal.
    }
  }

  // Tab/browser close while the conflict dialog is showing (state 2) —
  // sendBeacon can't set a custom Authorization header, so this hits our
  // own backend route (session cookie rides along same-origin), which
  // holds the Hub token server-side. Mirrors BulkImportWizard's beforeunload
  // handler; this component has none today.
  useEffect(() => {
    if (!open) return;
    function handleBeforeUnload() {
      if (hubRunIdRef.current && !executeCommittedRef.current) {
        const blob = new Blob(
          [JSON.stringify({ run_id: hubRunIdRef.current })],
          { type: "application/json" },
        );
        navigator.sendBeacon("/api/iap-management/hub-tracking/cancel", blob);
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [open]);

  function handleExecuteResult(data: ExecutePhaseResponse) {
    if (data.phase === "conflict") {
      hubRunIdRef.current = data.hub_run_id ?? null;
      setStage({ kind: "conflict", data });
      return;
    }
    if (data.phase === "partial-fail") {
      hubRunIdRef.current = data.hub_run_id ?? null;
      executeCommittedRef.current = true;
      setStage({ kind: "partial-fail", data });
      return;
    }
    executeCommittedRef.current = true;
    setStage({ kind: "result", data });
    const skipped = data.skipped ?? 0;
    if (data.failed === 0 && skipped === 0) {
      toast.success(`Submitted ${data.submitted} IAP${data.submitted === 1 ? "" : "s"} for review.`);
    } else {
      const parts = [`Submitted ${data.submitted}`];
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      if (skipped > 0) parts.push(`${skipped} blocked by state guard`);
      toast.warning(`${parts.join(" · ")} — see details.`);
    }
  }

  async function postExecute(body: Record<string, unknown>) {
    const res = await fetch(
      `/api/iap-management/apps/${appAppleId}/iaps/submit-batch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = (await res.json()) as
      | ExecutePhaseResponse
      | ConfirmedResponse
      | RolledBackResponse
      | { error: string };
    if (!res.ok || "error" in data) {
      throw new Error("error" in data ? data.error : `Request failed (${res.status})`);
    }
    return data;
  }

  async function handleExecute() {
    if (stage.kind !== "preflight" || stage.data.ready.length === 0) return;
    readyIapIdsRef.current = stage.data.ready.map((r) => r.iap_id);
    setStage({ kind: "submitting" });
    try {
      const data = await postExecute({
        iap_ids: readyIapIdsRef.current,
        execute: true,
      });
      handleExecuteResult(data as ExecutePhaseResponse);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  /** Decision A — user explicitly chose to co-submit whatever else is
   *  already in the shared reviewSubmission ("Submit all N to Apple review").
   *  This re-POST IS the write attempt — set the commit guard the instant
   *  it fires, mirroring Bulk Import's "set the instant the mutating call
   *  is invoked" rule. */
  async function handleConfirmConflict() {
    executeCommittedRef.current = true;
    setStage({ kind: "submitting" });
    try {
      const data = await postExecute({
        iap_ids: readyIapIdsRef.current,
        execute: true,
        confirmConflict: true,
        hub_run_id: hubRunIdRef.current,
      });
      handleExecuteResult(data as ExecutePhaseResponse);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  /** Decision A / state 2 — conflict dialog "Cancel". Zero Apple writes
   *  have happened (checkForConflict is read-only), so this is a true
   *  cancel: best-effort close the Hub run as CANCEL, then close the modal. */
  async function handleCancelConflict() {
    await cancelHubRun();
    onClose();
  }

  /** Backdrop click / X button — routes through the same cancel-conflict
   *  path when the conflict dialog is showing (state 2), so closing the
   *  modal that way doesn't silently discard the open Hub run. */
  function handleModalClose() {
    if (stage.kind === "submitting" || stage.kind === "resolving") return;
    if (stage.kind === "conflict") {
      void handleCancelConflict();
      return;
    }
    onClose();
  }

  /** CPP-style partial-fail recovery: submit the container as-is (only
   *  successfully-added items go to review). */
  async function handleProceedPartial() {
    if (stage.kind !== "partial-fail") return;
    const submittedIapIds = stage.data.items
      .filter((i) => i.status === "SUCCESS")
      .map((i) => i.iap_id);
    const failedIapIds = stage.data.items
      .filter((i) => i.status === "ERROR")
      .map((i) => i.iap_id);
    setStage({ kind: "resolving" });
    try {
      await postExecute({
        iap_ids: readyIapIdsRef.current,
        proceedPartial: {
          reviewSubmissionId: stage.data.reviewSubmissionId,
          submittedIapIds,
          failedIapIds,
        },
        hub_run_id: hubRunIdRef.current,
      });
      toast.success(`Submitted ${submittedIapIds.length} IAP${submittedIapIds.length === 1 ? "" : "s"} for review.`);
      setStage({
        kind: "result",
        data: {
          phase: "execute",
          submitted: submittedIapIds.length,
          failed: stage.data.items.length - submittedIapIds.length,
          skipped: stage.data.skipped.length,
          results: [
            ...stage.data.items.map((i) => ({
              iap_id: i.iap_id,
              apple_iap_id: i.apple_iap_id,
              status: i.status,
              error: i.error,
            })),
            ...stage.data.skipped,
          ],
        },
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  /** CPP-style partial-fail recovery: cancel. A REUSED reviewSubmission is
   *  never deleted server-side — see rollbackOrLeaveSubmitV2. */
  async function handleRollbackPartial() {
    if (stage.kind !== "partial-fail") return;
    const addedIapIds = stage.data.items
      .filter((i) => i.status === "SUCCESS")
      .map((i) => i.iap_id);
    const failedIapIds = stage.data.items
      .filter((i) => i.status === "ERROR")
      .map((i) => i.iap_id);
    setStage({ kind: "resolving" });
    try {
      await postExecute({
        iap_ids: readyIapIdsRef.current,
        rollback: {
          reviewSubmissionId: stage.data.reviewSubmissionId,
          reused: stage.data.reused,
          addedIapIds,
          failedIapIds,
        },
        hub_run_id: hubRunIdRef.current,
      });
      toast.warning("Submission cancelled — no IAPs were sent for review.");
      onClose();
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  function handleCloseAndRefresh() {
    onClose();
    router.refresh();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      onClick={handleModalClose}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Submit Selected to Apple Review
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Apple state is the source of truth · only READY_TO_SUBMIT will go
              forward
            </p>
          </div>
          <button
            type="button"
            onClick={handleModalClose}
            disabled={stage.kind === "submitting" || stage.kind === "resolving"}
            className="p-1 rounded text-slate-400 hover:text-slate-700 disabled:opacity-30"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {stage.kind === "loading" && (
            <div className="py-12 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#0071E3]" />
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Querying Apple for fresh state on {selectedIapIds.length} IAP
                {selectedIapIds.length === 1 ? "" : "s"}…
              </p>
            </div>
          )}

          {stage.kind === "error" && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {stage.message}
            </div>
          )}

          {stage.kind === "preflight" && (
            <PreflightView data={stage.data} />
          )}

          {(stage.kind === "submitting" || stage.kind === "resolving") && (
            <div className="py-12 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#0071E3]" />
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {stage.kind === "submitting"
                  ? "Submitting to Apple Review…"
                  : "Applying your choice…"}
              </p>
            </div>
          )}

          {stage.kind === "conflict" && <ConflictView data={stage.data} />}

          {stage.kind === "partial-fail" && (
            <PartialFailView data={stage.data} />
          )}

          {stage.kind === "result" && (
            <ResultView data={stage.data} />
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          {stage.kind === "preflight" && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecute}
                disabled={stage.data.ready.length === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="h-3.5 w-3.5" />
                Submit {stage.data.ready.length} ready
              </button>
            </>
          )}
          {stage.kind === "conflict" && (
            <>
              <button
                type="button"
                onClick={handleCancelConflict}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmConflict}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
              >
                <Send className="h-3.5 w-3.5" />
                Submit all {stage.data.eligibleCount + stage.data.foreignItemsSummary.count} to Apple review
              </button>
            </>
          )}
          {stage.kind === "partial-fail" && (
            <>
              <button
                type="button"
                onClick={handleRollbackPartial}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
              >
                Cancel — don&apos;t submit
              </button>
              <button
                type="button"
                onClick={handleProceedPartial}
                disabled={
                  stage.data.items.filter((i) => i.status === "SUCCESS").length === 0
                }
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="h-3.5 w-3.5" />
                Submit the {stage.data.items.filter((i) => i.status === "SUCCESS").length} that succeeded
              </button>
            </>
          )}
          {stage.kind === "result" && (
            <button
              type="button"
              onClick={handleCloseAndRefresh}
              className="px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
            >
              Done
            </button>
          )}
          {stage.kind === "error" && (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg transition"
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function PreflightView({ data }: { data: PreflightResponse }) {
  return (
    <div className="space-y-4">
      <SummaryRow data={data} />

      {data.ready.length > 0 && (
        <Bucket
          icon={<CheckCircle className="h-3.5 w-3.5 text-emerald-600" />}
          tone="emerald"
          title={`Ready to submit · ${data.ready.length}`}
          rows={data.ready}
        />
      )}

      {data.missing_metadata.length > 0 && (
        <Bucket
          icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
          tone="amber"
          title={`Missing metadata · ${data.missing_metadata.length}`}
          rows={data.missing_metadata}
        />
      )}

      {data.other.length > 0 && (
        <Bucket
          icon={<Info className="h-3.5 w-3.5 text-slate-500" />}
          tone="slate"
          title={`Cannot be submitted · ${data.other.length}`}
          rows={data.other}
        />
      )}

      {data.not_on_apple.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 px-4 py-3">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
            Local drafts skipped · {data.not_on_apple.length}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {data.not_on_apple.map((r) => r.product_id).join(", ")}
          </p>
        </div>
      )}
    </div>
  );
}

function SummaryRow({ data }: { data: PreflightResponse }) {
  const ready = data.ready.length;
  const blocked = data.missing_metadata.length + data.other.length + data.not_on_apple.length;
  return (
    <div className="rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 px-4 py-3 text-xs">
      <p className="font-medium text-slate-700 dark:text-slate-300">
        {ready} of {data.total} ready · {blocked} blocked
      </p>
      {ready === 0 && (
        <p className="mt-1 text-amber-700 dark:text-amber-400">
          No IAPs are eligible. Fix the blocking issues below and refresh.
        </p>
      )}
    </div>
  );
}

interface BucketProps {
  icon: React.ReactNode;
  tone: "emerald" | "amber" | "slate";
  title: string;
  rows: PreflightRow[];
}

function Bucket({ icon, tone, title, rows }: BucketProps) {
  const borderTone =
    tone === "emerald"
      ? "border-emerald-200"
      : tone === "amber"
        ? "border-amber-200"
        : "border-slate-200 dark:border-slate-800";
  return (
    <div className={`rounded-lg border ${borderTone} bg-white dark:bg-slate-900 overflow-hidden`}>
      <header className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/30">
        {icon}
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">{title}</h3>
      </header>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((row) => (
          <li key={row.iap_id} className="px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate">
                {row.product_id}
              </span>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-medium tracking-wide">
                {row.state}
              </span>
            </div>
            <div className="text-slate-700 dark:text-slate-300 truncate">
              {row.reference_name}
            </div>
            {row.hint && (
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {row.hint}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultView({ data }: { data: ExecuteResponse }) {
  const skipped = data.skipped ?? 0;
  const allClean = data.failed === 0 && skipped === 0;
  return (
    <div className="space-y-4">
      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          allClean
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        <p className="font-semibold">
          {data.submitted} submitted · {data.failed} failed
          {skipped > 0 ? ` · ${skipped} blocked by state guard` : ""}
        </p>
        {allClean ? (
          <p className="mt-1 text-xs">
            All eligible IAPs are now waiting for Apple Review.
          </p>
        ) : skipped > 0 && data.failed === 0 ? (
          <p className="mt-1 text-xs">
            The server-side state guard blocked {skipped} row
            {skipped === 1 ? "" : "s"} that flipped out of READY_TO_SUBMIT
            between preflight and submit. Refresh and try again.
          </p>
        ) : (
          <p className="mt-1 text-xs">
            Review the entries below — Apple may have updated state mid-flight.
          </p>
        )}
      </div>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {data.results.map((row) => (
          <li key={row.iap_id} className="px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate">
                {row.apple_iap_id}
              </span>
              <span
                className={`text-[10px] font-medium uppercase tracking-wide ${
                  row.status === "SUCCESS"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : row.status === "SKIPPED_BY_STATE_GUARD"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-red-700 dark:text-red-400"
                }`}
              >
                {row.status === "SKIPPED_BY_STATE_GUARD" ? "SKIPPED" : row.status}
              </span>
            </div>
            {row.state && (
              <div className="text-slate-700 dark:text-slate-300">
                State: {row.state}
              </div>
            )}
            {row.error && (
              <p
                className={`mt-0.5 text-[11px] ${
                  row.status === "SKIPPED_BY_STATE_GUARD"
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {row.error}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Decision A conflict dialog. This app's existing open reviewSubmission
 * already contains items the Manager did NOT select in this batch — state
 * exactly what's already in it so the choice to co-submit is informed, not
 * a reflex click. Never auto-proceeds.
 */
function ConflictView({ data }: { data: ConflictResponse }) {
  const { foreignItemsSummary: summary } = data;
  const kindEntries = Object.entries(summary.byKind).filter(
    ([kind]) => kind !== "unknown",
  );
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <p className="font-semibold">
          This app already has an open Apple review submission with other
          items in it.
        </p>
        <p className="mt-1 text-xs">
          Apple allows only one non-app-version submission per app at a
          time — submitting will send your {data.eligibleCount} selected
          IAP{data.eligibleCount === 1 ? "" : "s"} together with what&apos;s
          already there.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
          Already in this submission
        </p>
        {summary.typesKnown && kindEntries.length > 0 ? (
          <ul className="text-xs text-slate-600 dark:text-slate-400 list-disc list-inside space-y-0.5">
            {kindEntries.map(([kind, count]) => (
              <li key={kind}>{kindLabel(kind, count)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {summary.count} other item{summary.count === 1 ? "" : "s"} —
            Apple didn&apos;t return enough detail to identify the exact
            type.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * CPP-style partial-fail recovery view: some reviewSubmissionItem adds (or
 * the final submit) failed after retries. Mirrors CppList.tsx's
 * proceed-with-partial / rollback pattern — failures are listed, never
 * silently dropped.
 */
function PartialFailView({ data }: { data: PartialFailResponse }) {
  const succeeded = data.items.filter((i) => i.status === "SUCCESS").length;
  const failed = data.items.filter((i) => i.status === "ERROR").length;
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <p className="font-semibold">
          {succeeded} added successfully · {failed} failed
        </p>
        <p className="mt-1 text-xs">
          Choose whether to submit the {succeeded} that succeeded now, or
          cancel without submitting anything.
        </p>
      </div>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        {data.items.map((row) => (
          <li key={row.iap_id} className="px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate">
                {row.apple_iap_id}
              </span>
              <span
                className={`text-[10px] font-medium uppercase tracking-wide ${
                  row.status === "SUCCESS"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-red-700 dark:text-red-400"
                }`}
              >
                {row.status}
              </span>
            </div>
            {row.error && (
              <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                {row.error}
              </p>
            )}
            {row.orphanedVersionWarning && (
              <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                A version was created on Apple for this IAP before this
                failure and cannot be auto-removed — check App Store
                Connect if this recurs.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
