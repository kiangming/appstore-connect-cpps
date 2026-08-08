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
} from "lucide-react";

import { toast } from "sonner";

import { PreviewTable } from "./PreviewTable";
import {
  CustomPricesDialog,
  type CustomPriceSet,
} from "./CustomPricesDialog";
import { PricingSourceSelector } from "@/components/google-iap-management/iap-form/PricingSourceSelector";
import { PRICING_SOURCE_LABELS } from "@/lib/google-iap-management/pricing-source-labels";
import { validateDecimalForCurrency } from "@/lib/google-iap-management/google/currency-precision";
import {
  googleIapTemplateSpec,
  GOOGLE_LOCALE_OPTIONS,
} from "@/lib/google-iap-management/parsers/template-spec";
import { DownloadTemplateButton } from "@/components/ui/shared/DownloadTemplateButton";

export type PricingSource = "google_default" | "default_template" | "app_template";
export type RowDecision = "overwrite" | "skip" | "create";

export interface PreviewListing {
  locale: string;
  title: string;
  description: string;
}

export interface PreviewRegionOverride {
  region: string;
  currency: string;
  priceDecimal: string;
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

/** Cycle 43 — cross-currency resolution outcome surfaced by the Preview
 *  API per row. Drives:
 *   - whether the precision gate skips this row (raw price not sent)
 *   - the Resolved column display
 *   - the per-row refusal indicator banner */
export type PreviewResolution =
  | { kind: "same_currency" }
  | {
      kind: "cross_currency_resolved";
      anchorUsdMicros: string;
      chosenTier: string;
      appCurrencyPrice: {
        currency: string;
        priceMicros: string;
        priceDecimal: string;
      };
    }
  | { kind: "cross_currency_needs_choice"; anchorUsdMicros: string }
  | {
      kind: "cross_currency_refused";
      anchorUsdMicros: string | null;
      reason: string;
      refusalKind:
        | "google_default"
        | "template_miss"
        | "missing_entries"
        | "no_app_currency_entry";
    };

export interface PreviewRow {
  rowNumber: number;
  sku: string;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: PreviewRegionOverride[];
  listings: PreviewListing[];
  exists: boolean;
  decision: RowDecision;
  // Hotfix 19 — server-rendered candidate metadata.
  tierCandidates: PreviewTierCandidate[];
  defaultTierSelection: string | null;
  tierMatchedBy: "sku" | "currency_price" | "none";
  /** Cycle 43 — cross-currency resolution outcome. Defaults to
   *  `same_currency` when the server didn't populate it (legacy
   *  response shape backward-compat). */
  resolution?: PreviewResolution;
  /** Cycle 43 — parser provenance of the baseCurrency. "explicit" for
   *  "Price (XXX)" headers (drives header-first cross-currency
   *  detection); "inferred" for generic "Price"/"Default Price"/"Base
   *  Price" (drives value-based fallback). Optional for legacy preview
   *  responses; the orchestrator defaults to "inferred" when absent. */
  priceHeaderSource?: "explicit" | "inferred";
}

interface ExecuteResult {
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
  /** Cycle 43 — per-row cross-currency fail-soft refusals. */
  rowsRefused?: number;
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
  /** App-level Google Play defaults (Hotfix 4). Shown as a wizard banner
   *  and threaded into the execute payload so the orchestrator can stamp
   *  the row's baseCurrency to match Google's per-app enforcement. */
  appDefaultCurrency: string | null;
  appDefaultLanguage: string | null;
}

type Step = "pricing" | "upload" | "preview" | "execute" | "done";

export function BulkImportWizard({
  packageName,
  appId,
  appDisplayName,
  appDefaultCurrency,
  appDefaultLanguage,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pricing");

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
    () =>
      new Set(
        previewRows
          .filter((r) => customPrices[r.sku] && r.decision !== "skip")
          .map((r) => r.sku),
      ),
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
      const res = await fetch(
        `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/bulk-import/preview`,
        { method: "POST", body: form },
      );
      const body = (await res.json().catch(() => ({}))) as {
        rows?: Array<Omit<PreviewRow, "decision">>;
        warnings?: string[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        if (body.errors && body.errors.length > 0) {
          setUploadError(body.errors.join(" · "));
        } else {
          setUploadError(body.error ?? `Preview failed (HTTP ${res.status}).`);
        }
        return;
      }
      const rows: PreviewRow[] = (body.rows ?? []).map((r) => ({
        ...r,
        // Defensive defaults — older clients may not carry these fields.
        tierCandidates: r.tierCandidates ?? [],
        defaultTierSelection: r.defaultTierSelection ?? null,
        tierMatchedBy: r.tierMatchedBy ?? "none",
        decision: r.exists ? "create" : "create",
      }));
      // Hotfix 19: seed tierSelections — every row with candidates
      // starts on its primary tier (Q5.B). Manager can change via dropdown.
      const seedSelections: Record<number, string> = {};
      for (const r of rows) {
        if (r.tierCandidates.length >= 1) {
          const pick = r.defaultTierSelection ?? r.tierCandidates[0].identifier;
          if (pick) seedSelections[r.rowNumber] = pick;
        }
      }
      setPreviewRows(rows);
      setPreviewWarnings(body.warnings ?? []);
      setTierSelections(seedSelections);

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
          body: JSON.stringify({
            pricingSource,
            sourceFilename: file?.name ?? null,
            // Threaded to the execute route's `finally` block, which
            // closes the Hub run with the batch's terminal status. Null
            // when no run was opened (tracking unconfigured/disabled,
            // start failed, or the 1s cap won) — the route treats that
            // identically to a missing field (no-op).
            hub_run_id: runIdForExecute,
            rows: previewRows.map((r) => ({
              rowNumber: r.rowNumber,
              sku: r.sku,
              // Cycle 43 (2026-06-01): send the parser-resolved
              // baseCurrency verbatim. Pre-Cycle-43 the wizard stomped
              // this to appDefaultCurrency (Hotfix 4) so the legacy
              // batchUpdate endpoint's "defaultPrice.currency == app
              // currency" check would pass; Hotfix 14 migrated to the
              // Monetization API which accepts per-row currency, and
              // Cycle 43's orchestrator cross-currency pre-pass now
              // honours the parser's explicit "Price (XXX)" declaration
              // (header-first trigger) — the stomp obscured this and
              // forced the value-based fallback even on explicit
              // headers, which silently mishandled integer cross-
              // currency values like "25 USD" → "25 VND".
              baseCurrency: r.baseCurrency,
              basePriceDecimal: r.basePriceDecimal,
              regionOverrides: r.regionOverrides,
              listings: r.listings,
              decision: r.decision,
              // Cycle 43 — forward parser header provenance so the
              // orchestrator's pre-pass can choose explicit_header vs
              // value_based trigger correctly. Default "inferred" when
              // a stale preview response lacks the field.
              priceHeaderSource: r.priceHeaderSource ?? "inferred",
              // Hotfix 19: explicit tier selection (null when no
              // template lookup applied). Orchestrator honours it
              // verbatim — no silent fallback. The companion fields
              // let the audit log distinguish:
              //   - single_match           (1 candidate, no choice)
              //   - default_accepted       (>1 candidates, primary kept)
              //   - manager_explicit       (>1 candidates, override)
              //   - no_candidates_auto_bootstrap (0 candidates)
              chosenTierIdentifier:
                tierSelections[r.rowNumber] ?? null,
              defaultTierIdentifier: r.defaultTierSelection,
              tierCandidateCount: r.tierCandidates.length,
              // Phase 3 — per-item custom prices. Sent when the row has a
              // saved set and is not set to Skip (activeCustomSkus encodes
              // both).
              //
              // ⚠ SCOPE — the pricing source is deliberately NOT a
              // condition here. This once read "…and the batch source is a
              // template", because custom was template-only; custom now
              // applies under ALL THREE sources, and under Google
              // Conversion it is a sparse overlay on the base price. Adding
              // a source condition back would silently stop sending
              // customs on that path — the same shape of bug as the
              // unqualified "no exception" defaultPrice comment, which
              // cost two defects last cycle. Skip is the only deactivator.
              customPrices: activeCustomSkus.has(r.sku)
                ? (() => {
                    const set = customPrices[r.sku];
                    return {
                      entries: set.entries,
                      baselineTier:
                        set.baseline.kind === "template"
                          ? set.baseline.identifier
                          : null,
                      editedAt: set.editedAt,
                    };
                  })()
                : null,
            })),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as ExecuteResult & {
        error?: string;
      };
      if (!res.ok) {
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
  const canContinueFromPreview =
    counts.pending === 0 &&
    previewRows.length > 0 &&
    precisionViolations.length === 0 &&
    tierStatus.pending === 0;

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

      {/* App defaults banner (Hotfix 4) */}
      {(appDefaultCurrency || appDefaultLanguage) && (
        <div className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <span className="font-semibold">
            Importing to {appDisplayName ?? packageName}:
          </span>{" "}
          {appDefaultCurrency && (
            <>
              rows will be sent with currency{" "}
              <code className="px-1 bg-white border border-emerald-200 rounded font-mono">
                {appDefaultCurrency}
              </code>{" "}
            </>
          )}
          {appDefaultLanguage && (
            <>
              · default locale{" "}
              <code className="px-1 bg-white border border-emerald-200 rounded font-mono">
                {appDefaultLanguage}
              </code>
            </>
          )}
          {appDefaultCurrency && (
            <span className="block mt-1 text-emerald-700">
              The Excel column header reads &quot;Price (USD)&quot; but the
              numeric values are interpreted in the app&apos;s configured
              currency — Google enforces app-wide consistency.
            </span>
          )}
        </div>
      )}
      {!appDefaultCurrency && !appDefaultLanguage && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          App defaults not cached. Run <strong>Refresh from Google</strong> on
          the app detail page first — otherwise rows will be sent as USD and
          Google will reject them if the app is configured for any other
          currency.
        </div>
      )}

      {/* Step 1: Pricing source */}
      {step === "pricing" && (
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-1">
            Pricing source
          </h2>
          <p className="text-xs text-slate-500 mb-4">
            Q-GIAP.E batch-level. Applied to every row in this import. For
            template modes, each row&apos;s SKU is matched to a template tier
            identifier; rows without a matching tier fall back to{" "}
            <strong>Google Conversion</strong> — the row&apos;s inline base
            price + GT Price override, converted by Google into every other
            country.
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
              disabled={!file || uploading}
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
                ; dropped where it does not (
                <span className="font-mono">{customCarryNotice.dropped.join(", ")}</span>
                ).
              </p>
            </div>
          )}

          {previewWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-medium text-amber-900 mb-1">
                Parse warnings ({previewWarnings.length})
              </p>
              <ul className="space-y-0.5 text-[11px] text-amber-800 max-h-32 overflow-y-auto">
                {previewWarnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
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
              onClick={handleExecute}
              disabled={!canContinueFromPreview || executing}
              title={
                precisionViolations.length > 0
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
              scope={pricingSource === "app_template" ? "APP" : "GLOBAL"}
              appId={appId}
              packageName={packageName}
              appDefaultCurrency={appDefaultCurrency}
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
      {step === "done" && executeResult && (
        <section className="bg-white border border-emerald-200 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-slate-900 mb-1">
                Bulk import complete
              </h2>
              <p className="text-xs text-slate-500 mb-3">
                {appDisplayName ?? packageName} · {executeResult.durationMs}ms
              </p>
              <div className="grid grid-cols-6 gap-2">
                <Stat label="Created" value={executeResult.rowsCreated} tone="emerald" />
                <Stat
                  label="Overwritten"
                  value={executeResult.rowsOverwritten}
                  tone="amber"
                />
                <Stat label="Skipped" value={executeResult.rowsSkipped} tone="slate" />
                <Stat label="Failed" value={executeResult.rowsFailed} tone="red" />
                {/* Cycle 43 — per-row cross-currency fail-soft refusals.
                    Distinct from "Failed" (Google-side errors): refused rows
                    were rejected by our pre-pass (unresolvable cross-currency)
                    and never sent to Google. */}
                <Stat
                  label="Refused"
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
              {executeResult.refusedRows && executeResult.refusedRows.length > 0 && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-xs font-medium text-red-900 mb-1">
                    {executeResult.refusedRows.length} row(s) refused (per-row
                    fail-soft — not sent to Google):
                  </p>
                  <ul className="space-y-0.5 text-[11px] text-red-800 max-h-40 overflow-y-auto">
                    {executeResult.refusedRows.slice(0, 20).map((r) => (
                      <li key={`${r.rowNumber}-${r.sku}`}>
                        · Row {r.rowNumber} ({r.sku}): {r.reason}
                      </li>
                    ))}
                    {executeResult.refusedRows.length > 20 && (
                      <li className="italic text-red-700">
                        …and {executeResult.refusedRows.length - 20} more.
                      </li>
                    )}
                  </ul>
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
      )}
    </div>
  );
}

/** Hotfix 28 — pure helper extracted from the wizard's
 *  `precisionViolations` memo so unit tests can pin per-row currency
 *  validation behaviour without rendering the whole wizard.
 *
 *  Validates each non-skipped row's `basePriceDecimal` against its own
 *  parser-resolved `baseCurrency`. The parser's currency comes from
 *  the column header ("Price (USD)" → USD) and falls back to
 *  appDefaultCurrency only for generic "Price" / "Default Price" /
 *  "Base Price" headers (excel-parser.ts:resolvePriceColumn). The
 *  caller's responsibility is to give us `previewRows` with
 *  `baseCurrency` already populated.
 *
 *  Skip-decision rows are excluded — they're not sent to Google so
 *  their numeric shape doesn't matter. */
export function computePrecisionViolations(
  previewRows: ReadonlyArray<PreviewRow>,
): Array<{ rowNumber: number; sku: string; error: string }> {
  const violations: Array<{ rowNumber: number; sku: string; error: string }> = [];
  for (const row of previewRows) {
    if (row.decision === "skip") continue;
    if (!row.baseCurrency) continue;
    // Cycle 43: cross-currency rows do NOT send the raw basePriceDecimal —
    // they either resolve via template (push uses the resolved app-currency
    // amount, not the raw USD anchor), need a chooser pick, or get refused
    // (per-row fail-soft, also doesn't send raw). In all three cases the
    // precision check doesn't apply because the raw value never reaches
    // Google. Only same-currency rows are precision-gated.
    const resolutionKind = row.resolution?.kind ?? "same_currency";
    if (resolutionKind !== "same_currency") continue;
    const err = validateDecimalForCurrency(row.basePriceDecimal, row.baseCurrency);
    if (err) {
      violations.push({ rowNumber: row.rowNumber, sku: row.sku, error: err });
    }
  }
  return violations;
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
