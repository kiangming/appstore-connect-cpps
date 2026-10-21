"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
  X,
  RefreshCw,
} from "lucide-react";

import { toast } from "sonner";

import { PreviewTable } from "./PreviewTable";
import {
  CustomPricesDialog,
  type CustomPriceSet,
} from "./CustomPricesDialog";
import {
  activeCustomSkuSet,
  buildExecuteRequestBody,
  buildExecuteRows,
  computePrecisionViolations,
  previewRowsFromResponse,
  seedTierSelections,
} from "./execute-payload";
import { PricingSourceSelector } from "@/components/google-iap-management/iap-form/PricingSourceSelector";
import { PRICING_SOURCE_LABELS } from "@/lib/google-iap-management/pricing-source-labels";
import { MAX_DROPPED_ROWS, PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";
import {
  googleIapTemplateSpec,
  googleRetiredGtWarning,
  GOOGLE_LOCALE_OPTIONS,
  type RetiredGtColumns,
} from "@/lib/google-iap-management/parsers/template-spec";
import { DownloadTemplateButton } from "@/components/ui/shared/DownloadTemplateButton";

export type PricingSource = "google_default" | "default_template" | "app_template";
export type RowDecision = "overwrite" | "skip" | "create";

export interface PreviewListing {
  locale: string;
  title: string;
  description: string;
}

/** Hotfix 19: candidate-tier descriptor returned by the Preview API per
 *  row. Matches `TierCandidate` in `queries/templates.ts`. */
export interface PreviewTierCandidate {
  identifier: string;
  templateId: string;
  regionCount: number;
  vnCurrency: string | null;
  vnPriceMicros: string | null;
  vnPriceDecimal: string | null;
}

export interface PreviewRow {
  rowNumber: number;
  sku: string;
  baseCurrency: string;
  basePriceDecimal: string;
  listings: PreviewListing[];
  exists: boolean;
  decision: RowDecision;
  // Hotfix 19 — server-rendered candidate metadata.
  tierCandidates: PreviewTierCandidate[];
  defaultTierSelection: string | null;
  /** "lookup_failed" (H4.3): the preview's tier lookup threw — whether a
   *  tier matches is NOT known (the push looks again). */
  tierMatchedBy: "sku" | "currency_price" | "none" | "lookup_failed";
  // (H4.3: the Cycle 43 cross-currency `resolution` and `priceHeaderSource`
  // are gone — every row is priced from the currency in the file's header.)
}

/** A row of the file the tool will not import, with the reason (preview
 *  `refusedRows`): a price that cannot be honoured exactly, an empty price,
 *  no Product ID, an old row pasted whole (Manager Q6). H4.3: shown IN the preview table; the Manager may
 *  push the rest after confirming; sent to the server as `droppedRows` so
 *  Done, the audit and the Hub count them. */
export interface PreviewRefusedRow {
  rowNumber: number;
  sku: string;
  reason: string;
}

interface ExecuteResult {
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
  /** Every row not written other than Skip / a Google-side failure: price,
   *  tier, custom refusals AND the rows dropped in the file (H4.3). */
  rowsRefused?: number;
  priceRefusedRows?: number;
  /** H4.3 — rows refused in the file and left out by the Manager. */
  droppedRows?: number;
  /** Phase 3 — rows priced from a per-item custom set. */
  customPricedRows?: number;
  customRefusedRows?: number;
  refusedRows?: Array<{
    sku: string;
    rowNumber: number;
    reason: string;
    kind: string;
  }>;
  durationMs: number;
}

interface Props {
  packageName: string;
  appId: string;
  appDisplayName: string | null;
  // ⚠ H4.2: no app currency prop. The file is the only price source — the
  //   wizard, the pricing note and the custom-prices dialog never read it.
  /** D0/D3 — apps.iaps_last_synced_at: the last COMPLETE IAP-list refresh.
   *  null = never (or unreadable — see iapsSyncReadError). While null the
   *  mirror cannot say which SKUs exist, so Preview is blocked. */
  iapsLastSyncedAt: string | null;
  /** D2 — the sync state could not be READ. Distinct from "never synced". */
  iapsSyncReadError?: string | null;
}

type Step = "pricing" | "upload" | "preview" | "execute" | "done";

export function BulkImportWizard({
  packageName,
  appId,
  appDisplayName,
  iapsLastSyncedAt,
  iapsSyncReadError = null,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pricing");

  // D0/D3 — mirror sync state. Seeded from the page, then updated by an
  // in-wizard Refresh or by the preview response (which reads it at the
  // same moment as the mirror itself).
  const [mirrorSyncedAt, setMirrorSyncedAt] = useState<string | null>(iapsLastSyncedAt);
  const [mirrorReadError, setMirrorReadError] = useState<string | null>(iapsSyncReadError);
  const [refreshingMirror, setRefreshingMirror] = useState(false);
  const [mirrorRefreshError, setMirrorRefreshError] = useState<string | null>(null);
  const mirrorBlocked = mirrorSyncedAt === null;

  // D0 — the server is the authority: a page loaded before a state change (or
  // a stale tab) learns it from a refusal — of preview OR execute (twin paths,
  // same gate) — and re-blocks.
  function applyGateRefusal(body: { code?: string; blockers?: string[]; error?: string }) {
    const blockers = body.blockers ?? (body.code ? [body.code] : []);
    if (blockers.includes("IAPS_NEVER_SYNCED")) {
      setMirrorSyncedAt(null);
      setMirrorReadError(null);
    }
    if (body.code === "MIRROR_READ_FAILED") {
      setMirrorReadError(body.error ?? "Could not read the cached IAP list.");
    }
    if (body.code === "IMPORT_READINESS_READ_FAILED") {
      // The sync state could not be read — not "never refreshed".
      setMirrorSyncedAt(null);
      setMirrorReadError(body.error ?? "Could not read whether the IAP list has been refreshed.");
    }
  }

  // C2.1 — the app's currency/language are NOT import conditions; since
  // H4.2 the wizard does not read the app's currency at all.

  async function handleRefreshMirror() {
    setMirrorRefreshError(null);
    setRefreshingMirror(true);
    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/refresh`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        failed?: number;
        mirror_complete?: boolean;
        mirror_synced_at?: string | null;
        mirror_warning?: string | null;
      };
      if (!res.ok) {
        setMirrorRefreshError(body.error ?? `Refresh failed (HTTP ${res.status}).`);
        return;
      }
      if (!body.mirror_complete || !body.mirror_synced_at) {
        // ⚠ A 200 that did not stamp is NOT a usable mirror — say WHY (the
        // server's reason: failed rows, or an empty answer from Google next to
        // a populated mirror) instead of unblocking (P5).
        setMirrorRefreshError(
          body.mirror_warning ??
            `Refresh finished with ${body.failed ?? "some"} item(s) that could not be cached — ` +
              `the IAP list is not complete yet. Try Refresh again.`,
        );
        return;
      }
      setMirrorSyncedAt(body.mirror_synced_at);
      setMirrorReadError(null);
      setUploadError(null);
      router.refresh();
    } catch (err) {
      setMirrorRefreshError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setRefreshingMirror(false);
    }
  }

  // Step 1: pricing source. `null` until the availability check resolves —
  // the selector auto-selects by priority (app template → default template
  // → Google Conversion) and we must not pre-state an answer we don't have.
  // Continue is gated on this being non-null.
  const [pricingSource, setPricingSource] = useState<PricingSource | null>(null);

  // Step 2: file upload
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Drag-drop visual feedback + the actual fix: the label previously had
  // no drag/drop handlers at all, so the browser's default action
  // (navigate to / download the dropped file) fired instead of importing.
  const [dragActive, setDragActive] = useState(false);

  // Step 3: preview
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  /** Rows of the file the tool will not import, with the reason. NOT in
   *  previewRows (nothing that iterates previewRows may ever send them).
   *  H4.3: shown in the preview table; Push sends the rest only after the
   *  Manager confirms how many are left out (confirmPushOpen), and they go
   *  to the server as `droppedRows` so Done / audit / Hub count them. */
  const [fileRefusedRows, setFileRefusedRows] = useState<PreviewRefusedRow[]>([]);
  /** H4.3 — the "push the rest?" confirmation. Opening or cancelling it does
   *  NOT touch the Hub run: the run belongs to the whole preview (a later
   *  Confirm still sends it; the header's "Back to <app>" and page unload
   *  still cancel it — the preview's own Back does not, see BACKLOG
   *  [GOOGLE-bulk-import-hub-run-reuse]). Only handleExecute marks execution
   *  started. Closed whenever the wizard leaves the preview step (effect
   *  below), so it can never reappear over a DIFFERENT preview. */
  const [confirmPushOpen, setConfirmPushOpen] = useState(false);
  /** H4.4 — the file's price header, for the import audit. */
  const [priceHeader, setPriceHeader] = useState<string | null>(null);
  /** [GOOGLE-bulkimport-drop-gt] — the retired GT columns of the previewed
   *  file (Manager Q1): a notice, never a gate; the count goes to the audit. */
  const [retiredGt, setRetiredGt] = useState<RetiredGtColumns>(null);
  useEffect(() => {
    if (step !== "preview") setConfirmPushOpen(false);
  }, [step]);
  // Hotfix 19: per-row Manager tier selection. Keyed by rowNumber so
  // the orchestrator's execute payload can map back. Pre-filled from the
  // Preview API's `defaultTierSelection` (Q5.B primary tier).
  const [tierSelections, setTierSelections] = useState<Record<number, string>>(
    {},
  );

  // Per-item custom prices — a SIBLING of previewRows/tierSelections,
  // deliberately NOT reset by handleUploadAndPreview.
  //
  // KEYED BY SKU, NOT rowNumber. This is load-bearing, not a style choice:
  // `tierSelections` is rowNumber-keyed and fully reseeded on every preview
  // response (see the seedSelections block below), and changing the
  // template FORCES a re-preview because pricingSource travels with the
  // file upload. So the Manager-locked requirement "custom survives a
  // template change" is unachievable inside that map — rowNumber is a
  // file position, SKU is the row's identity. Proven by the survival test
  // in BulkImportWizard.custom-prices.test.tsx.
  const [customPrices, setCustomPrices] = useState<Record<string, CustomPriceSet>>({});
  // SKU whose dialog is open, or null.
  const [customDialogSku, setCustomDialogSku] = useState<string | null>(null);
  // Tier identifier each custom set was saved against, compared on
  // re-preview so the dialog can say "no longer tied to a template".
  const [customBaselineDrift, setCustomBaselineDrift] = useState<Record<string, boolean>>({});
  // Q3: named on a re-upload so a dropped custom set is never silent.
  const [customCarryNotice, setCustomCarryNotice] = useState<{
    kept: string[];
    dropped: string[];
  } | null>(null);

  // Step 4: execute
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null);

  // Hub tracking (VNGGames Hub run-tracking integration — mirrors the
  // Apple IAP Management fix, commits 95d9413/613a9c3/4ba8e6f/9ed7845).
  // RUN_ID lives only in wizard client state — no server-side persistence.
  const [hubRunId, setHubRunId] = useState<string | null>(null);
  // Ref so the beforeunload listener (registered once) always reads the
  // LATEST hubRunId without re-binding the listener on every render.
  const hubRunIdRef = useRef<string | null>(hubRunId);
  useEffect(() => {
    hubRunIdRef.current = hubRunId;
  });
  // Holds the in-flight /hub-tracking/start call's resolved run_id (or
  // null), set once per upload→preview cycle. handleExecute races this
  // against a HARD 1s cap so a fast click still gets the real run_id
  // threaded through when start resolves quickly, without ever blocking
  // the import beyond that cap.
  const hubStartPromiseRef = useRef<Promise<string | null> | null>(null);

  // PERMANENT flag — set true the instant handleExecute is invoked and
  // NEVER reset back to false (this was a real bug on the Apple side:
  // using transient `executing`/step state re-opened the cancel-on-exit
  // guard after the execute request settled — success, failure, or a
  // client-side hiccup reading the response — firing a spurious
  // CANCELLED that overwrote whatever real terminal status the server's
  // own `finally` had already recorded). Once execute has been submitted,
  // the server owns the run's terminal status, full stop.
  const executeStartedRef = useRef(false);

  // Wizard state is entirely client-side, so a refresh loses custom prices
  // (and everything else). Accepted — but it must not be SILENT: ~170
  // hand-typed prices per row is real work. Ref so the listener registered
  // once always sees the current count without re-binding.
  const hasUnsavedCustomsRef = useRef(false);
  useEffect(() => {
    hasUnsavedCustomsRef.current = Object.keys(customPrices).length > 0;
  });

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      const runId = hubRunIdRef.current;
      // Best-effort only — doesn't catch hard crashes/force-quit. Skipped
      // once execute has ever been invoked: the execute route's own
      // `finally` owns closing the run from that point on.
      if (runId && !executeStartedRef.current) {
        const blob = new Blob([JSON.stringify({ run_id: runId })], {
          type: "application/json",
        });
        navigator.sendBeacon("/api/google-iap-management/hub-tracking/cancel", blob);
      }
      // Prompt only while customs exist and nothing has been pushed yet —
      // after execute the work is on Google, not in this tab.
      if (hasUnsavedCustomsRef.current && !executeStartedRef.current) {
        e.preventDefault();
        // Legacy browsers key off a non-empty returnValue; modern ones
        // show their own wording.
        e.returnValue = "";
        return "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  function handleExit() {
    // Explicit back-out — cancel ONLY if execute was never invoked. Once
    // it has been, the server's own `finally` owns the terminal status
    // (SUCCESS/FAILED/PARTIAL) regardless of what happens client-side
    // after that point. No-ops server-side if hubRunId is null.
    if (hubRunId && !executeStartedRef.current) {
      fetch("/api/google-iap-management/hub-tracking/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: hubRunId }),
        keepalive: true,
      }).catch(() => {
        // Swallowed — best-effort, mirrors the non-blocking discipline.
      });
    }
    router.push(`/google-iap-management/apps/${encodeURIComponent(packageName)}`);
  }

  /** Custom prices apply under EVERY pricing source.
   *
   *  They were once template-only, on the assumption that Google
   *  Conversion couldn't carry them. It can: the clobber that motivated
   *  the restriction lives inside the template-resolution loop, which is
   *  gated on a template source, so under Google Conversion
   *  regionOverrides flows straight through. The old keep-but-inactive
   *  state is gone entirely — a net simplification. */
  const customActive = true;

  /** The SKUs whose customs will actually ship: a saved set on a row that
   *  isn't set to Skip. */
  const activeCustomSkus = useMemo(
    () => activeCustomSkuSet(previewRows, customPrices),
    [previewRows, customPrices],
  );

  /** Entry count per SKU, for the row chip. */
  const customPriceCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [sku, set] of Object.entries(customPrices)) {
      out[sku] = set.entries.length;
    }
    return out;
  }, [customPrices]);

  const counts = useMemo(() => {
    const total = previewRows.length;
    const existing = previewRows.filter((r) => r.exists).length;
    const pending = previewRows.filter(
      (r) => r.exists && r.decision === "create",
    ).length;
    const willOverwrite = previewRows.filter((r) => r.decision === "overwrite").length;
    const willSkip = previewRows.filter((r) => r.decision === "skip").length;
    const willCreate = previewRows.filter((r) => !r.exists && r.decision === "create").length;
    return { total, existing, pending, willOverwrite, willSkip, willCreate };
  }, [previewRows]);

  /**
   * Listing-loss warning (GOOGLE ONLY — Apple genuinely doesn't have
   * this risk: its overwrite path suppresses localization deletions when
   * a row carries none, so existing localizations survive).
   *
   * Google replaces a product's listings with whatever the row carries,
   * and a row with NO Title/Description columns (the locale-picker's
   * core-only template — its default output) falls back to a single
   * en-US listing titled with the SKU. The overwrite read-modify-write
   * GET merges purchase options only, NOT listings, so overwriting an
   * existing product from such a row wipes its real store metadata.
   *
   * Derived client-side from the user's per-row decisions so it tracks
   * Overwrite/Skip flips live — the preview API can't know decisions,
   * they're made here. Uses only data already on hand (row.listings +
   * row.exists + row.decision): no extra fetch. It names the affected
   * SKUs; it deliberately does NOT claim what their current titles are,
   * because the preview's existence read
   * (bulk-import/preview/route.ts → listIapsForApp) selects IAP columns
   * only and carries no listing data.
   *
   * WARNING, not a block: overwriting with an SKU-titled listing can be
   * a legitimate intent.
   */
  const listingLossRows = useMemo(
    () =>
      previewRows.filter(
        (r) => r.decision === "overwrite" && r.listings.length === 0,
      ),
    [previewRows],
  );

  // Hotfix 28 — pre-flight precision validation per-row currency.
  //
  // Pre-Hotfix-14 the legacy inappproducts.batchUpdate enforced
  // defaultPrice.currency === app.defaultCurrency, so the wizard
  // validated every row against `appDefaultCurrency`. Hotfix 14 Phase 3
  // migrated to Google's Monetization API which accepts per-region
  // pricing — the orchestrator now stamps defaultPrice.currency from
  // each row's `baseCurrency` (resolved by the parser from the column
  // header, e.g. "Price (USD)" → USD). This pre-flight check was left
  // on the old app-wide assumption, which blocked USD-priced rows in
  // VND-default apps (Hotfix 28 production symptom). Now validates
  // each row against its own column-resolved currency to match the
  // orchestrator path. Skip rows are excluded — they're not sent.
  const precisionViolations = useMemo(
    () => computePrecisionViolations(previewRows),
    [previewRows],
  );

  /** The parser lists each refused row in its warnings too; the table and the
   *  summary above it already show them — not a third time here. */
  const visibleWarnings = useMemo(
    () =>
      previewWarnings.filter(
        (w) => !fileRefusedRows.some((r) => w.startsWith(`Row ${r.rowNumber} (SKU "`)),
      ),
    [previewWarnings, fileRefusedRows],
  );

  // Hotfix 19: derive disambiguation status for the banner + button counter.
  //   - ambiguous: rows whose template lookup found >1 candidate tiers
  //   - pending:   ambiguous rows where Manager cleared the selection (edge case)
  //   - changed:   ambiguous rows where Manager picked a non-default tier
  //   - atDefault: ambiguous rows still on the pre-selected primary tier
  const tierStatus = useMemo(() => {
    let ambiguous = 0;
    let pending = 0;
    let changed = 0;
    let atDefault = 0;
    for (const row of previewRows) {
      if (row.decision === "skip") continue;
      if (row.tierCandidates.length <= 1) continue;
      ambiguous += 1;
      const selection = tierSelections[row.rowNumber];
      if (!selection) {
        pending += 1;
        continue;
      }
      if (
        row.defaultTierSelection &&
        selection === row.defaultTierSelection
      ) {
        atDefault += 1;
      } else {
        changed += 1;
      }
    }
    return { ambiguous, pending, changed, atDefault };
  }, [previewRows, tierSelections]);

  async function handleUploadAndPreview() {
    if (!file) return;
    // Unreachable via the UI (Continue is gated on this), but guarded
    // explicitly rather than asserted: uploading with an unknown source
    // would have the API silently fall back to google_default
    // (preview/route.ts), i.e. import under a source nobody chose.
    if (pricingSource === null) return;
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      // Hotfix 19: thread pricingSource so the API can look up
      // candidate tiers per row server-side.
      form.append("pricingSource", pricingSource);
      // The contract this tab was built under — the preview route refuses
      // another (a tab opened before an update gets "reload", not a crash).
      form.append("pricing_rule", PRICING_RULE);
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/bulk-import/preview`,
        { method: "POST", body: form },
      );
      const body = (await res.json().catch(() => ({}))) as {
        rows?: Array<Omit<PreviewRow, "decision">>;
        warnings?: string[];
        errors?: string[];
        error?: string;
        code?: string;
        blockers?: string[];
        iapsLastSyncedAt?: string | null;
        refusedRows?: Array<{ rowNumber: number; sku: string; reason: string }>;
        priceHeader?: string | null;
        retiredGtColumns?: RetiredGtColumns;
      };
      if (!res.ok) {
        applyGateRefusal(body);
        if (body.errors && body.errors.length > 0) {
          setUploadError(body.errors.join(" · "));
        } else {
          setUploadError(body.error ?? `Preview failed (HTTP ${res.status}).`);
        }
        return;
      }
      const rows = previewRowsFromResponse(body.rows ?? []);
      // Hotfix 19: seed tierSelections — every row with candidates
      // starts on its primary tier (Q5.B). Manager can change via dropdown.
      const seedSelections = seedTierSelections(rows);
      setPreviewRows(rows);
      setPreviewWarnings(body.warnings ?? []);
      setFileRefusedRows(body.refusedRows ?? []);
      setPriceHeader(body.priceHeader ?? null);
      setRetiredGt(body.retiredGtColumns ?? null);
      setTierSelections(seedSelections);
      if (body.iapsLastSyncedAt) setMirrorSyncedAt(body.iapsLastSyncedAt);

      // Custom prices deliberately SURVIVE this reset (Manager-locked:
      // "custom survives back-navigation to Step 1 and a template
      // change"). Two adjustments, both of which must be visible:
      //  - Q3: a DIFFERENT file may not contain every SKU that has a
      //    custom set. Keep the ones whose SKU is still present, drop the
      //    rest, and name BOTH lists — counts alone aren't verifiable
      //    before a live-store write.
      //  - Baseline drift: a set saved against tier X while the row now
      //    resolves to tier Y (or to nothing) is no longer tied to the
      //    template. The dialog header says so and the Template column
      //    shows the NEW values for comparison.
      setCustomPrices((prev) => {
        const skusInFile = new Set(rows.map((r) => r.sku));
        const kept: string[] = [];
        const dropped: string[] = [];
        const next: Record<string, CustomPriceSet> = {};
        for (const [sku, set] of Object.entries(prev)) {
          if (skusInFile.has(sku)) {
            next[sku] = set;
            kept.push(sku);
          } else {
            dropped.push(sku);
          }
        }
        if (dropped.length > 0) {
          setCustomCarryNotice({ kept, dropped });
        } else {
          setCustomCarryNotice(null);
        }
        const drift: Record<string, boolean> = {};
        for (const sku of kept) {
          const set = next[sku];
          const row = rows.find((r) => r.sku === sku);
          const nowTier = row ? (seedSelections[row.rowNumber] ?? null) : null;
          drift[sku] =
            set.baseline.kind === "template"
              ? set.baseline.identifier !== nowTier
              : nowTier !== null;
        }
        setCustomBaselineDrift(drift);
        return next;
      });
      setStep("preview");

      // Fires on the upload→preview transition — the moment the user has
      // finished uploading data. Best-effort, never awaited here — never
      // delays advancing the wizard. Config unconfigured/disabled or any
      // Hub failure both resolve server-side to `{ run_id: null }`. The
      // promise itself is stored so handleExecute can race a capped await
      // against it (a fast click shouldn't lose the real run_id).
      const startPromise: Promise<string | null> = fetch(
        "/api/google-iap-management/hub-tracking/start",
        { method: "POST" },
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { run_id?: string } | null) =>
          data && typeof data.run_id === "string" ? data.run_id : null,
        )
        .catch(() => null);
      hubStartPromiseRef.current = startPromise;

      startPromise.then((runId) => {
        if (!runId) return;
        if (executeStartedRef.current) {
          // Execute already began without this run_id threaded through
          // (a fast click losing the race against this call, OR
          // handleExecute's own capped await already timed out on it).
          // This run is REAL and actively executing/succeeding — it is
          // NOT abandoned. Do NOT cancel it: a run that can't be closed
          // (orphaned RUNNING — the already-accepted lifecycle
          // limitation) is far better than one closed with the WRONG
          // terminal status. Drop silently: no cancel call, no adoption.
          return;
        }
        setHubRunId(runId);
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function setRowTierSelection(rowNumber: number, identifier: string) {
    setTierSelections((prev) => {
      const next = { ...prev };
      if (identifier === "") {
        delete next[rowNumber];
      } else {
        next[rowNumber] = identifier;
      }
      return next;
    });
    // Revertibility exit #3: picking a REAL tier drops Custom for that row.
    // (The dropdown's "Custom…" entry is handled by openCustomDialog and
    // never reaches here — it is a trigger, not a selectable tier value.)
    if (identifier) {
      const row = previewRows.find((r) => r.rowNumber === rowNumber);
      if (row && customPrices[row.sku]) clearCustomForSku(row.sku, { toast: true });
    }
  }

  function clearCustomForSku(sku: string, opts: { toast?: boolean } = {}) {
    const removed = customPrices[sku];
    setCustomPrices((prev) => {
      const next = { ...prev };
      delete next[sku];
      return next;
    });
    setCustomBaselineDrift((prev) => {
      const next = { ...prev };
      delete next[sku];
      return next;
    });
    if (opts.toast && removed) {
      // Undo restores the exact set — reverting must never cost the
      // Manager ~170 typed prices to a misclick.
      toast(`Custom prices cleared for ${sku}`, {
        action: {
          label: "Undo",
          onClick: () => setCustomPrices((prev) => ({ ...prev, [sku]: removed })),
        },
      });
    }
  }

  function saveCustomForSku(sku: string, set: CustomPriceSet) {
    setCustomPrices((prev) => ({ ...prev, [sku]: set }));
    // A freshly saved set is by definition aligned with whatever baseline
    // it was just built from.
    setCustomBaselineDrift((prev) => ({ ...prev, [sku]: false }));
    setCustomDialogSku(null);
  }

  function setAllExisting(decision: "overwrite" | "skip") {
    setPreviewRows((prev) =>
      prev.map((r) => (r.exists ? { ...r, decision } : r)),
    );
  }

  function setRowDecision(rowNumber: number, decision: "overwrite" | "skip") {
    setPreviewRows((prev) =>
      prev.map((r) => (r.rowNumber === rowNumber ? { ...r, decision } : r)),
    );
  }

  async function handleExecute() {
    if (pricingSource === null) return;
    // Permanent — from this point on the server owns the run's terminal
    // status; the client must never send cancel for it again (see
    // executeStartedRef's definition above for why transient state isn't
    // a sufficient guard). Set FIRST, before the capped await below, so
    // the guard state is correct for the whole wait window.
    executeStartedRef.current = true;
    setExecuteError(null);
    setExecuting(true);
    setStep("execute");

    // A fast click can reach here before /hub-tracking/start resolves —
    // give it a bounded chance to land the real run_id anyway, so the
    // execute route's own finalize gets a real SUCCESS/FAILED/PARTIAL
    // close instead of silently no-opping. HARD-capped at 1s (never the
    // full 3s Hub timeout): the import must not be blocked waiting on
    // tracking. If the cap wins, hub_run_id stays null — a MISSED track,
    // never a WRONG one (see the start .then() handler above).
    let runIdForExecute = hubRunId;
    if (!runIdForExecute && hubStartPromiseRef.current) {
      const capped: Promise<null> = new Promise((resolve) => {
        setTimeout(() => resolve(null), 1000);
      });
      runIdForExecute = await Promise.race([hubStartPromiseRef.current, capped]);
    }

    try {
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/bulk-import/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // ONE builder, shared with the route-level pricing test
          // (execute-payload.ts) — nothing may be added or rewritten here.
          body: JSON.stringify(
            buildExecuteRequestBody({
              pricingSource,
              sourceFilename: file?.name ?? null,
              hubRunId: runIdForExecute,
              rows: buildExecuteRows(previewRows, {
                tierSelections,
                customPrices,
                activeCustomSkus,
              }),
              droppedRows: fileRefusedRows,
              priceHeader,
              gtRowsWithData: retiredGt?.rowsWithData ?? null,
            }),
          ),
        },
      );
      const body = (await res.json().catch(() => ({}))) as ExecuteResult & {
        error?: string;
        code?: string;
        blockers?: string[];
      };
      if (!res.ok) {
        applyGateRefusal(body);
        setExecuteError(body.error ?? `Execute failed (HTTP ${res.status}).`);
        setStep("preview");
        return;
      }
      setExecuteResult(body);
      setStep("done");
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : "Network error");
      setStep("preview");
    } finally {
      setExecuting(false);
    }
  }

  // Hotfix 19: Push button is gated on every ambiguous row having a
  // selection (Manager either accepted the pre-selected primary tier or
  // explicitly picked another). `tierStatus.pending > 0` only happens
  // when Manager clears a dropdown back to "— Select a tier —".
  // H4.3 — rows refused in the file no longer block Push: they are left out
  // after a confirmation (requestPush). A file with NO importable row still
  // cannot push (previewRows.length > 0).
  const canContinueFromPreview =
    counts.pending === 0 &&
    previewRows.length > 0 &&
    fileRefusedRows.length <= MAX_DROPPED_ROWS &&
    precisionViolations.length === 0 &&
    tierStatus.pending === 0;

  /** H4.3 — Push: straight to execute when every row of the file is
   *  importable; otherwise the confirmation first, naming every row left out.
   *  ⚠ Never mark execution started here — see confirmPushOpen. */
  function requestPush() {
    if (fileRefusedRows.length > 0) {
      setConfirmPushOpen(true);
      return;
    }
    void handleExecute();
  }

  return (
    <div className="space-y-4">
      {/* Wizard header — the template download lives HERE so it is
          visible at every step (Manager UAT: the old Step-2 placement
          was too buried). Same shared component as the apps-list page. */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleExit}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to {appDisplayName ?? packageName}
        </button>
        <DownloadTemplateButton
          localeOptions={GOOGLE_LOCALE_OPTIONS}
          getSpec={googleIapTemplateSpec}
          confirmClassName="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          zeroLocaleCaution="If you then OVERWRITE products that already exist on Google Play, their current store listings are replaced by a single en-US listing titled with the SKU."
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-300 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-60"
        />
      </div>

      <StepHeader step={step} />

      <MirrorSyncBanner
        syncedAt={mirrorSyncedAt}
        readError={mirrorReadError}
        refreshing={refreshingMirror}
        refreshError={mirrorRefreshError}
        onRefresh={handleRefreshMirror}
      />

      <PricingCurrencyNote />

      {/* Step 1: Pricing source */}
      {step === "pricing" && (
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-1">
            Pricing source
          </h2>
          <p className="text-xs text-slate-500 mb-4">
            Q-GIAP.E batch-level. Applied to every row in this import. For
            template modes, each row takes the tier named after its SKU, else
            the tier whose price in the file&apos;s currency equals the
            file&apos;s price; rows without a matching tier fall back to{" "}
            <strong>Google Conversion</strong> — the file&apos;s price,
            converted by Google into every other country.
          </p>
          <PricingSourceSelector
            value={pricingSource}
            onChange={setPricingSource}
            appId={appId}
            tierValue=""
            onTierChange={() => undefined}
            hideTierPicker
          />
          <div className="mt-6 flex justify-end">
            <button
              onClick={() => setStep("upload")}
              disabled={pricingSource === null}
              title={
                pricingSource === null
                  ? "Checking which pricing templates are available…"
                  : ""
              }
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* Step 2: Upload */}
      {step === "upload" && (
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-1">
            Upload Excel file
          </h2>
          <p className="text-xs text-slate-500 mb-4">
            Get{" "}
            <code className="bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded font-mono text-[11px]">
              google-iap-bulk-import-template.xlsx
            </code>{" "}
            via <strong>Download template</strong> (top right, also on the
            Apps page) and fill in the &quot;IAP Items&quot; sheet — prices in
            the <strong>Price (USD)</strong> column are US dollars (see the
            Notes sheet).
          </p>

          <label
            htmlFor="bulk-upload-file"
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(true);
            }}
            onDragOver={(e) => {
              // REQUIRED: without preventDefault() here, the browser never
              // fires `drop` at all — it falls through to its OWN default
              // handling (navigating to / downloading the dropped file)
              // instead. This label previously had no drag handlers at
              // all, so dragging an .xlsx onto it opened a new tab/
              // downloaded the file instead of importing it.
              e.preventDefault();
              e.stopPropagation();
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) setFile(dropped);
            }}
            className={`flex flex-col items-center gap-2 border-2 border-dashed rounded-lg p-8 cursor-pointer transition ${
              dragActive
                ? "border-emerald-500 bg-emerald-50"
                : "border-slate-300 hover:border-emerald-400 hover:bg-emerald-50/30"
            }`}
          >
            <Upload className="h-8 w-8 text-slate-400" strokeWidth={1.5} />
            {file ? (
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-medium text-slate-700">
                  {file.name}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setFile(null);
                  }}
                  className="text-slate-400 hover:text-red-600 transition"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-700">
                  Click to select or drag in .xlsx
                </p>
                <p className="text-[11px] text-slate-400">
                  Max 5 MB
                </p>
              </>
            )}
            <input
              id="bulk-upload-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
          </label>

          {uploadError && (
            <div className="mt-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{uploadError}</span>
            </div>
          )}

          <div className="mt-6 flex justify-between">
            <button
              onClick={() => setStep("pricing")}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={handleUploadAndPreview}
              // D0 — blocked while the mirror cannot say which SKUs exist.
              disabled={!file || uploading || mirrorBlocked}
              title={mirrorBlocked ? "Refresh the IAP list first (see the banner above)." : undefined}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {uploading ? "Parsing…" : "Preview"}
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && (
        <section className="space-y-3">
          {/* Hotfix 19 — disambiguation banner (Q4.D). */}
          {tierStatus.ambiguous > 0 && (
            <TierBanner status={tierStatus} />
          )}

          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>
                Total: <strong className="text-slate-900">{counts.total}</strong>
              </span>
              {fileRefusedRows.length > 0 && (
                <span className="text-red-700">
                  Not imported: <strong>{fileRefusedRows.length}</strong>
                </span>
              )}
              <span>
                New:{" "}
                <strong className="text-emerald-700">{counts.willCreate}</strong>
              </span>
              <span>
                Existing: <strong className="text-amber-700">{counts.existing}</strong>
              </span>
              {counts.pending > 0 && (
                <span className="text-red-600">
                  Pending decisions: <strong>{counts.pending}</strong>
                </span>
              )}
              {tierStatus.ambiguous > 0 && (
                <span
                  className={
                    tierStatus.pending > 0
                      ? "ml-auto inline-flex items-center gap-1 text-amber-700"
                      : "ml-auto inline-flex items-center gap-1 text-blue-700"
                  }
                >
                  {tierStatus.pending > 0
                    ? `${tierStatus.pending} need${tierStatus.pending === 1 ? "s" : ""} selection`
                    : `${tierStatus.ambiguous} ambiguous · ${tierStatus.changed} changed`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {counts.existing > 0 && (
                <>
                  <button
                    onClick={() => setAllExisting("overwrite")}
                    className="px-2 py-1 text-[11px] font-medium text-amber-700 border border-amber-200 hover:bg-amber-50 rounded transition"
                  >
                    Set all to Overwrite
                  </button>
                  <button
                    onClick={() => setAllExisting("skip")}
                    className="px-2 py-1 text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded transition"
                  >
                    Set all to Skip
                  </button>
                </>
              )}
            </div>
          </div>

          {listingLossRows.length > 0 && (
            <div
              role="alert"
              className="bg-amber-100 border border-amber-400 rounded-lg p-3"
            >
              <p className="text-xs font-semibold text-amber-900 mb-1">
                ⚠ {listingLossRows.length} row(s) set to Overwrite carry no
                Title/Description — existing store listings will be REPLACED
              </p>
              <p className="text-[11px] text-amber-900 leading-relaxed">
                These SKUs already exist on Google Play. Because their rows
                have no locale columns filled, each product&apos;s listings
                will be replaced with a single <strong>en-US</strong> listing
                titled with the SKU itself — any current titles/descriptions
                on Google Play are lost. If you meant to keep them, download a
                template <em>with</em> the locales you need, fill them, and
                re-upload; or set these rows to <strong>Skip</strong>.
              </p>
              <p className="mt-1 text-[11px] font-mono text-amber-800 max-h-20 overflow-y-auto">
                {listingLossRows.map((r) => r.sku).join(", ")}
              </p>
            </div>
          )}

          {/* Q3 — a re-upload never silently drops a custom set. Both
              lists are named: counts alone aren't verifiable before a
              live-store write. */}
          {customCarryNotice && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-blue-900 mb-1">
                {customCarryNotice.kept.length} custom price set
                {customCarryNotice.kept.length === 1 ? "" : "s"} kept ·{" "}
                {customCarryNotice.dropped.length} dropped
              </p>
              <p className="text-[11px] text-blue-900 leading-relaxed">
                Kept where the SKU still appears in the new file
                {customCarryNotice.kept.length > 0 && (
                  <>
                    {" "}
                    (<span className="font-mono">{customCarryNotice.kept.join(", ")}</span>)
                  </>
                )}
                ; dropped where it is no longer an importable row of the file (
                <span className="font-mono">{customCarryNotice.dropped.join(", ")}</span>
                ).
              </p>
            </div>
          )}

          <RetiredGtNotice gt={retiredGt} />

          {visibleWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-medium text-amber-900 mb-1">
                Parse warnings ({visibleWarnings.length})
              </p>
              <ul className="space-y-0.5 text-[11px] text-amber-800 max-h-32 overflow-y-auto">
                {visibleWarnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* H4.3 — the refused rows themselves are IN the table below
              (marked "Not imported", with the reason). */}
          {fileRefusedRows.length > 0 && (
            <div
              data-testid="file-refused-rows"
              data-state={previewRows.length > 0 ? "push-the-rest" : "nothing-to-push"}
              className="bg-red-50 border border-red-200 rounded-lg p-3"
            >
              <p className="text-xs font-medium text-red-900">
                {fileRefusedRows.length} row(s) of the file will not be imported — each is marked
                &quot;Not imported&quot; in the table with the reason.{" "}
                {previewRows.length > 0
                  ? "Push sends the other rows after you confirm; the rows left out are listed in the report."
                  : "No row can be imported — fix the file and upload it again."}
              </p>
            </div>
          )}
          {precisionViolations.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-xs font-medium text-red-900 mb-1">
                {precisionViolations.length} row(s) violate their column
                currency&apos;s precision — Google will reject these. Fix the
                Excel file and re-upload, or remove the affected rows.
              </p>
              <ul className="space-y-0.5 text-[11px] text-red-800 max-h-32 overflow-y-auto">
                {precisionViolations.slice(0, 20).map((v) => (
                  <li key={v.rowNumber}>
                    · Row {v.rowNumber} ({v.sku}): {v.error}
                  </li>
                ))}
                {precisionViolations.length > 20 && (
                  <li className="italic text-red-700">
                    …and {precisionViolations.length - 20} more.
                  </li>
                )}
              </ul>
            </div>
          )}

          {executeError && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{executeError}</span>
            </div>
          )}

          <PreviewTable
            rows={previewRows}
            refusedRows={fileRefusedRows}
            onRowDecisionChange={setRowDecision}
            tierSelections={tierSelections}
            onTierSelectionChange={setRowTierSelection}
            customPriceCounts={customPriceCounts}
            activeCustomSkus={activeCustomSkus}
            onOpenCustomDialog={setCustomDialogSku}
            onClearCustom={(sku) => clearCustomForSku(sku, { toast: true })}
            customEnabled={customActive}
          />

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep("upload")}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={requestPush}
              disabled={!canContinueFromPreview || executing}
              title={
                fileRefusedRows.length > MAX_DROPPED_ROWS
                  ? `${fileRefusedRows.length} rows cannot be imported — more than ${MAX_DROPPED_ROWS} in one push; clean the file`
                  : previewRows.length === 0
                  ? "No row can be imported — each row is listed with its reason"
                  : precisionViolations.length > 0
                  ? `${precisionViolations.length} row(s) violate per-row currency precision`
                  : tierStatus.pending > 0
                    ? `${tierStatus.pending} item${tierStatus.pending === 1 ? "" : "s"} need${tierStatus.pending === 1 ? "s" : ""} tier selection`
                    : !canContinueFromPreview
                      ? "Resolve all existing-SKU decisions first"
                      : ""
              }
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {tierStatus.pending > 0
                ? `Push to Google Play (${tierStatus.pending} item${tierStatus.pending === 1 ? "" : "s"} need${tierStatus.pending === 1 ? "s" : ""} selection)`
                : "Push to Google Play"}
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* H4.3 — "push the rest?" Cancel only closes it: the Hub run stays
          open and attached (a later Confirm sends it). */}
      {confirmPushOpen && step === "preview" && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="push-confirm-title"
          data-testid="push-confirm"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h3 id="push-confirm-title" className="text-sm font-semibold text-slate-900">
              Push without the rows that cannot be imported?
            </h3>
            <p data-testid="push-confirm-dropped" className="mt-2 text-xs text-red-800">
              {fileRefusedRows.length} row(s) of the file will NOT be imported:
            </p>
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-[11px] text-red-800">
              {fileRefusedRows.map((r) => (
                <li key={r.rowNumber}>
                  · Row {r.rowNumber} ({r.sku || "no Product ID"}): {r.reason}
                </li>
              ))}
            </ul>
            <p data-testid="push-confirm-sent" className="mt-2 text-xs text-slate-700">
              {previewRows.filter((r) => r.decision !== "skip").length} row(s) will be sent to Google Play
              {counts.willSkip > 0 ? ` (${counts.willSkip} set to Skip)` : ""}. The rows left out are listed
              in the report afterwards — fix them in the file and import them again.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                data-testid="push-confirm-cancel"
                onClick={() => setConfirmPushOpen(false)}
                className="px-3 py-2 text-sm font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition"
              >
                Go back
              </button>
              <button
                type="button"
                data-testid="push-confirm-ok"
                disabled={!canContinueFromPreview || executing}
                onClick={() => {
                  setConfirmPushOpen(false);
                  // The SAME gate as Push: the dialog must never be a way
                  // around an unresolved decision / tier / precision block.
                  if (!canContinueFromPreview || executing) return;
                  void handleExecute();
                }}
                className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
              >
                Leave them out and push
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-item custom prices dialog. Mounted only while open so each
          open re-fetches the baseline — the country catalog must not be
          cached across opens (P6: Google's catalog moves, Hotfix 9). */}
      {customDialogSku &&
        (() => {
          const row = previewRows.find((r) => r.sku === customDialogSku);
          const tier = row ? (tierSelections[row.rowNumber] ?? null) : null;
          return (
            <CustomPricesDialog
              sku={customDialogSku}
              sourceLabel={
                pricingSource === "app_template"
                  ? PRICING_SOURCE_LABELS.app_template
                  : pricingSource === "default_template"
                    ? PRICING_SOURCE_LABELS.default_template
                    : PRICING_SOURCE_LABELS.google_default
              }
              // No tier under Google Conversion — the dialog then opens
              // with every country in the "inherit" state and nothing
              // pre-filled, which is the correct baseline there.
              tierIdentifier={pricingSource === "google_default" ? null : tier}
              isGoogleConversion={pricingSource === "google_default"}
              scope={pricingSource === "app_template" ? "APP" : "ACCOUNT"}
              appId={appId}
              packageName={packageName}
              baseCurrency={row?.baseCurrency ?? ""}
              basePriceDecimal={row?.basePriceDecimal ?? ""}
              existing={customPrices[customDialogSku] ?? null}
              baselineChanged={customBaselineDrift[customDialogSku] ?? false}
              onSave={(set) => saveCustomForSku(customDialogSku, set)}
              onClearAll={() => {
                clearCustomForSku(customDialogSku);
                setCustomDialogSku(null);
              }}
              onClose={() => setCustomDialogSku(null)}
            />
          );
        })()}

      {/* Step 4: Execute (transient) */}
      {step === "execute" && (
        <section className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 mb-3">
            <svg
              className="animate-spin h-5 w-5 text-emerald-600"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900">
            Pushing to Google Play…
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Single batchUpdate call · this may take several seconds.
          </p>
        </section>
      )}

      {/* Step 5: Done */}
      {step === "done" && executeResult && (() => {
        const written = executeResult.rowsCreated + executeResult.rowsOverwritten;
        const notWritten = executeResult.rowsFailed + (executeResult.rowsRefused ?? 0);
        // H4.3 / P5 — the heading says what happened, not "complete" for a
        // batch that left rows out.
        const outcome = notWritten === 0 ? "complete" : written > 0 ? "partial" : "none";
        const refused = executeResult.refusedRows ?? [];
        const leftOut = refused.filter((r) => r.kind === "refused_in_file");
        const refusedAtPush = refused.filter((r) => r.kind !== "refused_in_file");
        const line = (r: { rowNumber: number; sku: string; reason: string }) =>
          r.reason.startsWith(`Row ${r.rowNumber} `) ? r.reason : `Row ${r.rowNumber} (${r.sku}): ${r.reason}`;
        return (
        <section
          className={`bg-white border rounded-xl p-6 ${
            outcome === "complete" ? "border-emerald-200" : outcome === "partial" ? "border-amber-200" : "border-red-200"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                outcome === "complete" ? "bg-emerald-100" : outcome === "partial" ? "bg-amber-100" : "bg-red-100"
              }`}
            >
              {outcome === "complete" ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              ) : (
                <AlertCircle className={`h-5 w-5 ${outcome === "partial" ? "text-amber-600" : "text-red-600"}`} />
              )}
            </div>
            <div className="flex-1">
              <h2 data-testid="done-heading" data-state={outcome} className="text-base font-semibold text-slate-900 mb-1">
                {outcome === "complete"
                  ? "Bulk import complete"
                  : outcome === "partial"
                    ? `Bulk import finished — ${notWritten} row(s) not imported`
                    : "Nothing was imported"}
                {outcome !== "complete" && (
                  <span className="font-normal text-slate-600">
                    {" "}(
                    {[
                      executeResult.rowsFailed > 0 ? `${executeResult.rowsFailed} failed at Google` : null,
                      (executeResult.rowsRefused ?? 0) > 0 ? `${executeResult.rowsRefused} not sent` : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    )
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500 mb-3">
                {appDisplayName ?? packageName} · {executeResult.rowsTotal} row(s) in the file ·{" "}
                {executeResult.durationMs}ms
              </p>
              <div data-testid="done-tiles" className="grid grid-cols-6 gap-2">
                <Stat label="Created" value={executeResult.rowsCreated} tone="emerald" />
                <Stat
                  label="Overwritten"
                  value={executeResult.rowsOverwritten}
                  tone="amber"
                />
                <Stat label="Skipped" value={executeResult.rowsSkipped} tone="slate" />
                <Stat label="Failed" value={executeResult.rowsFailed} tone="red" />
                {/* Rows never sent: refused at push (price, tier, custom) or
                    left out in the file (H4.3). Distinct from "Failed"
                    (Google-side errors). The five tiles before Custom sum
                    to the rows in the file. */}
                <Stat
                  label="Not sent"
                  value={executeResult.rowsRefused ?? 0}
                  tone="red"
                />
                {/* Phase 3 — per-item provenance at a glance: how many
                    items got prices the Manager typed rather than the
                    batch template. */}
                <Stat
                  label="Custom"
                  value={executeResult.customPricedRows ?? 0}
                  tone="violet"
                />
              </div>
              {/* H4.3 — EVERY row not sent, by name, none capped away. (Rows
                  Google failed are counted in "Failed"; the result carries no
                  per-row names for them.) */}
              {refused.length > 0 && (
                <div data-testid="done-refused-rows" className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
                  {leftOut.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-red-900 mb-1">
                        {leftOut.length} row(s) left out — refused in the file, not sent:
                      </p>
                      <ul className="space-y-0.5 text-[11px] text-red-800 max-h-48 overflow-y-auto">
                        {leftOut.map((r) => (
                          <li key={`${r.rowNumber}-${r.sku}`} data-kind={r.kind}>
                            · {line(r)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {refusedAtPush.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-red-900 mb-1">
                        {refusedAtPush.length} row(s) refused at push — not sent to Google:
                      </p>
                      <ul className="space-y-0.5 text-[11px] text-red-800 max-h-48 overflow-y-auto">
                        {refusedAtPush.map((r) => (
                          <li key={`${r.rowNumber}-${r.sku}`} data-kind={r.kind}>
                            · {line(r)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-6 flex gap-2">
                <button
                  onClick={() => {
                    router.push(
                      `/google-iap-management/apps/${encodeURIComponent(packageName)}`,
                    );
                    router.refresh();
                  }}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
                >
                  Back to IAPs
                </button>
                <button
                  onClick={() => {
                    setStep("pricing");
                    setFile(null);
                    setPreviewRows([]);
                    setPreviewWarnings([]);
                    setFileRefusedRows([]);
                    setPriceHeader(null);
                    setRetiredGt(null);
                    setConfirmPushOpen(false);
                    setExecuteResult(null);
                    // Reset the tracking state machine for a fresh cycle —
                    // without this, executeStartedRef staying true would
                    // block cancel-on-exit for the NEXT import's run
                    // before it's even executed, and the stale hubRunId
                    // (already closed) would linger until a new `start`
                    // call overwrites it.
                    setHubRunId(null);
                    executeStartedRef.current = false;
                    hubStartPromiseRef.current = null;
                    // "Import another" IS a fresh batch — unlike a
                    // re-preview of the same batch, customs must not carry
                    // over into unrelated work.
                    setCustomPrices({});
                    setCustomBaselineDrift({});
                    setCustomCarryNotice(null);
                    setCustomDialogSku(null);
                  }}
                  className="px-3 py-2 text-sm font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition"
                >
                  Import another
                </button>
              </div>
            </div>
          </div>
        </section>
        );
      })()}
    </div>
  );
}

/**
 * How prices are read from the file — a description, not a warning and not a
 * gate. Every sentence is measured behaviour of the preview + execute code at
 * this commit (H4.2: the app's currency takes NO part in pricing). Each H4
 * step that changes pricing changes this note IN THE SAME COMMIT — the
 * verbatim test pins the wording only; it cannot see a pricing change (T1,
 * bulk-import/file-currency-invariance.test.ts, does). H4.4 — the lead is
 * sentence (ii), "prices come only from the file": planned with C2.1, held
 * back until the pricing fix made it true.
 */
function PricingCurrencyNote() {
  const code = (c: string) => (
    <code className="px-1 bg-white border border-slate-200 rounded font-mono">{c}</code>
  );
  return (
    <div
      data-testid="pricing-currency-note"
      className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
    >
      <span className="font-semibold">Prices come only from the file.</span> The file needs
      exactly one {code("Price (XXX)")} column (e.g. {code("Price (USD)")}), in a currency Google
      Play bills in, and prices are read in that currency only — the app&apos;s currency is not
      used. A price header without its currency ({code("Price")} / Default Price / Base Price) or a
      second price column refuses the file; a row whose price cannot be sent exactly as written
      (more decimals than its currency allows, 0, or a &quot;.&quot; / &quot;,&quot; in a currency
      without decimals) is not imported.
      <ul className="mt-1 ml-4 list-disc space-y-0.5">
        <li>
          With a pricing template, a row takes the tier named after its SKU, else the tier whose
          price in the file&apos;s currency equals the file&apos;s price; countries the tier does not
          list, and rows with no matching tier, are converted by Google from the file&apos;s price.
          With Google Conversion every country is converted from the file&apos;s price.
        </li>
        <li>
          A country gets its own price only from a matched tier or from custom prices; custom
          prices overlay the file&apos;s price, which stays the conversion base. GT Price / GT
          Currency columns, if the file still has them, are not used.
        </li>
        <li>
          If Google&apos;s conversion fails (usually temporary — run the row again later) or returns no
          US price, a row whose price is not in USD is refused. A USD row is still sent.
        </li>
      </ul>
    </div>
  );
}

/**
 * [GOOGLE-bulkimport-drop-gt] (Manager Q1; wording approved at gate G0,
 * 2026-10-21) — the file still has the retired GT columns. A NOTICE only: it
 * never disables Push and never refuses a row — the columns are ignored
 * either way (excel-parser.ts). Rendered above the preview table, so it is
 * read before Push.
 */
function RetiredGtNotice({ gt }: { gt: RetiredGtColumns }) {
  const notice = googleRetiredGtWarning(gt);
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="retired-gt-notice"
      data-state={notice.kind}
      className={
        notice.kind === "data"
          ? "bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900"
          : "bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700"
      }
    >
      {notice.text}
    </div>
  );
}

/**
 * D0/D3 — the state of the IAP mirror that Preview's NEW/EXISTING comes from.
 * Three states, never collapsed: unreadable (red), never refreshed (amber,
 * blocks Preview), refreshed at <time> (neutral line).
 */
function MirrorSyncBanner({
  syncedAt,
  readError,
  refreshing,
  refreshError,
  onRefresh,
}: {
  syncedAt: string | null;
  readError: string | null;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}) {
  const refreshButton = (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-current px-2.5 py-1 text-xs font-semibold transition hover:bg-white/60 disabled:opacity-60"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
      {refreshing ? "Refreshing IAP list…" : "Refresh IAP list"}
    </button>
  );
  const refreshErrorLine = refreshError && (
    <span className="block mt-1 font-medium">{refreshError}</span>
  );

  if (syncedAt === null) {
    const unreadable = readError !== null;
    return (
      <div
        data-testid="mirror-sync-banner"
        data-state={unreadable ? "unreadable" : "never"}
        className={`text-xs rounded-lg px-3 py-2 border ${
          unreadable
            ? "text-red-900 bg-red-50 border-red-200"
            : "text-amber-900 bg-amber-50 border-amber-300"
        }`}
      >
        <span className="font-semibold">
          {unreadable
            ? "Could not read whether this app's IAP list has been refreshed."
            : "This app's IAP list has no complete refresh from Google on record."}
        </span>{" "}
        Preview is blocked: without a complete IAP list the tool cannot tell which SKUs
        already exist, and would send existing products as new ones.
        {unreadable && <span className="block mt-1">{readError}</span>}
        {refreshErrorLine}
        <div>{refreshButton}</div>
      </div>
    );
  }

  return (
    <div
      data-testid="mirror-sync-banner"
      data-state="synced"
      className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
    >
      IAP list last refreshed completely from Google:{" "}
      <time dateTime={syncedAt} className="font-mono">
        {new Date(syncedAt).toLocaleString()}
      </time>
      . New/Existing in the preview is based on that list.
      {refreshErrorLine}
      <div>{refreshButton}</div>
    </div>
  );
}

function StepHeader({ step }: { step: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: "pricing", label: "1. Pricing source" },
    { key: "upload", label: "2. Upload" },
    { key: "preview", label: "3. Preview" },
    { key: "done", label: "4. Done" },
  ];
  const activeIdx = (() => {
    if (step === "execute") return 3; // showing busy / about-to-finish
    return steps.findIndex((s) => s.key === step);
  })();
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
      {steps.map((s, i) => (
        <span
          key={s.key}
          className={
            i === activeIdx
              ? "px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium"
              : i < activeIdx
                ? "text-slate-400 line-through"
                : ""
          }
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Hotfix 19 — disambiguation banner (Q4.D).
 *
 *  Two visual states:
 *    - pending > 0  → amber ⚠ "N items need tier selection"
 *    - pending == 0 → blue  ℹ "N ambiguous items pre-selected — review or change"
 *                            (or "...— X changed by you, Y at default" when overridden)
 *  Renders only when status.ambiguous > 0 — no banner in the zero-ambiguity case. */
function TierBanner({
  status,
}: {
  status: { ambiguous: number; pending: number; changed: number; atDefault: number };
}) {
  if (status.pending > 0) {
    return (
      <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              {status.pending} item{status.pending === 1 ? "" : "s"} need{status.pending === 1 ? "s" : ""} tier selection.
            </p>
            <p className="text-xs text-amber-800 mt-1">
              Pick a tier for the highlighted row{status.pending === 1 ? "" : "s"} below before pushing.
            </p>
          </div>
        </div>
      </div>
    );
  }
  const headline =
    status.changed > 0
      ? `${status.ambiguous} ambiguous items — ${status.changed} changed by you, ${status.atDefault} at default.`
      : `${status.ambiguous} ambiguous item${status.ambiguous === 1 ? "" : "s"} pre-selected — review or change as needed.`;
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <svg
          className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div className="flex-1">
          <p className="text-sm font-semibold text-blue-900">{headline}</p>
          <p className="text-xs text-blue-800 mt-1">
            Rows priced the same as multiple template tiers — pick the tier whose regional prices you
            want applied. The tool no longer auto-picks silently.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "amber" | "slate" | "red" | "violet";
}) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : tone === "amber"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : tone === "red"
          ? "bg-red-50 text-red-800 border-red-200"
          : tone === "violet"
            ? "bg-violet-50 text-violet-800 border-violet-200"
            : "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <div className={`rounded-lg border p-2 ${cls}`}>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] font-medium uppercase tracking-wide mt-0.5">
        {label}
      </p>
    </div>
  );
}
