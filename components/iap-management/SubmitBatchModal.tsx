"use client";

import { useEffect, useState } from "react";
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

  async function handleExecute() {
    if (stage.kind !== "preflight" || stage.data.ready.length === 0) return;
    setStage({ kind: "submitting" });
    try {
      const res = await fetch(
        `/api/iap-management/apps/${appAppleId}/iaps/submit-batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            iap_ids: stage.data.ready.map((r) => r.iap_id),
            execute: true,
          }),
        },
      );
      const data = (await res.json()) as
        | ExecuteResponse
        | { error: string };
      if (!res.ok || "error" in data) {
        setStage({
          kind: "error",
          message: "error" in data ? data.error : `Submit failed (${res.status})`,
        });
        return;
      }
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
      onClick={() => stage.kind !== "submitting" && onClose()}
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
            onClick={onClose}
            disabled={stage.kind === "submitting"}
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

          {stage.kind === "submitting" && (
            <div className="py-12 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#0071E3]" />
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Submitting to Apple Review…
              </p>
            </div>
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
