"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  HelpCircle,
  AlertTriangle,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  ChevronLeft,
  Play,
  Info,
  RefreshCw,
} from "lucide-react";
import { parseIapItemsXlsx } from "@/lib/iap-management/parsers/iap-items";
import {
  appleIapTemplateSpec,
  APPLE_LOCALE_OPTIONS,
} from "@/lib/iap-management/parsers/template-spec";
import { DownloadTemplateButton } from "@/components/ui/shared/DownloadTemplateButton";
import type { ParsedIapItem, IapItemsParseResult } from "@/lib/iap-management/parsers/iap-items";
import { summarizeAppleError } from "@/lib/iap-management/bulk-import/apple-error-summary";
import { TerritoryAvailabilityPicker } from "@/components/iap-management/territory/TerritoryAvailabilityPicker";
import { bulkSurfaceDefaultSelection } from "@/lib/iap-management/apple/availability-surface-defaults";
import type { TerritorySelection } from "@/lib/iap-management/apple/territory-selection";
import type { TerritoriesRouteResponse } from "@/app/api/iap-management/territories/route";
import { ExpandableErrorCell } from "@/components/ui/shared/ExpandableErrorCell";
import {
  stageMapHasFindings,
  formatStageMap,
} from "@/lib/iap-management/bulk-import/stage-map-view";
import type { RowStages } from "@/lib/iap-management/bulk-import/row-outcome";
import {
  conflictRowNote,
  type LastImportByProductId,
} from "@/lib/iap-management/queries/last-import";
import {
  matchScreenshotToProductId,
  type ScreenshotMatchResult,
} from "@/lib/iap-management/parsers/screenshot-matcher";
import {
  resolveConflicts,
  enrichWithTiers,
  type ConflictMode,
  type ConflictDecision,
  type ResolveResult,
} from "@/lib/iap-management/bulk-import/conflict-resolution";
import { computeWillSubmitCount } from "@/lib/iap-management/bulk-import/will-submit";
import {
  bulkImportToastSeverity,
  hasNonRenewingSub,
} from "@/lib/iap-management/bulk-import/result-hints";
import {
  formatTierWithPrice,
  type UsdTierEntry,
} from "@/lib/iap-management/queries/price-tiers";
import {
  PricingSourceSelector,
  defaultPricingSource,
} from "@/components/iap-management/iap-form/PricingSourceSelector";
import type { PricingOutcome } from "@/lib/iap-management/apple/pricing-orchestration";
import type {
  PerIapResult,
  ExecuteSummary,
} from "@/app/api/iap-management/apps/[appId]/bulk-import/execute/route";
import type { PricingSourceKind } from "@/lib/iap-management/validation";

interface Props {
  appId: string;
  appName: string;
  existingProductIds: string[];
  /** C-3 — last bulk-import verdict per product. ⚠ A product ABSENT from this
   *  map has never come through bulk import, which is NOT the same as "it
   *  went fine". Optional so callers predating C-3 still compile. */
  lastImportByProductId?: LastImportByProductId;
  /** Cycle 43: per-source USA/USD tier lists. The active list is selected by
   *  `pricingSource` so preview tier-resolution reads the SAME source the
   *  matrix + /execute read (template tables for the template sources, the
   *  legacy USA/USD cache for APPLE). Keyed by PricingSourceKind. */
  usdTiersBySource: Record<PricingSourceKind, UsdTierEntry[]>;
  /** IAP.p1.g: Manager-uploaded global Default Template availability. */
  defaultTemplateAvailable?: boolean;
  /** IAP.p1.g: this app has its own pricing template. */
  appTemplateAvailable?: boolean;
  defaultTemplateEntryCount?: number;
  appTemplateEntryCount?: number;
}

/** SC7 inserted "Territories" as step 4; Result moved to 5. */
type Step = 1 | 2 | 3 | 4 | 5;

interface ScreenshotEntry {
  file: File;
  match: ScreenshotMatchResult;
}

interface RateLimitCounters {
  rate429_count: number;
  retry_attempts: number;
  backoff_total_ms: number;
  longest_backoff_ms: number;
}

interface ExecuteResult {
  batch_id: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** C2 — rows the batch never dispatched (Apple 429 survived retry).
   *  Optional so an older server response still renders. */
  not_attempted?: number;
  /** C3 — rows written to Apple with at least one stage missing. Optional
   *  for the same reason as `not_attempted`: a server predating C3 omits it.
   *  ⚠ Typed from the server's own summary rather than hand-written
   *  `number` — this file has already been bitten twice by a client type
   *  drifting from the route it mirrors. */
  partial?: ExecuteSummary["partial"];
  results: Array<{
    product_id: string;
    /**
     * ⚠ DERIVED, AND IT HAD ALREADY DRIFTED. This was hand-written as
     * `"SUCCESS" | "ERROR" | "SKIPPED"` and was never updated when C2 added
     * `NOT_ATTEMPTED` — TypeScript narrows a wider server value into a
     * narrower client type across a `fetch` boundary without complaint, so
     * the row simply arrived carrying a value this union said was
     * impossible. Third instance of this bug in the arc ([PRICING-429] found
     * three copies of `PricingOutcome["kind"]`), hence the derivation.
     */
    status: PerIapResult["status"];
    /** C3 — per-stage map + one readable sentence. Rendered in chunk B. */
    stages?: PerIapResult["stages"];
    summary?: PerIapResult["summary"];
    disposition: string;
    apple_iap_id?: string;
    error?: string;
    /** Uncapped counterpart to `error` — the complete Apple response body
     *  (or full error message), never sliced. Feeds the expandable Notes
     *  detail view; `error` itself stays capped for backward compat. */
    error_full?: string;
    error_http_status?: number;
    stage?: string;
    failed_locales?: string[];
    screenshot_uploaded?: boolean;
    /** IAP.o.8a — OVERWRITE-only outcome for the screenshot path. */
    screenshot_note?:
      | "replaced"
      | "uploaded-new"
      | "no-file"
      | "delete-locked"
      | "failed";
    /** IAP.o.9a + IAP.o.10a — pricing schedule outcome (CREATE always,
     *  OVERWRITE only when resolved tier differs from cached). */
    price_schedule_set?: boolean;
    /**
     * ⚠ DERIVED, AND IT HAD ALREADY DRIFTED. This was a hand-written list
     * that omitted `partial-custom-fail` — a kind the server has been able
     * to return since the custom-prices arc. Nothing failed: TypeScript is
     * happy to narrow a wider server value into a narrower client type at a
     * `fetch` boundary, so the row simply arrived with a value this union
     * said was impossible. A union that must track another union has to be
     * derived from it, or it tracks nothing.
     */
    pricing_outcome?: PricingOutcome["kind"];
    pricing_error?: string;
    /** Problem 2 fix: territories whose template override found no Apple
     *  price-point match on a `partial-template-fail` (base + matched
     *  territories DID apply; these fell back to Apple auto-equalization). */
    pricing_missing?: Array<{ territory_code: string; customer_price: number }>;
    submitted?: boolean;
    /** IAP.q.2 — set whenever submit was attempted. "deferred" means the
     *  post-screenshot state guard didn't observe READY_TO_SUBMIT (created
     *  row stays valid, submittable later via Submit Selected); "failed"
     *  means Apple rejected the submit call itself after the guard passed. */
    submit_outcome?: "submitted" | "deferred" | "failed";
    submit_deferred_state?: string;
    submit_error?: string;
    /** Uncapped counterpart to `submit_error` — never sliced. */
    submit_error_full?: string;
    submit_error_http_status?: number;
    /** Hotfix 26 — per-row 429 telemetry attached by the route. Absent
     *  on rows that never touched Apple (SKIP / validation ERROR). */
    rate_limit?: RateLimitCounters;
  }>;
  /** Hotfix 26 — batch-level 429 telemetry roll-up. */
  rate_limit_total?: RateLimitCounters & { rows_throttled: number };
}

export function BulkImportWizard({
  appId,
  appName,
  existingProductIds,
  lastImportByProductId,
  usdTiersBySource,
  defaultTemplateAvailable = false,
  appTemplateAvailable = false,
  defaultTemplateEntryCount,
  appTemplateEntryCount,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  /**
   * SC7 — the batch's territory selection. ONE selection for every row: the
   * Manager's decision was batch-level, so there is deliberately no per-row
   * override anywhere in this wizard.
   */
  const [territoryIds, setTerritoryIds] = useState<string[] | null>(null);
  const [territoriesError, setTerritoriesError] = useState<string | null>(null);
  const [availabilitySelection, setAvailabilitySelection] =
    useState<TerritorySelection | null>(null);

  /**
   * Catalogue fetched when the Territories step is first reached — the SAME
   * lazy route surface A uses (added in SC6p1), so there is no new API surface
   * and nothing is paid by a Manager who abandons the wizard at step 1.
   *
   * ⚠ This is the display source; the execute route independently resolves the
   * catalogue once per batch for the write. Both read `getAllTerritoryIds`, so
   * "N of 175" describes the same list Apple receives.
   */
  useEffect(() => {
    if (step !== 4 || territoryIds || territoriesError) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/iap-management/territories");
        const data = (await res.json()) as TerritoriesRouteResponse;
        if (cancelled) return;
        if (data.error || data.territoryIds.length === 0) {
          setTerritoriesError("Could not load Apple's country and region list.");
          return;
        }
        setTerritoryIds(data.territoryIds);
        // Surface B defaults to ALL (Manager decision 2), via the shared policy
        // so B and C cannot silently converge.
        setAvailabilitySelection(bulkSurfaceDefaultSelection(data.territoryIds));
      } catch (err) {
        if (!cancelled) {
          setTerritoriesError(
            err instanceof Error ? err.message : "Network error",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, territoryIds, territoriesError]);
  // IAP.p1.g: batch-level pricing source (Q-E). Initialised to the most
  // specific available source per Q-D and applied to every CREATE/OVERWRITE
  // row in the execute call.
  const [pricingSource, setPricingSource] = useState<PricingSourceKind>(() =>
    defaultPricingSource(defaultTemplateAvailable, appTemplateAvailable),
  );

  // Cycle 43: the USA/USD tier list ACTIVE for the selected pricing source.
  // Changing the source swaps this list, which (a) is in the `resolved`
  // useMemo deps below so dispositions recompute, and (b) flows into the
  // Step 3 TierCell candidate dropdown. This is the heart of the cross-path
  // fix: the gate now resolves tiers from the SAME source the orchestrator
  // applies them from.
  const usdTiers = usdTiersBySource[pricingSource] ?? usdTiersBySource.APPLE ?? [];
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<IapItemsParseResult | null>(null);
  const [screenshots, setScreenshots] = useState<ScreenshotEntry[]>([]);
  const [conflictMode, setConflictMode] = useState<ConflictMode>("OVERWRITE");
  const [overrides, setOverrides] = useState<Record<string, ConflictMode>>({});
  /** Per-productId tier override (Manager IAP.o.5 Issue C). Wins over the
   *  auto-resolved tier from enrichWithTiers; surfaces to /execute as
   *  `tier_overrides` so the server applies the same picked tier. */
  const [tierOverrides, setTierOverrides] = useState<Record<string, string>>({});
  const [submitOnCreate, setSubmitOnCreate] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecuteResult | null>(null);

  // Hub tracking (VNGGames Hub run-tracking integration). RUN_ID lives only
  // in wizard client state — no server-side persistence. null means either
  // tracking isn't configured/enabled, or the start call failed — both
  // cases are treated identically (no-op) everywhere it's threaded.
  const [hubRunId, setHubRunId] = useState<string | null>(null);
  // Ref so the beforeunload listener (registered once) always reads the
  // LATEST hubRunId without re-binding the listener on every render.
  const hubRunIdRef = useRef<string | null>(hubRunId);
  useEffect(() => {
    hubRunIdRef.current = hubRunId;
  });

  // PERMANENT flag — set true the instant handleExecute is invoked and NEVER
  // reset back to false. This is deliberately NOT the same thing as
  // `executing`: `executing` is transient and flips back to false in
  // handleExecute's `finally` regardless of outcome — success, failure, OR
  // a client-side hiccup reading/parsing the response AFTER the server has
  // already closed the run. Using `executing` (or `step < 4`, which only
  // ever reaches 4 via the success branch) as the cancel-on-exit guard left
  // a window open: once the execute request settled for ANY reason,
  // `executing` went back to `false` while `step` could still be < 4 (any
  // non-success response, or a response the client failed to parse) — and
  // a SUBSEQUENT exit/tab-close would then fire a spurious CANCELLED,
  // overwriting whatever real terminal status (including SUCCESS) the
  // server's own `finally` had already recorded for that run. Once execute
  // has been submitted, the server owns the run's terminal status, full
  // stop — the client must never send cancel for it again.
  const executeStartedRef = useRef(false);

  useEffect(() => {
    function handleBeforeUnload() {
      const runId = hubRunIdRef.current;
      // Best-effort only — doesn't catch hard crashes/force-quit. Skipped
      // once execute has ever been invoked: the execute route's own
      // `finally` owns closing the run from that point on, regardless of
      // what happens client-side afterward.
      if (runId && !executeStartedRef.current) {
        const blob = new Blob([JSON.stringify({ run_id: runId })], {
          type: "application/json",
        });
        navigator.sendBeacon("/api/iap-management/hub-tracking/cancel", blob);
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  function handleNext() {
    if (step === 1) {
      // Fires on the step 1→2 transition. Best-effort, never awaited —
      // never delays advancing the wizard. Config unconfigured/disabled or
      // any Hub failure both resolve server-side to `{ run_id: null }`.
      fetch("/api/iap-management/hub-tracking/start", { method: "POST" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { run_id?: string } | null) => {
          if (!data || typeof data.run_id !== "string") return;
          if (executeStartedRef.current) {
            // The user raced through the wizard fast enough that execute
            // was already submitted (with an empty hub_run_id — this run
            // never got threaded through) before this slow `start` response
            // arrived. The server will never close this run; best-effort
            // close it now instead of adopting it into state, rather than
            // leaving it RUNNING forever.
            fetch("/api/iap-management/hub-tracking/cancel", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ run_id: data.run_id }),
            }).catch(() => {});
            return;
          }
          setHubRunId(data.run_id);
        })
        .catch(() => {
          // Swallowed — tracking is purely additive instrumentation.
        });
    }
    setStep((s) => ((s + 1) as Step));
  }

  function handleExit() {
    // Explicit back-out — cancel ONLY if execute was never invoked. Once it
    // has been, the server's own `finally` owns the terminal status
    // (SUCCESS/FAILED/PARTIAL) regardless of what happens client-side after
    // that point. No-ops server-side if hubRunId is null.
    if (hubRunId && !executeStartedRef.current) {
      fetch("/api/iap-management/hub-tracking/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: hubRunId }),
        keepalive: true,
      }).catch(() => {
        // Swallowed — best-effort, mirrors the non-blocking discipline.
      });
    }
    router.push(`/iap-management/apps/${appId}`);
  }

  const existingSet = useMemo(
    () => new Set(existingProductIds),
    [existingProductIds],
  );

  const resolved: ResolveResult | null = useMemo(() => {
    if (!parsed) return null;
    const conflicts = resolveConflicts({
      parsed: parsed.items,
      existing_product_ids: existingSet,
      default_mode: conflictMode,
      overrides,
    });
    return enrichWithTiers(conflicts, usdTiers);
    // `usdTiers` is the per-source active list; `pricingSource` is listed
    // explicitly so switching the source selector recomputes dispositions
    // even if the list reference were ever memoised upstream (Cycle 43
    // regression guard — pre-fix the selector had no effect on preview).
    // exhaustive-deps flags pricingSource as redundant today (usdTiers
    // already changes with it); the extra dep is the deliberate guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, existingSet, conflictMode, overrides, usdTiers, pricingSource]);

  const typeColumnPopulated = useMemo(() => {
    if (!parsed) return { fromColumn: 0, defaulted: 0 };
    let fromColumn = 0;
    let defaulted = 0;
    for (const it of parsed.items) {
      if (it.type_source === "COLUMN") fromColumn++;
      else defaulted++;
    }
    return { fromColumn, defaulted };
  }, [parsed]);

  function toggleOverride(productId: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      const current =
        next[productId] ?? conflictMode;
      next[productId] = current === "OVERWRITE" ? "SKIP" : "OVERWRITE";
      return next;
    });
  }

  async function handleExecute() {
    if (!excelFile || !resolved) return;
    // Permanent — from this point on the server owns the run's terminal
    // status; the client must never send cancel for it again (see
    // executeStartedRef's definition above for why `executing` alone isn't
    // a sufficient guard).
    executeStartedRef.current = true;
    setExecuting(true);
    try {
      const fd = new FormData();
      fd.append("excel", excelFile);
      for (const entry of screenshots) {
        fd.append(`screenshot:${entry.file.name}`, entry.file);
      }
      fd.append(
        "config",
        JSON.stringify({
          default_mode: conflictMode,
          overrides,
          tier_overrides: tierOverrides,
          submit_on_create: submitOnCreate,
          pricing_source: pricingSource,
          // SC7 — the batch's ONE selection, ids verbatim. Absent would make
          // the route fall back to ALL, so it is always sent explicitly.
          availability_selection: availabilitySelection,
        }),
      );
      // Threaded to the execute route's `finally` block, which closes the
      // Hub run with the batch's terminal status. Empty string when no run
      // was opened (tracking unconfigured/disabled/start failed) — the
      // route treats that identically to a missing field (no-op).
      fd.append("hub_run_id", hubRunId ?? "");

      const res = await fetch(
        `/api/iap-management/apps/${appId}/bulk-import/execute`,
        { method: "POST", body: fd },
      );
      const data = (await res.json()) as ExecuteResult | { error: string };
      if (!res.ok) {
        toast.error("error" in data ? data.error : `Execute failed (${res.status})`);
        return;
      }
      if ("succeeded" in data) {
        setResult(data);
        setStep(5);
        const msg = `${data.succeeded} created · ${data.skipped} skipped · ${data.failed} failed`;
        // IAP.o.7c — failed rows now escalate to error toast (previously
        // .warning, which Manager missed during MV30). Success path
        // unchanged when no rows failed.
        if (bulkImportToastSeverity(data) === "success") toast.success(msg);
        else toast.error(msg);
        router.refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setExecuting(false);
    }
  }

  // Cycle 43: emptiness is now per-source — reflect the SELECTED source so
  // the remediation hint points at the right place (legacy tier cache for
  // APPLE, the relevant template upload for the template sources).
  const tiersEmpty = usdTiers.length === 0;

  return (
    <div className="space-y-6">
      {/* Wizard header — the template download lives HERE so it is
          visible at every step (Manager UAT: the in-card placement was
          too buried). Same shared component as the apps-list page. */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleExit}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition"
        >
          <ChevronLeft className="h-4 w-4" />
          IAPs · {appName || appId}
        </button>
        <DownloadTemplateButton
          localeOptions={APPLE_LOCALE_OPTIONS}
          getSpec={appleIapTemplateSpec}
          confirmClassName="inline-flex items-center gap-1.5 rounded-md bg-[#0071E3] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0062c4] disabled:opacity-60"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#0071E3]/30 px-2.5 py-1.5 text-xs font-medium text-[#0071E3] transition hover:bg-blue-50 disabled:opacity-60 dark:hover:bg-slate-800"
        />
      </div>

      {tiersEmpty && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <p className="font-medium">
            No USA/USD tiers for the selected pricing source.
          </p>
          <p className="text-xs mt-0.5">
            Tier resolution reads the active pricing source. Bulk-import rows
            will downgrade to <span className="font-mono">ERROR</span> until{" "}
            {pricingSource === "APPLE" ? (
              <>
                tiers are imported via{" "}
                <a
                  href="/iap-management/settings/pricing-tiers"
                  className="underline hover:text-amber-700 dark:hover:text-amber-100"
                >
                  Settings → Pricing Tiers
                </a>
              </>
            ) : pricingSource === "DEFAULT_TEMPLATE" ? (
              <>
                a Default Template is uploaded via{" "}
                <a
                  href="/iap-management/settings/pricing-tiers"
                  className="underline hover:text-amber-700 dark:hover:text-amber-100"
                >
                  Settings → Pricing Templates
                </a>
              </>
            ) : (
              <>this app&apos;s pricing template is uploaded on its detail page</>
            )}
            . You can also switch the pricing source below.
          </p>
        </div>
      )}

      <Stepper step={step} />

      {step === 1 && (
        <Step1Excel
          file={excelFile}
          parsed={parsed}
          typeColumnPopulated={typeColumnPopulated}
          onParsed={(file, parseResult) => {
            setExcelFile(file);
            setParsed(parseResult);
          }}
          onClear={() => {
            setExcelFile(null);
            setParsed(null);
          }}
        />
      )}

      {step === 2 && parsed && (
        <Step2Screenshots
          parsedItems={parsed.items}
          screenshots={screenshots}
          onAdd={(files) => {
            const candidateIds = parsed.items.map((i) => i.product_id);
            const next: ScreenshotEntry[] = files.map((file) => ({
              file,
              match: matchScreenshotToProductId(file.name, candidateIds),
            }));
            setScreenshots((prev) => {
              const seen = new Set(prev.map((p) => p.file.name));
              const dedup = next.filter((n) => !seen.has(n.file.name));
              return [...prev, ...dedup];
            });
          }}
          onRemove={(filename) =>
            setScreenshots((prev) => prev.filter((p) => p.file.name !== filename))
          }
        />
      )}

      {step === 3 && resolved && parsed && (
        <Step3Preview
          decisions={resolved.decisions}
          counts={resolved.counts}
          conflictMode={conflictMode}
          onConflictModeChange={setConflictMode}
          onToggleOverride={toggleOverride}
          overrides={overrides}
          existingSet={existingSet}
          lastImportByProductId={lastImportByProductId ?? {}}
          screenshots={screenshots}
          submitOnCreate={submitOnCreate}
          onSubmitOnCreateChange={setSubmitOnCreate}
          parsedSkippedLocales={parsed.skipped_locales}
          usdTiers={usdTiers}
          tierOverrides={tierOverrides}
          pricingSource={pricingSource}
          onPricingSourceChange={setPricingSource}
          defaultTemplateAvailable={defaultTemplateAvailable}
          appTemplateAvailable={appTemplateAvailable}
          defaultTemplateEntryCount={defaultTemplateEntryCount}
          appTemplateEntryCount={appTemplateEntryCount}
          onTierOverride={(productId, tier_id) =>
            setTierOverrides((prev) => ({ ...prev, [productId]: tier_id }))
          }
        />
      )}

      {/* SC7 — step 4 is Territories; the batch's ONE selection. */}
      {step === 4 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 pt-5 pb-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Where these {resolved ? resolved.counts.create + resolved.counts.overwrite : 0} items can be sold
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              One selection is applied to every item in this import. There is no
              per-item override here — pick it once, and edit individual items
              afterwards if you need to.
            </p>
          </div>
          {territoriesError ? (
            /* No real catalogue ⇒ no picker (SC5/SC6 precedent). An empty
               selection posted would remove every new item from sale. */
            <p
              data-testid="bulk-territories-load-error"
              className="mx-5 mb-5 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3 text-[11px] text-amber-900 dark:text-amber-200"
            >
              {territoriesError} Territories cannot be chosen right now. Go back
              and retry — importing without a real list would risk removing
              every new item from sale.
            </p>
          ) : !territoryIds || !availabilitySelection ? (
            <p className="mx-5 mb-5 flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading countries and
              regions…
            </p>
          ) : (
            <div className="flex flex-col max-h-[52vh]">
              <TerritoryAvailabilityPicker
                territoryIds={territoryIds}
                value={availabilitySelection}
                onChange={setAvailabilitySelection}
              />
            </div>
          )}
        </div>
      )}

      {step === 5 && result && (
        <Step4Result
          result={result}
          appId={appId}
          appName={appName}
          batchHasNrs={parsed ? hasNonRenewingSub(parsed.items) : false}
          pricingSource={pricingSource}
        />
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
          disabled={step === 1 || step === 5 || executing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 disabled:opacity-40 transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {step < 4 && (
          <button
            type="button"
            onClick={handleNext}
            disabled={
              // items.length === 0 covers the unedited-template case: all
              // rows were skipped as samples — nothing to import.
              (step === 1 && (!parsed || parsed.items.length === 0)) ||
              // Step 3 → 4 always allowed; the Territories step gates Execute.
              executing
            }
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40"
          >
            Next
            <ArrowRight className="h-4 w-4" />
          </button>
        )}

        {step === 4 && (
          <button
            type="button"
            onClick={handleExecute}
            disabled={
              executing ||
              !resolved ||
              resolved.counts.create + resolved.counts.overwrite === 0 ||
              // ⚠ No catalogue ⇒ no execute. Posting without a real selection
              // would fall back to a list nobody chose.
              !availabilitySelection ||
              territoriesError !== null
            }
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40"
          >
            {executing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {executing
              ? "Importing…"
              : `Execute (${(resolved?.counts.create ?? 0) + (resolved?.counts.overwrite ?? 0)} IAPs)`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Stepper ────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const labels = ["Excel", "Screenshots", "Preview", "Territories", "Result"];
  return (
    <div className="flex items-center gap-2">
      {labels.map((label, idx) => {
        const n = (idx + 1) as Step;
        const active = step === n;
        const done = step > n;
        return (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition ${
                done
                  ? "bg-emerald-500 text-white"
                  : active
                    ? "bg-[#0071E3] text-white"
                    : "bg-slate-200 text-slate-500"
              }`}
            >
              {done ? "✓" : n}
            </div>
            <span
              className={`text-xs ${active ? "font-medium text-slate-900" : "text-slate-500"}`}
            >
              {label}
            </span>
            {n < 4 && (
              <span className="h-px w-8 bg-slate-200 ml-1" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Excel ──────────────────────────────────────────────────────────

function Step1Excel({
  file,
  parsed,
  typeColumnPopulated,
  onParsed,
  onClear,
}: {
  file: File | null;
  parsed: IapItemsParseResult | null;
  typeColumnPopulated: { fromColumn: number; defaulted: number };
  onParsed: (file: File, result: IapItemsParseResult) => void;
  onClear: () => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    },
    multiple: false,
    onDrop: async (accepted) => {
      const f = accepted[0];
      if (!f) return;
      setParsing(true);
      setError(null);
      try {
        const result = await parseIapItemsXlsx(f);
        onParsed(f, result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Parse failed");
      } finally {
        setParsing(false);
      }
    },
  });

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Step 1 — Upload Excel template
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        Get the template via <strong>Download template</strong> (top right,
        also on the Apps page), fill in the &quot;IAP Items&quot; sheet (one
        product per row — see the Notes sheet), and drop the .xlsx here.
      </p>

      {!parsed && (
        <div
          {...getRootProps()}
          className={`rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition ${
            isDragActive
              ? "border-[#0071E3] bg-blue-50"
              : parsing
                ? "border-slate-300 bg-slate-50 cursor-wait"
                : "border-slate-300 hover:border-slate-400 bg-slate-50"
          }`}
        >
          <input {...getInputProps()} />
          {parsing ? (
            <Loader2 className="mx-auto h-7 w-7 text-[#0071E3] mb-2 animate-spin" />
          ) : (
            <FileSpreadsheet className="mx-auto h-7 w-7 text-slate-400 mb-2" />
          )}
          <p className="text-sm font-medium text-slate-700">
            {parsing
              ? "Parsing…"
              : isDragActive
                ? "Drop the .xlsx here"
                : "Drag & drop or click to select an .xlsx"}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Strict header validation per IAP.e parsers.
          </p>
        </div>
      )}

      {parsed && file && (
        <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle className="h-5 w-5 text-emerald-600" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-800 truncate">
                {file.name}
              </p>
              <p className="text-[11px] text-emerald-700">
                {parsed.items.length} IAPs · {parsed.locale_pair_count} locale pairs detected
              </p>
              {parsed.sample_rows_skipped.length > 0 && (
                <p className="text-[11px] text-amber-700 font-medium">
                  {parsed.sample_rows_skipped.length} example row(s) skipped —
                  delete the sample rows or replace them with your data.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] text-emerald-700 hover:underline"
            >
              Replace
            </button>
          </div>
          <p className="mt-1 text-[11px] text-emerald-700">
            Type source: <strong>{typeColumnPopulated.fromColumn}</strong> from
            column, <strong>{typeColumnPopulated.defaulted}</strong> defaulted
            to Consumable.
          </p>
          {parsed.warnings.length > 0 && (
            <div className="mt-2 text-[11px] text-amber-700">
              {parsed.warnings.length} parse warning(s) — open with caution.
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </section>
  );
}

// ─── Step 2: Screenshots ────────────────────────────────────────────────────

function Step2Screenshots({
  parsedItems,
  screenshots,
  onAdd,
  onRemove,
}: {
  parsedItems: ParsedIapItem[];
  screenshots: ScreenshotEntry[];
  onAdd: (files: File[]) => void;
  onRemove: (filename: string) => void;
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] },
    multiple: true,
    onDrop: onAdd,
  });

  const matchedProductIds = new Set(
    screenshots
      .filter((s) => s.match.kind === "matched")
      .map((s) =>
        s.match.kind === "matched" ? s.match.productId : "",
      ),
  );
  const unmatchedFiles = screenshots.filter((s) => s.match.kind !== "matched");
  const productsWithoutScreenshot = parsedItems
    .map((i) => i.product_id)
    .filter((id) => !matchedProductIds.has(id));

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Step 2 — Upload review screenshots
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        Multi-file drop. Filenames auto-match to productId — both literal and
        dots-as-underscores forms accepted (Q-IAP convention C).
      </p>

      <div
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition mb-4 ${
          isDragActive
            ? "border-[#0071E3] bg-blue-50"
            : "border-slate-300 hover:border-slate-400 bg-slate-50"
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-7 w-7 text-slate-400 mb-2" />
        <p className="text-sm font-medium text-slate-700">
          {isDragActive
            ? "Drop screenshots here"
            : "Drag & drop screenshots or click to select"}
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          PNG/JPEG · multi-file
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 text-xs">
        <Tally label="Matched" value={matchedProductIds.size} color="emerald" />
        <Tally
          label="Unmatched"
          value={unmatchedFiles.length}
          color="amber"
        />
        <Tally
          label="Missing"
          value={productsWithoutScreenshot.length}
          color="slate"
        />
      </div>

      {screenshots.length > 0 && (
        <div className="mt-4 max-h-72 overflow-y-auto border border-slate-200 rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
              <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wide">
                <th className="px-3 py-2">Filename</th>
                <th className="px-3 py-2">Matched ProductId</th>
                <th className="px-3 py-2 w-20">Method</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {screenshots.map((s) => (
                <tr key={s.file.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[260px]">
                    {s.file.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {s.match.kind === "matched"
                      ? s.match.productId
                      : s.match.kind === "ambiguous"
                        ? `Ambiguous (${s.match.candidates.length})`
                        : "—"}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-slate-500">
                    {s.match.kind === "matched" ? s.match.method : s.match.kind}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onRemove(s.file.name)}
                      className="text-slate-400 hover:text-red-500 transition"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * ⚠ THE TILES MUST SUM TO `result.total`, so the grid has to widen as new
 * statuses earn tiles rather than the tiles competing for three slots. Keyed
 * by how many conditional tiles are showing; Tailwind needs the class names
 * present as literals, so this is a lookup and not a template string.
 */
const TILE_COLS = ["grid-cols-3", "grid-cols-4", "grid-cols-5"] as const;

function Tally({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "emerald" | "amber" | "slate";
}) {
  const colorClass =
    color === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : color === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-slate-50 text-slate-500";
  return (
    <div className={`border rounded-lg p-3 ${colorClass}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
    </div>
  );
}

// ─── Step 3: Preview ────────────────────────────────────────────────────────

/**
 * ⚠ Exported for tests only, same reason as `Step4Result`: the rule under
 * test — which conflict rows carry a prior-run note — is a property of THIS
 * component, and reaching it through the wizard's four-step navigation would
 * test the navigation instead.
 */
export function Step3Preview({
  decisions,
  counts,
  conflictMode,
  onConflictModeChange,
  onToggleOverride,
  overrides,
  existingSet,
  lastImportByProductId,
  screenshots,
  submitOnCreate,
  onSubmitOnCreateChange,
  parsedSkippedLocales,
  usdTiers,
  tierOverrides,
  onTierOverride,
  pricingSource,
  onPricingSourceChange,
  defaultTemplateAvailable,
  appTemplateAvailable,
  defaultTemplateEntryCount,
  appTemplateEntryCount,
}: {
  decisions: ConflictDecision[];
  counts: ResolveResult["counts"];
  conflictMode: ConflictMode;
  onConflictModeChange: (m: ConflictMode) => void;
  onToggleOverride: (productId: string) => void;
  overrides: Record<string, ConflictMode>;
  existingSet: Set<string>;
  lastImportByProductId: LastImportByProductId;
  screenshots: ScreenshotEntry[];
  submitOnCreate: boolean;
  onSubmitOnCreateChange: (v: boolean) => void;
  parsedSkippedLocales: string[];
  usdTiers: UsdTierEntry[];
  tierOverrides: Record<string, string>;
  onTierOverride: (productId: string, tier_id: string) => void;
  pricingSource: PricingSourceKind;
  onPricingSourceChange: (next: PricingSourceKind) => void;
  defaultTemplateAvailable: boolean;
  appTemplateAvailable: boolean;
  defaultTemplateEntryCount?: number;
  appTemplateEntryCount?: number;
}) {
  const matchedProductIds = new Set(
    screenshots
      .filter((s) => s.match.kind === "matched")
      .map((s) => (s.match.kind === "matched" ? s.match.productId : "")),
  );
  const willSubmitCount = computeWillSubmitCount(
    decisions,
    matchedProductIds,
    submitOnCreate,
  );
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
        Step 3 — Preview &amp; conflict resolution
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
        Toggle per-row to override the global conflict policy. Validation
        errors are excluded and cannot be retried — fix the source data.
      </p>

      {/* Counts */}
      <div className="grid grid-cols-4 gap-3 mb-4 text-xs">
        <Tally label="Create" value={counts.create} color="emerald" />
        <Tally label="Overwrite" value={counts.overwrite} color="amber" />
        <Tally label="Skip" value={counts.skip} color="slate" />
        <Tally label="Error" value={counts.error} color="amber" />
      </div>

      {/* Outcome bifurcation — only show when the Create bucket is non-empty
          so unrelated bulk-only flows (e.g. all-overwrite) don't see noise. */}
      {counts.create > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
          <Tally
            label="Will create only"
            value={counts.create - willSubmitCount}
            color="slate"
          />
          <Tally
            label="Will create + submit"
            value={willSubmitCount}
            color="emerald"
          />
        </div>
      )}

      {/* Global toggles */}
      <div className="flex items-center gap-6 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-700">
            Conflict policy:
          </label>
          <select
            value={conflictMode}
            onChange={(e) =>
              onConflictModeChange(e.target.value as ConflictMode)
            }
            className="rounded-md border border-slate-200 px-2 py-1 text-xs"
          >
            <option value="OVERWRITE">Overwrite</option>
            <option value="SKIP">Skip</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={submitOnCreate}
            onChange={(e) => onSubmitOnCreateChange(e.target.checked)}
          />
          Submit to Apple Review after create
        </label>
      </div>

      {/* IAP.p1.g: batch-level pricing source (Q-E applies to every row) */}
      <div className="mb-4">
        <PricingSourceSelector
          value={pricingSource}
          onChange={onPricingSourceChange}
          defaultTemplateAvailable={defaultTemplateAvailable}
          appTemplateAvailable={appTemplateAvailable}
          defaultTemplateEntryCount={defaultTemplateEntryCount}
          appTemplateEntryCount={appTemplateEntryCount}
        />
      </div>

      {parsedSkippedLocales.length > 0 && (
        <p className="text-[11px] text-amber-700 mb-3">
          Unrecognised locale columns skipped: {parsedSkippedLocales.join(", ")}
        </p>
      )}

      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
            <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wide">
              <th className="px-3 py-2">Product ID</th>
              <th className="px-3 py-2">Reference Name</th>
              <th className="px-3 py-2 w-32">Type</th>
              <th className="px-3 py-2 w-24">Tier</th>
              <th className="px-3 py-2 w-14">Loc</th>
              <th className="px-3 py-2 w-14">Scr</th>
              <th className="px-3 py-2 w-24">Disposition</th>
              <th className="px-3 py-2 w-20">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {decisions.map((d) => {
              const localesFilled = d.source.localizations.length;
              const screenshotPresent = matchedProductIds.has(d.product_id);
              const isConflict = existingSet.has(d.product_id);
              const overridden = overrides[d.product_id];
              // ⚠ C-3 — WHY THIS PRODUCT ALREADY EXISTS, not just that it
              // does. A product left half-built by a rate-limited batch and a
              // product that finished cleanly present as the SAME conflict
              // row, and the Manager picks a ConflictMode from that row. The
              // rule lives in `conflictRowNote` rather than in this ternary
              // because it has exactly one way to go wrong — reading "no
              // record" as "it went fine" — and that deserves a test, not a
              // reader's care.
              const priorNote = isConflict
                ? conflictRowNote(lastImportByProductId[d.product_id])
                : null;
              return (
                <tr key={d.product_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700 align-top">
                    {d.product_id}
                    {priorNote && (
                      <span
                        className="mt-1 flex items-start gap-1 font-sans text-[10px] leading-snug text-amber-800 dark:text-amber-300"
                        title="From the most recent bulk import of this product. The full per-stage detail is in the audit log."
                      >
                        <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
                        <span>{priorNote}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 truncate max-w-[200px] align-top">
                    {d.source.reference_name}
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    <span className="text-slate-700">
                      {d.source.type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span
                      className={`ml-1.5 text-[9px] px-1 py-0.5 rounded ${
                        d.source.type_source === "COLUMN"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {d.source.type_source.toLowerCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[11px]">
                    <TierCell
                      productId={d.product_id}
                      priceUsd={d.source.price_usd}
                      autoTierId={d.resolved_tier_id ?? null}
                      overrideTierId={tierOverrides[d.product_id]}
                      usdTiers={usdTiers}
                      onChange={(t) => onTierOverride(d.product_id, t)}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">{localesFilled}</td>
                  <td className="px-3 py-2 text-center">
                    {screenshotPresent ? (
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-600 inline" />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <DispositionBadge disposition={d.disposition} />
                  </td>
                  <td className="px-3 py-2">
                    {isConflict && d.disposition !== "ERROR" ? (
                      <button
                        type="button"
                        onClick={() => onToggleOverride(d.product_id)}
                        className="text-[11px] text-[#0071E3] hover:underline"
                      >
                        {overridden ?? conflictMode}
                      </button>
                    ) : (
                      <span className="text-[10px] text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Per-row tier cell (Manager IAP.o.5 Issue C). Shows the auto-resolved tier
 * with its USD price ("Tier 1 ($0.99)") and, when 2+ tiers share the same
 * USD price (theoretical e.g. TIER_5 vs ALT_5 both at $4.99), surfaces a
 * dropdown so Manager can pick the intended tier. Override persists into
 * `tier_overrides` config sent to /execute.
 */
function TierCell({
  priceUsd,
  autoTierId,
  overrideTierId,
  usdTiers,
  onChange,
}: {
  productId: string;
  priceUsd: number;
  autoTierId: string | null;
  overrideTierId: string | undefined;
  usdTiers: UsdTierEntry[];
  onChange: (tier_id: string) => void;
}) {
  // Candidates = all tiers matching the row's price.
  const candidates = useMemo(() => {
    if (priceUsd === 0) {
      return usdTiers.filter((t) => t.tier_id === "FREE");
    }
    return usdTiers.filter((t) => t.customer_price === priceUsd);
  }, [priceUsd, usdTiers]);

  const selected = overrideTierId ?? autoTierId;
  const ambiguous = candidates.length > 1;

  if (!selected) {
    return <span className="text-amber-600 dark:text-amber-400">—</span>;
  }

  if (!ambiguous) {
    return (
      <span className="font-mono text-slate-700 dark:text-slate-300">
        {formatTierWithPrice(selected, priceUsd)}
      </span>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full text-[11px] font-mono rounded border px-1.5 py-0.5 transition ${
        overrideTierId
          ? "border-[#0071E3] bg-blue-50 dark:bg-blue-950/40 text-[#0071E3]"
          : "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200"
      }`}
      title={`Same USD price matches ${candidates.length} tiers — pick one`}
    >
      {candidates.map((c) => (
        <option key={c.tier_id} value={c.tier_id}>
          {formatTierWithPrice(c.tier_id, c.customer_price)}
        </option>
      ))}
    </select>
  );
}

function DispositionBadge({ disposition }: { disposition: string }) {
  const colors: Record<string, string> = {
    CREATE: "bg-emerald-50 text-emerald-700 border-emerald-200",
    OVERWRITE: "bg-amber-50 text-amber-700 border-amber-200",
    SKIP: "bg-slate-100 text-slate-600 border-slate-200",
    ERROR: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${colors[disposition] ?? colors.SKIP}`}
    >
      {disposition.toLowerCase()}
    </span>
  );
}

// ─── Step 4: Result ─────────────────────────────────────────────────────────

/**
 * ⚠ Exported for tests only — the wizard renders it internally. The tile
 * arithmetic ("the tiles sum to total") and the stage-map disclosure are
 * properties of THIS component, not of the badges it contains, and there is
 * no other seam to assert them through.
 */
export function Step4Result({
  result,
  appId,
  appName,
  batchHasNrs,
  pricingSource,
}: {
  result: ExecuteResult;
  appId: string;
  appName: string;
  batchHasNrs: boolean;
  pricingSource: PricingSourceKind;
}) {
  // IAP.o.7c — auto-scroll to the first ERROR row when the batch had any
  // failures. Manager MV30 surfaced that warning toasts + small "Failed"
  // tally counters are easy to miss; the table is 420px scrollable so
  // failures past the fold went unnoticed. Scroll-into-view of the first
  // failure row + the escalated error toast together make failures
  // unmissable.
  // ⚠ `?? 0` so a response predating C2 renders exactly as it does today
  // (three tiles, no banner) instead of "undefined not sent".
  const notAttempted = result.not_attempted ?? 0;
  // ⚠ Same `?? 0` reasoning as above, one release later: a response predating
  // C3 has no `partial`, and must render as the run it describes rather than
  // growing an empty tile.
  const partial = result.partial ?? 0;

  const firstErrorRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (result.failed > 0 && firstErrorRef.current) {
      firstErrorRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [result.failed]);

  const [refreshing, setRefreshing] = useState(false);
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
        inserted_count?: number;
        updated_count?: number;
        errors: string[];
      };
      const parts: string[] = [];
      if (data.inserted_count && data.inserted_count > 0) {
        parts.push(`${data.inserted_count} discovered`);
      }
      if (data.updated_count && data.updated_count > 0) {
        parts.push(`${data.updated_count} state changed`);
      }
      const summary =
        parts.length > 0 ? parts.join(" · ") : `${data.synced_count} refreshed`;
      if (data.errors && data.errors.length > 0) {
        toast.warning(`${summary} · ${data.errors.length} error(s).`);
      } else {
        toast.success(summary);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setRefreshing(false);
    }
  }

  let firstErrorSeen = false;

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">
            Step 4 — Result
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Batch{" "}
            <span className="font-mono text-slate-700">{result.batch_id}</span>{" "}
            completed. Audit rows written to{" "}
            <span className="font-mono">iap_mgmt.actions_log</span>.
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
            Pricing source applied:{" "}
            <span className="font-mono text-slate-700 dark:text-slate-300">
              {pricingSource === "APPLE"
                ? "Apple base"
                : pricingSource === "DEFAULT_TEMPLATE"
                  ? "Default template"
                  : "App-specific template"}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50 flex-shrink-0"
          title="Re-fetch state from Apple to verify ground truth"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh from Apple
        </button>
      </div>

      {batchHasNrs && result.succeeded > 0 && (
        <div
          role="note"
          className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900"
        >
          <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <p>
            <span className="font-medium">NON_RENEWING_SUBSCRIPTION items</span>{" "}
            appear in Apple Connect&apos;s{" "}
            <span className="font-medium">Subscriptions</span> tab, not the{" "}
            <span className="font-medium">In-App Purchases</span> tab. If
            successful rows look missing in App Store Connect, check both tabs.
          </p>
        </div>
      )}

      {/* ⚠ THE TILES MUST SUM TO `result.total`, and before C2 a stopped
          batch broke that silently: every tile reads a server counter rather
          than deriving from `results`, so rows in a status no tile knew about
          simply vanished from the arithmetic. A fourth tile is used rather
          than folding into "Skipped" — those are two different facts and the
          server type keeps them apart for the same reason (see
          PerIapResult.status). The tile is conditional so clean runs keep the
          familiar three-up layout. */}
      <div
        className={`grid gap-3 mb-4 ${
          TILE_COLS[(notAttempted > 0 ? 1 : 0) + (partial > 0 ? 1 : 0)]
        }`}
      >
        <Tally label="Succeeded" value={result.succeeded} color="emerald" />
        {/* ⚠ C3 — ITS OWN TILE, for the reason "Not sent" got one. A PARTIAL
            row is not a success (a stage is missing) and not a failure (the
            IAP is on Apple); folding it into either makes the tile a lie and
            costs the Manager the one number that says "these need a second
            look". Conditional, so a clean run keeps the familiar layout. */}
        {partial > 0 && (
          <Tally label="Partial" value={partial} color="amber" />
        )}
        <Tally label="Skipped" value={result.skipped} color="slate" />
        <Tally label="Failed" value={result.failed} color="amber" />
        {notAttempted > 0 && (
          <Tally label="Not sent" value={notAttempted} color="slate" />
        )}
      </div>

      {notAttempted > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <p className="font-medium">
            Apple&apos;s rate limit stopped this batch early.
          </p>
          <p className="text-[11px] mt-0.5 text-amber-700 dark:text-amber-300/80">
            Nothing was sent to Apple for the {notAttempted} row
            {notAttempted === 1 ? "" : "s"} marked{" "}
            <span className="font-medium">not sent</span> — no IAP was created
            or changed for them. Wait a few minutes and re-run the import with
            those rows; the rows above are unaffected.
          </p>
        </div>
      )}

      {/* Hotfix 26 — Apple rate-limit chip. Renders only when Apple
          actually throttled this batch; suppressed for clean runs so
          the summary stays tight. */}
      {result.rate_limit_total &&
        result.rate_limit_total.rate429_count > 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            {/* ⚠ "every row recovered" WAS A HARD CLAIM, and it stopped being
                true the moment a 429 could survive the retry curve. Hotfix 26
                wrote it when exhaustion had nowhere to be recorded; C2 records
                it, so the sentence has to branch on the data instead of
                asserting the happy case. */}
            <p className="font-medium">
              {notAttempted > 0
                ? "Apple ASC throttled this batch — and the retry budget ran out before it finished."
                : "Apple ASC throttled this batch — every row recovered via exponential backoff."}
            </p>
            <p className="text-[11px] mt-0.5 text-amber-700 dark:text-amber-300/80">
              {result.rate_limit_total.rows_throttled} of {result.total} rows
              hit 429 · {result.rate_limit_total.rate429_count} retries total
              · {Math.round(result.rate_limit_total.backoff_total_ms / 1000)}s
              cumulative backoff · longest{" "}
              {Math.round(result.rate_limit_total.longest_backoff_ms / 1000)}s.
            </p>
          </div>
        )}

      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden max-h-[420px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 sticky top-0">
            <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400 tracking-wide">
              <th className="px-3 py-2">Product ID</th>
              <th className="px-3 py-2 w-24">Status</th>
              <th className="px-3 py-2 w-24">Disposition</th>
              <th className="px-3 py-2 w-32">Outcome</th>
              <th className="px-3 py-2 w-28">Price</th>
              <th className="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {result.results.map((r) => {
              const isError = r.status === "ERROR";
              const attachRef = isError && !firstErrorSeen;
              if (attachRef) firstErrorSeen = true;
              return (
                <tr
                  key={r.product_id}
                  ref={attachRef ? firstErrorRef : undefined}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {r.product_id}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-600">
                    {r.disposition.toLowerCase()}
                  </td>
                  <td className="px-3 py-2">
                    <OutcomeBadge result={r} />
                  </td>
                  <td className="px-3 py-2">
                    <PriceBadge result={r} />
                  </td>
                  <td className="px-3 py-2 text-[11px] text-slate-500 align-top">
                    {/* ⚠ C3 (B3/B4) — GATED ON THE MAP, NOT ON `r.status`.
                        `stageMapHasFindings` asks whether any stage actually
                        failed or went unsent; that is the same population as
                        PARTIAL but arrived at from the evidence, so the cell
                        cannot drift out of agreement with the badge beside
                        it. A clean row falls through to its existing note.
                        The disclosure is the table's own ExpandableErrorCell
                        — same gesture, same per-row state, no new frame. */}
                    {r.stages && stageMapHasFindings(r.stages) ? (
                      <ExpandableErrorCell
                        summary={r.summary ?? "Partially completed."}
                        detail={formatStageMap(r.stages)}
                      />
                    ) : r.error ? (
                      <ExpandableErrorCell
                        summary={
                          summarizeAppleError({
                            raw: r.error_full,
                            fallback: r.error,
                            stage: r.stage,
                            httpStatus: r.error_http_status,
                          }).summary
                        }
                        detail={r.error_full ?? r.error}
                      />
                    ) : r.submit_outcome === "deferred" ? (
                      `Created (${r.apple_iap_id?.slice(0, 12)}…) — Apple reports "${r.submit_deferred_state ?? "unknown"}", not yet READY_TO_SUBMIT. Retry via Submit Selected.`
                    ) : r.submit_outcome === "failed" ? (
                      <ExpandableErrorCell
                        summary={`Created (${r.apple_iap_id?.slice(0, 12)}…) — submit failed: ${
                          summarizeAppleError({
                            raw: r.submit_error_full,
                            fallback: r.submit_error ?? "",
                            httpStatus: r.submit_error_http_status,
                          }).summary
                        }. Retry via Submit Selected.`}
                        detail={r.submit_error_full ?? r.submit_error}
                      />
                    ) : r.failed_locales && r.failed_locales.length > 0 ? (
                      `Failed locales: ${r.failed_locales.join(", ")}`
                    ) : r.screenshot_note === "delete-locked" ? (
                      "Apple wouldn't let us swap the screenshot — IAP is in review or approved. Swap manually in App Store Connect."
                    ) : r.screenshot_note === "failed" ? (
                      "Screenshot upload failed — check the file and re-run the import row."
                    ) : r.apple_iap_id ? (
                      `apple_iap_id ${r.apple_iap_id.slice(0, 12)}…`
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex justify-end">
        <a
          href={`/iap-management/apps/${appId}`}
          className="px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
        >
          Back to {appName || "app"} IAPs
        </a>
      </div>
    </section>
  );
}

/**
 * The stages a CREATE row can be cut off at. `create` is excluded on purpose:
 * a row that never got created is ERROR, not a stopped success, so a stop
 * recorded there would be a contradiction rather than a fact to render.
 */
const CREATE_STOP_STAGES = [
  "localizations",
  "pricing",
  "screenshot",
  "availability",
  "submit",
] as const satisfies readonly (keyof RowStages)[];

export function OutcomeBadge({
  result,
}: {
  result: ExecuteResult["results"][number];
}) {
  // ⚠ PARTIAL EARNS AN OUTCOME. Chunk A shipped with this returning "—" for
  // every row that was not SUCCESS, which meant a row that had been created
  // on Apple, localized and priced showed a dash — under-reporting, but still
  // a lie of omission in the one column a Manager scans. ERROR and the two
  // skips keep the dash: for them nothing landed, so there is nothing to say.
  if (result.status !== "SUCCESS" && result.status !== "PARTIAL") {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  const stages = result.stages;
  // For overwrite path: no submission, but localizations replaced.
  if (result.disposition === "OVERWRITE") {
    // IAP.o.8a — Manager MV30 Issue 1: silent screenshot deferral was the
    // critical loss. The badge now suffixes the screenshot outcome so the
    // happy and locked/failed paths can't be mistaken for each other.
    // ⚠ The map first, the flat field second. `stages.screenshot.note` and
    // `result.screenshot_note` agree today; reading the map means a future
    // stage-only fact cannot go unrendered here.
    const note = stages?.screenshot.note ?? result.screenshot_note;
    let suffix = "";
    let cls = "bg-amber-50 text-amber-700 border-amber-200";
    if (note === "replaced" || note === "uploaded-new") {
      suffix = " · screenshot updated";
      cls = "bg-emerald-50 text-emerald-700 border-emerald-200";
    } else if (note === "delete-locked") {
      suffix = " · screenshot locked";
      cls = "bg-orange-50 text-orange-700 border-orange-200";
    } else if (note === "failed") {
      suffix = " · screenshot failed";
      cls = "bg-red-50 text-red-700 border-red-200";
    }
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${cls}`}
      >
        Overwritten{suffix}
      </span>
    );
  }
  // Create path: bifurcate by submit outcome.
  if (result.submitted) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
        Created + submitted
      </span>
    );
  }
  // IAP.q.2 — submit was attempted but the state guard didn't see
  // READY_TO_SUBMIT yet (Apple propagation lag). Amber, not red: the item
  // was created successfully and remains submittable via Submit Selected.
  if (result.submit_outcome === "deferred") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 text-amber-700 border-amber-200"
        title={`Apple wasn't reporting READY_TO_SUBMIT yet (state="${result.submit_deferred_state ?? "unknown"}"). Submit later via Submit Selected once Apple finishes propagating.`}
      >
        Created — submit deferred
      </span>
    );
  }
  // Guard passed (state WAS READY_TO_SUBMIT) but Apple's submit call itself
  // errored — a genuine failure, distinct from a readiness problem. Still
  // amber, not red ERROR: the created item is valid and retryable.
  if (result.submit_outcome === "failed") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-orange-50 text-orange-700 border-orange-200"
        title={result.submit_error ?? "Apple rejected the submission."}
      >
        Created — submit failed
      </span>
    );
  }
  // ⚠ C3 — "Created only" is the wrong word when the budget cut the row off
  // mid-way: it reads as "nothing more was wanted", not "we stopped". Asked
  // of the MAP, not of `status`, so the branch cannot drift back to guessing.
  if (
    stages &&
    CREATE_STOP_STAGES.some((k) => stages[k].state === "SKIPPED_BY_STOP")
  ) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 text-amber-800 border-amber-300"
        title="Apple's rate-limit budget ran out part-way through this row. Everything marked 'not sent' in Notes was never sent — re-run the row to finish it."
      >
        Created — stopped by rate limit
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-100 text-slate-600 border-slate-200">
      Created only
    </span>
  );
}

/**
 * IAP.o.9a — surfaces the pricing schedule outcome per row. The OVERWRITE
 * path may have `pricing_outcome` absent (cached tier matched, no re-apply
 * needed) — we render a neutral "Unchanged" pill so Manager isn't left
 * guessing whether pricing was attempted.
 */
export function PriceBadge({
  result,
}: {
  result: ExecuteResult["results"][number];
}) {
  if (result.status !== "SUCCESS" && result.status !== "PARTIAL") {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  const stages = result.stages;
  // ⚠ THE BUDGET STOP GETS ITS OWN PILL, BEFORE ANY KIND-BASED BRANCH.
  //
  // When the budget runs out the route synthesises `skipped-not-ready` —
  // reusing the orchestrator's existing "did not run" kind. Routed through
  // the branches below, that renders red "Not ready" with a tooltip blaming
  // Apple's poll window, which never happened. The kind is borrowed; the
  // stage STATE is the fact, so the state is what is asked.
  if (stages?.pricing.state === "SKIPPED_BY_STOP") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 text-amber-800 border-amber-300 border-dashed"
        title="Apple's rate-limit budget ran out before pricing was attempted — nothing was sent. Re-run the row to price it."
      >
        Not sent
      </span>
    );
  }
  // ⚠ The map is authoritative when present. A PARTIAL row whose price DID
  // land must still show "Price set" — that stage succeeded, and hiding it
  // because a LATER stage failed is the under-report chunk A shipped with.
  const outcome = stages?.pricing.outcome ?? result.pricing_outcome;
  if (!outcome) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-50 text-slate-500 border-slate-200"
        title="Local tier matches Apple — no re-apply needed."
      >
        Unchanged
      </span>
    );
  }
  if (outcome === "set") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
        Price set
      </span>
    );
  }
  // Problem 2 fix: partial-template-fail is NOT a failure — the price schedule
  // POST succeeded; the base price + matched territories applied. Only these
  // territories had no Apple price-point match and fell back to Apple's
  // auto-equalization. Amber (not red), and list exactly which territories so
  // the Manager can correct the template (e.g. "MYS @ 12" — Problem 3).
  if (outcome === "partial-template-fail") {
    const missing = result.pricing_missing ?? [];
    const detail =
      missing.length > 0
        ? missing
            .map((m) => `${m.territory_code} @ ${m.customer_price}`)
            .join(", ")
        : "some territories";
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 text-amber-700 border-amber-200"
        title={`Base price + matched territories applied. No Apple price-point match for: ${detail}. These territories use Apple's auto-equalized price — adjust the template to a valid Apple price point if a specific price is required.`}
      >
        Partial: {missing.length} unmatched
      </span>
    );
  }
  if (outcome === "skipped-no-tier") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-100 text-slate-600 border-slate-200"
        title="Row had no resolved tier — Apple defaults apply."
      >
        No tier
      </span>
    );
  }
  // IAP.o.11a Q-F: pricing failures escalate to red error severity. Before,
  // "No USD" and "No match" rendered amber (warning); Manager surfaced these
  // as easy-to-miss in Step 4 results, which was the v4 silent-symptom.
  if (outcome === "skipped-no-usd-price") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
        title="Tier isn't in the local USA/USD cache. Re-import pricing tiers from Settings, or set the price manually in App Store Connect."
      >
        No USD
      </span>
    );
  }
  if (outcome === "skipped-no-match") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
        title="Local USD price didn't match any Apple price point — set manually in App Store Connect."
      >
        No match
      </span>
    );
  }
  if (outcome === "skipped-not-ready") {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
        title="Apple IAP wasn't ready for pricing within the poll window — set manually in App Store Connect."
      >
        Not ready
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-red-50 text-red-700 border-red-200"
      title={result.pricing_error ?? "Apple rejected the price schedule."}
    >
      Price failed
    </span>
  );
}

/**
 * ⚠ THE FALLBACK IS LOUD ON PURPOSE. A status the UI has never heard of means
 * the server shipped ahead of this component — a real deployment fact a
 * Manager should be able to see and report, not something to paper over by
 * borrowing another status's colour. Fuchsia + a question mark is chosen to
 * be obviously wrong on sight; it can never be mistaken for a normal outcome.
 */
const UNKNOWN_STATUS_STYLE = {
  cls: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-300 border-dashed",
  icon: HelpCircle,
};

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; icon: typeof CheckCircle }> = {
    SUCCESS: {
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
      icon: CheckCircle,
    },
    SKIPPED: {
      cls: "bg-slate-100 text-slate-600 border-slate-200",
      icon: AlertCircle,
    },
    ERROR: {
      cls: "bg-red-50 text-red-700 border-red-200",
      icon: XCircle,
    },
    // ⚠ C3 — PARTIAL IS NEITHER, AND MUST LOOK LIKE NEITHER. The IAP exists
    // on Apple (so not red) but a stage is missing (so not emerald). Amber is
    // not a new colour invented here: this module already uses it for exactly
    // this meaning — "created, but something did not land" — on `Created —
    // submit deferred` and on pricing's `partial-template-fail`. Orange is
    // taken (a specific sub-failure), slate means nothing happened, fuchsia
    // is the loud unknown. A triangle rather than SUCCESS's circle-check or
    // ERROR's circle-x, so the two are distinguishable without colour — the
    // badge is 10px and some Managers read it on a projector.
    PARTIAL: {
      cls: "bg-amber-50 text-amber-800 border-amber-300",
      icon: AlertTriangle,
    },
    // C2 — nothing was sent for this row. Slate like SKIPPED because neither
    // is a failure, but its own entry: the label below prints "not sent", and
    // the banner above the table explains that it is safe to re-run.
    NOT_ATTEMPTED: {
      cls: "bg-slate-100 text-slate-600 border-slate-200 border-dashed",
      icon: AlertCircle,
    },
  };
  // ⚠ NO `?? map.SKIPPED`. That fallback made every status the UI did not
  // know about wear SKIPPED's slate badge — so a NOT_ATTEMPTED row (nothing
  // sent, safe to re-run) rendered identically to a row the Manager had
  // deliberately skipped. The server type keeps those two apart on purpose;
  // borrowing another status's styling undoes that in the one place a person
  // actually looks. An unknown status now looks unknown.
  const conf = map[status] ?? UNKNOWN_STATUS_STYLE;
  const Icon = conf.icon;
  // "NOT_ATTEMPTED" reads as jargon in a 10px badge; "not sent" is the fact.
  const label = status === "NOT_ATTEMPTED" ? "not sent" : status.toLowerCase();
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${conf.cls}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

