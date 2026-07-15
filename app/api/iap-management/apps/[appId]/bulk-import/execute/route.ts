/**
 * POST /api/iap-management/apps/[appId]/bulk-import/execute
 *
 * Synchronous bulk-import orchestration. Accepts the parsed Excel + companion
 * screenshot files via multipart FormData. Runs the full per-IAP Apple
 * orchestration with bounded concurrency (5 parallel per Manager investigation
 * lock).
 *
 * Per-IAP steps (CREATE path):
 *   1. POST /v2/inAppPurchases — create shell on Apple.
 *   2. POST /v1/inAppPurchaseLocalizations — one per filled locale.
 *   3. POST /v1/inAppPurchasePriceSchedules (IAP.o.9a) — map local tier_id
 *      to Apple price-point id and set the manual price (non-fatal).
 *   4. POST /v1/inAppPurchaseAppStoreReviewScreenshots reserve + PUT chunks
 *      + PATCH confirm (deferral 1 absorbed).
 *   5. (optional, when submit_on_create=true) `checkSubmitEligibility`
 *      (IAP.q.2, lib/iap-management/apple/submit-eligibility.ts) polls for
 *      READY_TO_SUBMIT — waiting out the propagation lag between screenshot
 *      confirm and submit — then runs the decision through the SAME Cycle 32
 *      `partitionByStateGuard` the submit-batch endpoint uses. POST
 *      /v1/inAppPurchaseSubmissions only fires when Apple's fresh state is
 *      READY_TO_SUBMIT; otherwise the row is left SUCCESS/created with
 *      `submit_outcome: "deferred"` so it can be submitted later via Submit
 *      Selected, never a hard error.
 *   6. Insert iap_mgmt.iaps + iap_localizations + iap_screenshots audit rows.
 *
 * OVERWRITE path: PATCH attributes + DELETE existing localizations + POST new
 * + (IAP.o.9a) re-set price schedule when the resolved tier differs from the
 * locally cached row. Screenshot replace path runs unchanged (IAP.o.8a).
 *
 * The response is the full result summary; no polling endpoint in v1.
 */

import { NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  createInAppPurchase,
  createInAppPurchaseLocalization,
  updateInAppPurchaseLocalization,
  deleteInAppPurchaseLocalization,
  listAllInAppPurchases,
  listInAppPurchaseLocalizations,
  reserveInAppPurchaseScreenshot,
  uploadScreenshotToOperations,
  confirmInAppPurchaseScreenshot,
  submitInAppPurchase,
  updateInAppPurchase,
} from "@/lib/iap-management/apple/client";
import { replaceScreenshotOnApple } from "@/lib/iap-management/apple/screenshot-upload";
import { setAvailabilityToAllTerritories } from "@/lib/iap-management/apple/availabilities";
import { decideOverwritePricing } from "@/lib/iap-management/bulk-import/overwrite-pricing-decision";
import { planLocalizationSync } from "@/lib/iap-management/bulk-import/localization-sync";
import {
  applyPricingSchedule,
  type PricingSource,
  type PricingOutcome,
} from "@/lib/iap-management/apple/pricing-orchestration";
import { pollIapReadyForPricing } from "@/lib/iap-management/apple/poll-iap-ready";
import { checkSubmitEligibility } from "@/lib/iap-management/apple/submit-eligibility";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { iapDb } from "@/lib/iap-management/db";
import {
  ensureAppRegistered,
} from "@/lib/iap-management/queries/iaps";
import { parseIapItemsXlsx } from "@/lib/iap-management/parsers/iap-items";
import { matchScreenshotToProductId } from "@/lib/iap-management/parsers/screenshot-matcher";
import {
  resolveConflicts,
  enrichWithTiers,
  type ConflictMode,
  type ConflictDecision,
} from "@/lib/iap-management/bulk-import/conflict-resolution";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";
import { listUsdTiersForSource } from "@/lib/iap-management/queries/templates";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import {
  createBatchPricePointCatalog,
  type BatchPricePointCatalog,
} from "@/lib/iap-management/apple/batch-price-point-catalog";
import { log } from "@/lib/logger";
import {
  finalizeHubTracking,
  type HubTerminalStatus,
} from "@/lib/iap-management/hub-tracking/tracking";
import { computeBulkImportTerminalStatus } from "@/lib/iap-management/hub-tracking/status-mapping";
import type {
  AscCredentials,
} from "@/lib/asc-jwt";

export const runtime = "nodejs";

/**
 * Hotfix 26 — concurrency dropped 5 → 2 after Manager production
 * verification surfaced Apple ASC 429 cascades in Bulk Import. Each
 * row generates ~6 sequential Apple calls (create → state → locales →
 * screenshot → pricing → availability); two workers in parallel cap
 * peak in-flight requests at ~2 and stay well under Apple's documented
 * 1 req/sec average per token.
 */
const CONCURRENCY_LIMIT = 2;

/**
 * Hotfix 26 — fixed inter-row delay (ms) applied at the end of every
 * `orchestrateOne` invocation. Provides headroom for Apple's bucket
 * to refill between rows + lets concurrent workers stagger naturally
 * if they finish at the same moment. Bumping this is the cheapest knob
 * to dial down rate-limit pressure further.
 */
const INTER_ROW_DELAY_MS = 1000;

/**
 * Per-row 429-aware retry telemetry. Mutated by `trackedWithRetry` and
 * persisted to `actions_log.payload` for each row so Manager can audit
 * rate-limit impact after a batch completes (and so future Cycle 40
 * telemetry can roll up batch-level statistics).
 */
interface RetryCounters {
  rate429_count: number;
  retry_attempts: number;
  backoff_total_ms: number;
  longest_backoff_ms: number;
}

function createRetryCounters(): RetryCounters {
  return {
    rate429_count: 0,
    retry_attempts: 0,
    backoff_total_ms: 0,
    longest_backoff_ms: 0,
  };
}

/**
 * Thin wrapper around `withRetry` that mutates a counters bag in place
 * each time the 429 backoff path fires. Pass the SAME counters instance
 * through every Apple call in a single row's orchestration so the
 * per-row audit captures cumulative retry impact across all stages
 * (create + state + locales + screenshot + pricing + availability).
 */
function trackedWithRetry<T>(
  counters: RetryCounters,
  fn: () => Promise<T>,
): Promise<T> {
  return withRetry(fn, {
    onRetry: ({ delayMs }) => {
      counters.rate429_count += 1;
      counters.retry_attempts += 1;
      counters.backoff_total_ms += delayMs;
      if (delayMs > counters.longest_backoff_ms) {
        counters.longest_backoff_ms = delayMs;
      }
    },
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface PerIapResult {
  product_id: string;
  disposition: "CREATE" | "OVERWRITE" | "SKIP" | "ERROR";
  status: "SUCCESS" | "ERROR" | "SKIPPED";
  apple_iap_id?: string;
  failed_locales?: string[];
  screenshot_uploaded?: boolean;
  /** OVERWRITE-only — explains the screenshot outcome when a companion file
   *  was present. Surfaces in Step 4 results so Manager sees why an Apple
   *  screenshot did/didn't change. (IAP.o.8a) */
  screenshot_note?:
    | "replaced"
    | "uploaded-new"
    | "no-file"
    | "delete-locked"
    | "failed";
  /** IAP.o.9a — set when pricing schedule was applied. False covers both the
   *  "no tier resolved" and "Apple-side mismatch" paths; `pricing_outcome`
   *  narrows the reason for UI surface + audit. */
  price_schedule_set?: boolean;
  pricing_outcome?: PricingOutcome["kind"];
  pricing_error?: string;
  /** Problem 2 fix: per-territory overrides that found no Apple price-point
   *  match on a `partial-template-fail` outcome. The base price + matched
   *  territories DID apply; these territories fell back to Apple's
   *  auto-equalization. Surfaced so the UI can show "Partial: N unmatched"
   *  with the exact territories instead of a misleading "Price failed". */
  pricing_missing?: Array<{ territory_code: string; customer_price: number }>;
  /** Cycle 37 Phase 1 — set true when the CREATE path successfully
   *  defaulted the IAP availability to "All territories." False when
   *  Apple rejected the call (recorded in `availability_error`); absent
   *  on OVERWRITE rows since Q5.A leaves existing IAPs alone. */
  availability_set?: boolean;
  availability_error?: string;
  submitted?: boolean;
  /** IAP.q.2 — set whenever submit was attempted (screenshot ok + no failed
   *  locales). "submitted": the state guard passed and Apple accepted the
   *  submission (mirrors `submitted: true`). "deferred": the post-screenshot
   *  poll + state guard did not observe READY_TO_SUBMIT — the IAP stays
   *  CREATE/SUCCESS, submittable later via Submit Selected. "failed": the
   *  guard passed (fresh state WAS READY_TO_SUBMIT) but Apple's submit call
   *  itself errored — a genuine submit failure, not a readiness problem. */
  submit_outcome?: "submitted" | "deferred" | "failed";
  /** Present when submit_outcome === "deferred" — Apple's freshest observed
   *  state (e.g. "MISSING_METADATA", or "UNKNOWN" if every poll attempt
   *  errored) at the moment the state guard blocked submission. */
  submit_deferred_state?: string;
  /** Present when submit_outcome === "failed". */
  submit_error?: string;
  stage?: string;
  error?: string;
  /** Hotfix 26 — per-row Apple 429 telemetry. Absent on rows that never
   *  touched Apple (SKIP / validation ERROR); zeroes when no 429 fired. */
  rate_limit?: RetryCounters;
}

interface ExecuteSummary {
  batch_id: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: PerIapResult[];
  /** Hotfix 26 — batch-level Apple 429 telemetry roll-up. Sums per-row
   *  counters so the UI can render a single chip "X retries, Yms backoff
   *  total" instead of digging into every row. */
  rate_limit_total: RetryCounters & { rows_throttled: number };
}

/**
 * Hub-tracking lifecycle state, threaded by reference through `runExecute`.
 * `runId` is parsed as early as the request body is available (its own
 * FormData field, independent of `config` JSON parsing); `status`/
 * `errorMessage` default to FAILED and are only overwritten right before
 * a legitimate exit, so the outer `POST` wrapper's `finally` closes the Hub
 * run correctly on every early-return AND on any unforeseen exception.
 */
interface HubTrackingState {
  runId: string | null;
  status: HubTerminalStatus;
  errorMessage?: string;
}

export async function POST(
  req: Request,
  ctx: { params: { appId: string } },
) {
  const tracking: HubTrackingState = { runId: null, status: "FAILED" };
  try {
    return await runExecute(req, ctx, tracking);
  } finally {
    await finalizeHubTracking(tracking.runId, tracking.status, tracking.errorMessage);
  }
}

async function runExecute(
  req: Request,
  ctx: { params: { appId: string } },
  tracking: HubTrackingState,
): Promise<NextResponse> {
  let session;
  try {
    // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      tracking.errorMessage = err.message;
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
  const actor = session.user.email ?? "unknown";

  // ── Parse multipart FormData ─────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    tracking.errorMessage = "Invalid form body";
    return NextResponse.json({ error: "Invalid form body" }, { status: 400 });
  }

  // Parsed as early as the body is available — its own field, not nested in
  // `config`, so it's still readable even if the config JSON below fails.
  const hubRunIdRaw = form.get("hub_run_id");
  tracking.runId =
    typeof hubRunIdRaw === "string" && hubRunIdRaw.length > 0 ? hubRunIdRaw : null;

  const excel = form.get("excel");
  if (!(excel instanceof File)) {
    tracking.errorMessage = 'Missing "excel" field (xlsx file).';
    return NextResponse.json(
      { error: 'Missing "excel" field (xlsx file).' },
      { status: 400 },
    );
  }

  const screenshots = new Map<string, File>();
  for (const [key, value] of form.entries()) {
    if (key.startsWith("screenshot:") && value instanceof File) {
      screenshots.set(key.slice("screenshot:".length), value);
    }
  }

  const configRaw = form.get("config");
  let config: {
    default_mode: ConflictMode;
    overrides?: Record<string, ConflictMode>;
    /** Per-productId tier_id override from the Manager (IAP.o.5 Issue C). */
    tier_overrides?: Record<string, string>;
    submit_on_create?: boolean;
    /** IAP.p1.g: batch-level pricing source per Q-E. APP_TEMPLATE resolves
     *  to the bulk-import's app_id server-side; client only sends the kind. */
    pricing_source?: PricingSource["kind"];
  };
  try {
    config = JSON.parse(
      typeof configRaw === "string" ? configRaw : "{}",
    );
    if (config.default_mode !== "OVERWRITE" && config.default_mode !== "SKIP") {
      config.default_mode = "OVERWRITE";
    }
  } catch {
    tracking.errorMessage = 'Invalid "config" field (expected JSON).';
    return NextResponse.json(
      { error: 'Invalid "config" field (expected JSON).' },
      { status: 400 },
    );
  }

  // ── Re-parse Excel server-side (don't trust the client) ──────────────────
  let parsed;
  try {
    parsed = await parseIapItemsXlsx(excel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Parse failed";
    tracking.errorMessage = msg;
    return NextResponse.json({ error: msg }, { status: 422 });
  }

  // ── Resolve Apple appleAppId → internal UUID + fetch existing IAPs ──────
  let creds: AscCredentials;
  let internalAppId: string;
  let existingByProductId: Map<string, string>;
  try {
    creds = await getActiveAccount();
    const appRes = await getApp(creds, ctx.params.appId);
    internalAppId = await ensureAppRegistered({
      apple_app_id: ctx.params.appId,
      bundle_id: appRes.data.attributes.bundleId,
      name: appRes.data.attributes.name,
      asc_account_id: creds.id,
    });
    const existingRes = await listAllInAppPurchases(creds, ctx.params.appId);
    existingByProductId = new Map(
      (existingRes.data ?? []).map((iap) => [iap.attributes.productId, iap.id]),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Apple sync failed";
    await log("iap-bulk-execute", `apple resolve failed: ${msg}`, "ERROR");
    tracking.errorMessage = msg;
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── IAP.p1.g: resolve pricing source — Q-E batch-level applies to every row.
  //    Resolved BEFORE the tier gate so the gate (enrichWithTiers) and the
  //    pricing application (applyPricingSchedule) read ONE source of truth.
  //    Cycle 43: pre-fix the gate always read the legacy price_tier_territories
  //    cache via listUsdTiers(), diverging from the template the orchestrator
  //    applies — new template tiers ERRORed here before reaching pricing.
  const pricingSourceKind: PricingSource["kind"] = config.pricing_source ?? "APPLE";
  const pricingSource: PricingSource =
    pricingSourceKind === "APP_TEMPLATE"
      ? { kind: "APP_TEMPLATE", app_id: internalAppId }
      : pricingSourceKind === "DEFAULT_TEMPLATE"
        ? { kind: "DEFAULT_TEMPLATE" }
        : { kind: "APPLE" };
  console.log(
    `[bulk-execute] pricing source=${pricingSource.kind}`,
  );

  // ── Conflict resolution + tier inference (IAP.h2) ───────────────────────
  const conflicts = resolveConflicts({
    parsed: parsed.items,
    existing_product_ids: new Set(existingByProductId.keys()),
    default_mode: config.default_mode,
    overrides: config.overrides,
  });
  // Cycle 43: resolve USD tiers from the SELECTED source (same helper the
  // preview page uses). PricingSource is structurally a UsdTierSource.
  let usdTiers: UsdTierEntry[];
  try {
    usdTiers = await listUsdTiersForSource(pricingSource);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "USD tiers fetch failed";
    tracking.errorMessage = msg;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  const enriched = enrichWithTiers(conflicts, usdTiers);

  // Apply Manager's per-row tier overrides (IAP.o.5 Issue C). Wins over the
  // auto-resolved tier from enrichWithTiers. tier_source surfaces in the
  // audit log via persistResult when the override is present.
  const tierOverrides = config.tier_overrides ?? {};
  const resolved = {
    ...enriched,
    decisions: enriched.decisions.map((d) => {
      const override = tierOverrides[d.product_id];
      if (
        override &&
        (d.disposition === "CREATE" || d.disposition === "OVERWRITE")
      ) {
        return { ...d, resolved_tier_id: override };
      }
      return d;
    }),
  };

  const db = iapDb();

  // Pre-load existing local tier_id per productId so the OVERWRITE pricing
  // conditional can compare without an extra round-trip per row (IAP.o.9a).
  // Failing this query is non-fatal — overwrite pricing then re-applies
  // unconditionally, which is idempotent on Apple's side (replace-all POST).
  let existingTierByProductId: Map<string, string | null> = new Map();
  try {
    const existingLocal = await db
      .from("iaps")
      .select("product_id, tier_id")
      .eq("app_id", internalAppId);
    if (existingLocal.data) {
      existingTierByProductId = new Map(
        (existingLocal.data as Array<{ product_id: string; tier_id: string | null }>)
          .map((row) => [row.product_id, row.tier_id]),
      );
    }
  } catch (err) {
    await log(
      "iap-bulk-execute",
      `existing tier cache lookup failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
  }

  const batchIns = await db
    .from("import_batches")
    .insert({
      app_id: internalAppId,
      imported_by: actor,
      template_version: "iap-items-v1",
      total_rows: parsed.items.length,
      status: "IN_PROGRESS",
      notes: `Bulk import: ${resolved.counts.create} create + ${resolved.counts.overwrite} overwrite + ${resolved.counts.skip} skip + ${resolved.counts.error} error`,
    })
    .select("id")
    .single();
  if (batchIns.error || !batchIns.data) {
    tracking.errorMessage = `audit batch open failed: ${batchIns.error?.message}`;
    return NextResponse.json(
      { error: `audit batch open failed: ${batchIns.error?.message}` },
      { status: 500 },
    );
  }
  const batchId = (batchIns.data as { id: string }).id;

  // Build tier_id → USA/USD customer_price lookup once (IAP.o.10a). Apple
  // price-point matching switched from priceTier integer (volatile across
  // Apple's 2024 numbering rollover) to customerPrice string — local USD is
  // the canonical match key. Cycle 43: built from the SAME source-aware
  // `usdTiers` the gate used above — never a second list (a divergence here
  // is precisely the class of bug this fix closes).
  const usdPriceByTier = new Map<string, number>();
  for (const t of usdTiers) {
    usdPriceByTier.set(t.tier_id, t.customer_price);
  }
  console.log(`[bulk-execute] pricing source=${pricingSource.kind} batch=${batchId}`);

  // Cycle 44: one batch-level price-point catalog shared across every row.
  // Per-territory price points are fetched ONCE for the whole batch and each
  // item's price-point id is derived locally — collapsing the prior
  // ~175 GETs/item fan-out. Guarded + auto-falls-back to per-item fetch if
  // Apple's id encoding ever diverges (see batch-price-point-catalog.ts).
  const pricePointCatalog = createBatchPricePointCatalog(creds);

  // ── Orchestrate per-IAP with bounded concurrency ────────────────────────
  //    Hotfix 26 — concurrency 2 (was 5) + 1000ms inter-row delay so each
  //    worker spaces its successive rows. Manager-locked tradeoff: ~4-5
  //    min for 50 items vs ~1 min before, in exchange for surviving Apple's
  //    documented 1 req/sec average per token.
  const results: PerIapResult[] = await withConcurrency(
    resolved.decisions,
    CONCURRENCY_LIMIT,
    async (decision, index) => {
      const result = await orchestrateOne({
        creds,
        decision,
        screenshots,
        submit: Boolean(config.submit_on_create),
        existingByProductId,
        existingTierByProductId,
        usdPriceByTier,
        appleAppId: ctx.params.appId,
        internalAppId,
        batchId,
        actor,
        tierOverrides,
        pricingSource,
        pricePointCatalog,
        // Hotfix 26 — one counter bag per row, mutated by every
        // trackedWithRetry call across the row's stages.
        rateCounters: createRetryCounters(),
      });
      // Skip the trailing delay on the very last decision a worker may
      // pick up — cheap optimisation; the overhead at batch end is tiny
      // but worth it on small batches.
      if (index < resolved.decisions.length - 1) {
        await sleep(INTER_ROW_DELAY_MS);
      }
      return result;
    },
  );

  // ── Tally + close audit batch ───────────────────────────────────────────
  const succeeded = results.filter((r) => r.status === "SUCCESS").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  const failed = results.filter((r) => r.status === "ERROR").length;

  // Hotfix 26 — batch-level rate-limit roll-up. Aggregates per-row 429
  // telemetry so the wizard summary + the batch audit row both surface
  // how much Apple throttled this run.
  const rate_limit_total = results.reduce(
    (acc, r) => {
      const rl = r.rate_limit;
      if (!rl) return acc;
      acc.rate429_count += rl.rate429_count;
      acc.retry_attempts += rl.retry_attempts;
      acc.backoff_total_ms += rl.backoff_total_ms;
      if (rl.longest_backoff_ms > acc.longest_backoff_ms) {
        acc.longest_backoff_ms = rl.longest_backoff_ms;
      }
      if (rl.rate429_count > 0) acc.rows_throttled += 1;
      return acc;
    },
    {
      ...createRetryCounters(),
      rows_throttled: 0,
    } as RetryCounters & { rows_throttled: number },
  );

  await db
    .from("import_batches")
    .update({
      status: failed === 0 ? "COMPLETE" : "COMPLETE", // COMPLETE captures partial too
      created_count: succeeded,
      overwritten_count: results.filter(
        (r) => r.status === "SUCCESS" && r.disposition === "OVERWRITE",
      ).length,
      skipped_count: skipped,
      failed_count: failed,
    })
    .eq("id", batchId);

  await db.from("actions_log").insert({
    batch_id: batchId,
    actor,
    action_type: "BULK_IMPORT_BATCH",
    payload: {
      app_id: ctx.params.appId,
      total: parsed.items.length,
      counts: { succeeded, skipped, failed },
      conflict_counts: resolved.counts,
      // Hotfix 26 — batch-level 429 telemetry for post-run audit.
      rate_limit: rate_limit_total,
      concurrency_limit: CONCURRENCY_LIMIT,
      inter_row_delay_ms: INTER_ROW_DELAY_MS,
      // Cycle 44 — price-point fetch amortization: territories fetched once
      // for the batch vs the prior per-item fan-out. `derivation_enabled`
      // false means Apple's id encoding diverged and the batch fell back to
      // per-item fetches.
      price_point_catalog: pricePointCatalog.stats(),
    },
  });

  // ── Hub-tracking terminal status (SUCCESS/FAILED/PARTIAL) ──────────────
  const total = parsed.items.length;
  const terminal = computeBulkImportTerminalStatus({ total, succeeded, failed });
  tracking.status = terminal.status;
  tracking.errorMessage = terminal.errorMessage;

  const summary: ExecuteSummary = {
    batch_id: batchId,
    total,
    succeeded,
    failed,
    skipped,
    results,
    rate_limit_total,
  };
  return NextResponse.json(summary);
}

// ─── Per-IAP orchestration ──────────────────────────────────────────────────

interface OrchestrateArgs {
  creds: AscCredentials;
  decision: ConflictDecision;
  /** Pre-loaded local tier_id keyed by product_id (IAP.o.9a OVERWRITE
   *  conditional). Missing key = no local cache available, treat as "differs"
   *  and re-apply unconditionally (idempotent on Apple). */
  existingTierByProductId: Map<string, string | null>;
  /** Pre-loaded tier_id → USA/USD customer_price (IAP.o.10a). Source of
   *  truth for matching against Apple's price-point customerPrice attribute. */
  usdPriceByTier: Map<string, number>;
  screenshots: Map<string, File>;
  submit: boolean;
  existingByProductId: Map<string, string>;
  /** Apple's numeric App Store app id (from URL param) — needed for create. */
  appleAppId: string;
  /** Internal iap_mgmt.apps.id — needed for DB FK. */
  internalAppId: string;
  batchId: string;
  actor: string;
  /** Per-productId tier override map (IAP.o.5 Issue C). Used by persistResult
   *  to label tier_source as MANUAL_OVERRIDE in the audit log. */
  tierOverrides: Record<string, string>;
  /** IAP.p1.g: batch-level pricing source applied to every CREATE/OVERWRITE
   *  row. Already discriminated server-side (APP_TEMPLATE carries the
   *  internal app_id). */
  pricingSource: PricingSource;
  /** Cycle 44: batch-level price-point catalog shared across all rows so the
   *  per-territory price points are fetched once per batch, not once per IAP. */
  pricePointCatalog: BatchPricePointCatalog;
  /** Hotfix 26 — per-row 429 telemetry. Populated by `orchestrateOne`
   *  before delegating to runCreate/runOverwrite; every Apple call in
   *  the row's stages threads through `trackedWithRetry(args.rateCounters, …)`
   *  so the final persisted row sees cumulative impact. */
  rateCounters: RetryCounters;
}

async function orchestrateOne(args: OrchestrateArgs): Promise<PerIapResult> {
  const { decision } = args;
  if (decision.disposition === "ERROR") {
    return await persistResult(args, {
      product_id: decision.product_id,
      disposition: "ERROR",
      status: "ERROR",
      stage: "validation",
      error: decision.reason,
    });
  }
  if (decision.disposition === "SKIP") {
    return await persistResult(args, {
      product_id: decision.product_id,
      disposition: "SKIP",
      status: "SKIPPED",
      stage: "conflict-skip",
      error: decision.reason,
    });
  }

  if (decision.disposition === "OVERWRITE") {
    return await runOverwrite(args);
  }
  return await runCreate(args);
}

async function runCreate(args: OrchestrateArgs): Promise<PerIapResult> {
  const { creds, decision, screenshots, submit, appleAppId } = args;
  const item = decision.source;
  let appleIapId = "";

  // 1. Create shell on Apple — type comes from the parser (IAP.h2 Type
  //    column with COLUMN/DEFAULT source tracking, surfaced in audit log).
  try {
    const created = await trackedWithRetry(args.rateCounters, () =>
      createInAppPurchase(creds, {
        appId: appleAppId,
        name: item.reference_name,
        productId: item.product_id,
        inAppPurchaseType: item.type,
      }),
    );
    appleIapId = created.data.id;
  } catch (err) {
    return await persistResult(args, {
      product_id: item.product_id,
      disposition: "CREATE",
      status: "ERROR",
      stage: "apple-create",
      error: errMsg(err),
    });
  }

  // 2. Localizations
  const failedLocales: string[] = [];
  for (const loc of item.localizations) {
    try {
      await trackedWithRetry(args.rateCounters, () =>
        createInAppPurchaseLocalization(creds, {
          iapId: appleIapId,
          locale: loc.locale,
          name: loc.display_name,
          description: loc.description,
        }),
      );
    } catch (err) {
      failedLocales.push(loc.locale);
      await log(
        "iap-bulk-execute",
        `locale fail ${loc.locale} on product=${item.product_id}: ${errMsg(err)}`,
        "WARN",
      );
    }
  }

  // 3. Pricing schedule (IAP.o.10a → IAP.o.11a). Resolve tier_id → USA/USD
  // customer price, then poll Apple IAP state once (Manager Q-B race guard),
  // then orchestrate. Orchestrator owns the SET_PRICE_SCHEDULE audit log so
  // every outcome (set/skipped/failed) is recorded centrally.
  const resolvedTier = decision.resolved_tier_id ?? null;
  const usdPrice = resolvedTier ? args.usdPriceByTier.get(resolvedTier) ?? null : null;
  console.log(
    `[bulk-execute] Stage 2 precheck poll starting product_id=${item.product_id} apple_iap_id=${appleIapId}`,
  );
  const pollResult = await pollIapReadyForPricing({ creds, appleIapId });
  console.log(
    `[bulk-execute] Stage 2 precheck poll result product_id=${item.product_id} ready=${pollResult.ready} attempts=${pollResult.attempts} total_ms=${pollResult.total_ms}`,
  );
  console.log(
    `[bulk-execute] Stage 2 pricing starting product_id=${item.product_id} apple_iap_id=${appleIapId} tier_id=${resolvedTier ?? "<null>"} usd=${usdPrice}`,
  );
  const pricing = await applyPricingSchedule({
    creds,
    appleIapId,
    localTierId: resolvedTier,
    usdPrice,
    source: args.pricingSource,
    catalog: args.pricePointCatalog,
    iapType: item.type,
    precheck: {
      ready: pollResult.ready,
      reason: pollResult.ready ? undefined : pollResult.reason,
      attempts: pollResult.attempts,
      total_ms: pollResult.total_ms,
    },
    audit: {
      // CREATE path: iap_mgmt.iaps row not yet persisted — use null and
      // rely on batch_id + product_id + apple_iap_id for correlation.
      iapId: null,
      actor: args.actor,
      batchId: args.batchId,
      productId: item.product_id,
      internalAppId: args.internalAppId,
    },
  });
  console.log(
    `[bulk-execute] Stage 2 pricing result product_id=${item.product_id} outcome=${pricing.kind}`,
  );

  // 4. Screenshot 3-step (deferral 1 absorbed). Walk screenshot files;
  //    first filename matching productId (literal OR dots→underscores) wins.
  let screenshotOk = false;
  let screenshotFile: File | undefined;
  for (const [fname, file] of screenshots.entries()) {
    const result = matchScreenshotToProductId(fname, [item.product_id]);
    if (result.kind === "matched" && result.productId === item.product_id) {
      screenshotFile = file;
      break;
    }
  }
  if (screenshotFile) {
    try {
      const reserved = await trackedWithRetry(args.rateCounters, () =>
        reserveInAppPurchaseScreenshot(
          creds,
          appleIapId,
          screenshotFile!.name,
          screenshotFile!.size,
        ),
      );
      const ops = reserved.data.attributes.uploadOperations;
      if (!ops || ops.length === 0) {
        throw new Error("Apple returned no uploadOperations");
      }
      await uploadScreenshotToOperations(ops, screenshotFile);
      const buf = Buffer.from(await screenshotFile.arrayBuffer());
      const checksum = createHash("md5").update(buf).digest("hex");
      await trackedWithRetry(args.rateCounters, () =>
        confirmInAppPurchaseScreenshot(creds, reserved.data.id, checksum),
      );
      screenshotOk = true;
    } catch (err) {
      await log(
        "iap-bulk-execute",
        `screenshot fail on product=${item.product_id}: ${errMsg(err)}`,
        "WARN",
      );
    }
  }

  // 4.5 Cycle 37 Phase 1 — default availability to "All territories"
  // (Manager Q1.A). Per-row + non-fatal: if Apple rejects this call the
  // IAP is still on Apple, Manager can fix it via Apple Connect web.
  // `setAvailabilityToAllTerritories` reuses the per-process territory
  // cache, so the territories list is fetched once per batch and the
  // overhead per row is a single POST.
  let availabilitySet = false;
  let availabilityErr: string | undefined;
  try {
    await trackedWithRetry(args.rateCounters, () =>
      setAvailabilityToAllTerritories(creds, appleIapId),
    );
    availabilitySet = true;
  } catch (err) {
    availabilityErr = errMsg(err);
    await log(
      "iap-bulk-execute",
      `availability set-all failed on product=${item.product_id}: ${availabilityErr}`,
      "WARN",
    );
  }
  await iapDb()
    .from("actions_log")
    .insert({
      iap_id: null,
      actor: args.actor,
      action_type: "AVAILABILITY_SET_ALL_TERRITORIES",
      payload: {
        batch_id: args.batchId,
        product_id: item.product_id,
        apple_iap_id: appleIapId,
        success: availabilitySet,
        ...(availabilityErr ? { error: availabilityErr } : {}),
      },
    });

  // 5. Optional submit (IAP.q.2). The screenshot 3-step completing with a 200
  // does not mean Apple has propagated the review-screenshot relationship
  // onto the IAP yet — submitting immediately can 409 with both
  // RELATIONSHIP.REQUIRED (missing appStoreReviewScreenshot) and
  // IAP_SUBMISSION_NOT_ALLOWED (state still MISSING_METADATA). Poll for
  // READY_TO_SUBMIT first (waits out the common-case lag), then run the
  // eligibility decision through the SAME `partitionByStateGuard` the
  // submit-batch endpoint uses (Cycle 32 / IAP.q.1) — twin-path convergence,
  // not a reimplementation. A not-yet-ready IAP is DEFERRED, never a hard
  // error: the create half above is never rolled back by what happens here,
  // and a deferred row stays selectable via the ordinary Submit Selected flow.
  let submitted = false;
  let submitOutcome: PerIapResult["submit_outcome"];
  let submitDeferredState: string | undefined;
  let submitError: string | undefined;
  if (submit && screenshotOk && failedLocales.length === 0) {
    console.log(
      `[bulk-execute] Stage 4→5 submit-readiness poll starting product_id=${item.product_id} apple_iap_id=${appleIapId}`,
    );
    const eligibility = await checkSubmitEligibility({ creds, appleIapId });
    console.log(
      `[bulk-execute] Stage 4→5 submit-readiness poll result product_id=${item.product_id} ready=${eligibility.poll.ready} attempts=${eligibility.poll.attempts} total_ms=${eligibility.poll.total_ms} state=${eligibility.fresh_state} eligible=${eligibility.eligible}`,
    );

    if (!eligibility.eligible) {
      submitOutcome = "deferred";
      submitDeferredState = eligibility.fresh_state;
      await log(
        "iap-bulk-execute",
        `submit deferred on product=${item.product_id} apple_iap_id=${appleIapId}: state guard reports "${eligibility.fresh_state}"`,
        "WARN",
      );
    } else {
      try {
        await trackedWithRetry(args.rateCounters, () =>
          submitInAppPurchase(creds, appleIapId),
        );
        submitted = true;
        submitOutcome = "submitted";
      } catch (err) {
        submitOutcome = "failed";
        submitError = errMsg(err);
        await log(
          "iap-bulk-execute",
          `submit failed (post-guard) on product=${item.product_id} apple_iap_id=${appleIapId}: ${submitError}`,
          "WARN",
        );
      }
    }
  }

  return await persistResult(args, {
    product_id: item.product_id,
    disposition: "CREATE",
    status: "SUCCESS",
    apple_iap_id: appleIapId,
    failed_locales: failedLocales,
    screenshot_uploaded: screenshotOk,
    submitted,
    ...(submitOutcome ? { submit_outcome: submitOutcome } : {}),
    ...(submitDeferredState ? { submit_deferred_state: submitDeferredState } : {}),
    ...(submitError ? { submit_error: submitError } : {}),
    price_schedule_set: pricing.kind === "set",
    pricing_outcome: pricing.kind,
    ...(pricing.kind === "failed-lookup" ||
    pricing.kind === "failed-set" ||
    pricing.kind === "failed-exception"
      ? { pricing_error: pricing.error }
      : {}),
    ...(pricing.kind === "partial-template-fail"
      ? {
          pricing_missing: pricing.missing_price_points.map((m) => ({
            territory_code: m.territory_code,
            customer_price: m.customer_price,
          })),
        }
      : {}),
    availability_set: availabilitySet,
    ...(availabilityErr ? { availability_error: availabilityErr } : {}),
  });
}

async function runOverwrite(args: OrchestrateArgs): Promise<PerIapResult> {
  const { creds, decision, existingByProductId, screenshots } = args;
  const item = decision.source;
  const appleIapId = existingByProductId.get(item.product_id)!;

  // 1. PATCH attributes
  try {
    await trackedWithRetry(args.rateCounters, () =>
      updateInAppPurchase(creds, appleIapId, {
        name: item.reference_name,
      }),
    );
  } catch (err) {
    return await persistResult(args, {
      product_id: item.product_id,
      disposition: "OVERWRITE",
      status: "ERROR",
      stage: "apple-patch",
      apple_iap_id: appleIapId,
      error: errMsg(err),
    });
  }

  // 2. Sync localizations via delta (Problem 3b fix). Apple forbids deleting
  //    the last localization, so delete-all-then-recreate broke on the final
  //    locale (stale content retained). Instead: PATCH shared locales, POST
  //    new ones, DELETE only genuinely-removed ones — and run PATCH+POST
  //    BEFORE DELETE so the desired locales already exist when leftovers are
  //    removed (never drops the IAP to zero localizations).
  const failedLocales: string[] = [];
  try {
    const existing = await trackedWithRetry(args.rateCounters, () =>
      listInAppPurchaseLocalizations(creds, appleIapId),
    );
    const plan = planLocalizationSync(
      (existing.data ?? []).map((l) => ({ id: l.id, locale: l.attributes.locale })),
      item.localizations,
    );
    if (plan.deletionsSuppressed) {
      await log(
        "iap-bulk-execute",
        `localization deletions suppressed on ${item.product_id} (would remove last localization)`,
        "WARN",
      );
    }

    // 2a. PATCH shared locales — update content in place, no delete.
    for (const p of plan.toPatch) {
      try {
        await trackedWithRetry(args.rateCounters, () =>
          updateInAppPurchaseLocalization(creds, p.id, {
            name: p.name,
            description: p.description,
          }),
        );
      } catch (err) {
        failedLocales.push(p.locale);
        await log(
          "iap-bulk-execute",
          `patch loc ${p.locale} on ${item.product_id}: ${errMsg(err)}`,
          "WARN",
        );
      }
    }

    // 2b. POST new locales.
    for (const c of plan.toCreate) {
      try {
        await trackedWithRetry(args.rateCounters, () =>
          createInAppPurchaseLocalization(creds, {
            iapId: appleIapId,
            locale: c.locale,
            name: c.name,
            description: c.description,
          }),
        );
      } catch (err) {
        failedLocales.push(c.locale);
        await log(
          "iap-bulk-execute",
          `create loc ${c.locale} on ${item.product_id}: ${errMsg(err)}`,
          "WARN",
        );
      }
    }

    // 2c. DELETE genuinely-removed locales last (plan guarantees this never
    //     removes the final localization).
    for (const d of plan.toDelete) {
      try {
        await trackedWithRetry(args.rateCounters, () =>
          deleteInAppPurchaseLocalization(creds, d.id),
        );
      } catch (err) {
        await log(
          "iap-bulk-execute",
          `delete loc ${d.locale} (${d.id}) on ${item.product_id}: ${errMsg(err)}`,
          "WARN",
        );
      }
    }
  } catch (err) {
    await log(
      "iap-bulk-execute",
      `list locales failed on ${item.product_id}: ${errMsg(err)}`,
      "WARN",
    );
  }

  // Screenshot replace (IAP.o.8a). Manager MV30 Issue 1: re-importing an IAP
  // that originally had no screenshot used to silently leave Apple's slot
  // empty. New behavior: if the batch ships a companion file for this
  // productId, delete the existing screenshot (if any) then run the 3-step
  // upload. If Apple returns 409 (IAP locked in WAITING_FOR_REVIEW / IN_REVIEW),
  // surface a non-fatal `delete-locked` note so the row remains SUCCESS but
  // Manager sees the screenshot couldn't be swapped.
  let screenshotOk = false;
  let screenshotNote: PerIapResult["screenshot_note"] = "no-file";
  let screenshotFile: File | undefined;
  for (const [fname, file] of screenshots.entries()) {
    const match = matchScreenshotToProductId(fname, [item.product_id]);
    if (match.kind === "matched" && match.productId === item.product_id) {
      screenshotFile = file;
      break;
    }
  }
  if (screenshotFile) {
    const replace = await replaceScreenshotOnApple(
      creds,
      appleIapId,
      screenshotFile,
    );
    if (replace.ok) {
      screenshotOk = true;
      // The lookup phase doesn't tell us whether a prior screenshot existed
      // when it succeeded — but Manager's primary complaint was the
      // "originally none → import added one" case, so the audit log infers
      // by stage: if replace.ok was reached with no upstream delete failure
      // and lookup returned nothing, it's an "uploaded-new"; we can't cheaply
      // distinguish here without plumbing the prior-id back, so default to
      // `replaced` (covers both cases without misreporting outcome).
      screenshotNote = "replaced";
    } else if (replace.stage === "delete-locked") {
      screenshotNote = "delete-locked";
      await log(
        "iap-bulk-execute",
        `screenshot delete locked on product=${item.product_id}: ${replace.error}`,
        "WARN",
      );
    } else {
      screenshotNote = "failed";
      await log(
        "iap-bulk-execute",
        `screenshot replace fail on product=${item.product_id} (${replace.stage}): ${replace.error}`,
        "WARN",
      );
    }
  }

  // Pricing schedule (IAP.o.9a + IAP.o.10a → IAP.o.11a · Hotfix 23).
  //
  // Pre-Hotfix-23 the OVERWRITE path only re-applied pricing when the
  // resolved tier_id differed from the locally cached row. That
  // optimisation was unsound the moment Manager replaced a Per-App
  // template in place: a v1 → v2 swap that *kept* the same tier_id
  // mapping but *changed* the tier's per-territory entries (10
  // countries → 4 countries) silently left Apple on the v1 schedule
  // because `resolvedTier === cachedTier` short-circuited the POST.
  //
  // Apple's POST /v1/inAppPurchasePriceSchedules is REPLACE-ALL per
  // §4.2, idempotent on identical content. Templates are also fetched
  // fresh inside `applyPricingSchedule` (no orchestrator-level cache),
  // so always calling it on OVERWRITE when a tier resolves picks up
  // template-content changes — the only safe behaviour when a
  // template can be replaced behind a re-imported SKU.
  //
  // The cached-tier comparison stays in the orchestration only as a
  // diagnostic surfaced in the audit log + console; no longer gates
  // the POST. No poll on OVERWRITE — IAP already exists on Apple
  // (state has long since propagated).
  const resolvedTier = decision.resolved_tier_id ?? null;
  const cachedTier = args.existingTierByProductId.get(item.product_id) ?? null;
  const pricingDecision = decideOverwritePricing({
    resolvedTierId: resolvedTier,
    cachedTierId: cachedTier,
  });
  let pricing: PricingOutcome | null = null;
  if (pricingDecision.shouldRunPricing && resolvedTier) {
    const usdPrice = args.usdPriceByTier.get(resolvedTier) ?? null;
    console.log(
      `[bulk-execute] OVERWRITE pricing starting product_id=${item.product_id} apple_iap_id=${appleIapId} tier_id=${resolvedTier} cached=${cachedTier ?? "<null>"} tier_unchanged=${pricingDecision.tierUnchanged} usd=${usdPrice} source=${args.pricingSource.kind}`,
    );
    pricing = await applyPricingSchedule({
      creds,
      appleIapId,
      localTierId: resolvedTier,
      usdPrice,
      source: args.pricingSource,
      catalog: args.pricePointCatalog,
      iapType: item.type,
      audit: {
        // Problem 1 fix: mirror the CREATE caller — pass null, NOT the Apple
        // numeric id. `existingByProductId` holds Apple's resource id
        // (e.g. "6775742430"), and `actions_log.iap_id` is uuid-typed, so
        // passing it made every OVERWRITE SET_PRICE_SCHEDULE audit row fail
        // ("invalid input syntax for type uuid"). The payload below carries
        // apple_iap_id + product_id + app_id + batch_id for correlation.
        iapId: null,
        actor: args.actor,
        batchId: args.batchId,
        productId: item.product_id,
        internalAppId: args.internalAppId,
      },
    });
    console.log(
      `[bulk-execute] OVERWRITE pricing result product_id=${item.product_id} outcome=${pricing.kind} tier_unchanged=${pricingDecision.tierUnchanged}`,
    );
  }

  const overwriteResult: PerIapResult = {
    product_id: item.product_id,
    disposition: "OVERWRITE",
    status: "SUCCESS",
    apple_iap_id: appleIapId,
    failed_locales: failedLocales,
    screenshot_uploaded: screenshotOk,
    screenshot_note: screenshotNote,
    ...(pricing
      ? {
          price_schedule_set: pricing.kind === "set",
          pricing_outcome: pricing.kind,
          ...(pricing.kind === "failed-lookup" ||
          pricing.kind === "failed-set" ||
          pricing.kind === "failed-exception"
            ? { pricing_error: pricing.error }
            : {}),
          ...(pricing.kind === "partial-template-fail"
            ? {
                pricing_missing: pricing.missing_price_points.map((m) => ({
                  territory_code: m.territory_code,
                  customer_price: m.customer_price,
                })),
              }
            : {}),
        }
      : {}),
  };

  // Dedicated audit row for the screenshot replace outcome so Manager-side
  // log queries can find IAPs whose screenshot was/wasn't replaced without
  // re-parsing the bulk-create payload. Mirrors how BULK_IMPORT_SUBMIT is
  // split out from BULK_IMPORT_CREATE.
  if (screenshotFile) {
    await iapDb().from("actions_log").insert({
      batch_id: args.batchId,
      actor: args.actor,
      action_type: "BULK_IMPORT_OVERWRITE_SCREENSHOT",
      payload: {
        product_id: item.product_id,
        apple_iap_id: appleIapId,
        app_id: args.internalAppId,
        outcome: screenshotNote,
        screenshot_uploaded: screenshotOk,
      },
    });
  }

  return await persistResult(args, overwriteResult);
}

// ─── Persistence helpers ────────────────────────────────────────────────────

async function persistResult(
  args: OrchestrateArgs,
  result: PerIapResult,
): Promise<PerIapResult> {
  const db = iapDb();
  const item = args.decision.source;

  // Hotfix 26 — attach per-row 429 telemetry. The wrapper rolls up on
  // the way out so both the returned PerIapResult AND the persisted
  // actions_log payload (spread below) carry the counters.
  result = { ...result, rate_limit: { ...args.rateCounters } };

  if (result.status === "SUCCESS" && result.apple_iap_id) {
    // Upsert into iaps table — best-effort, surface only via log on conflict.
    try {
      await db
        .from("iaps")
        .upsert(
          {
            app_id: args.internalAppId,
            apple_iap_id: result.apple_iap_id,
            product_id: item.product_id,
            reference_name: item.reference_name,
            type: item.type,
            tier_id: args.decision.resolved_tier_id ?? null,
            // IAP.q.2: a deferred submit means Apple's fresh state wasn't
            // READY_TO_SUBMIT — mirror that observed state locally instead of
            // defaulting to READY_TO_SUBMIT, so the app IAP list / Submit
            // Selected preflight aren't misled by a stale optimistic cache.
            state: result.submitted
              ? "WAITING_FOR_REVIEW"
              : (result.submit_deferred_state ?? "READY_TO_SUBMIT"),
            synced_at: new Date().toISOString(),
          },
          { onConflict: "app_id,product_id" },
        );
    } catch (err) {
      await log(
        "iap-bulk-execute",
        `db upsert ${result.product_id}: ${errMsg(err)}`,
        "WARN",
      );
    }
  }

  await db.from("actions_log").insert({
    batch_id: args.batchId,
    actor: args.actor,
    action_type: "BULK_IMPORT_CREATE",
    payload: {
      ...result,
      app_id: args.internalAppId,
      type_source: item.type_source,
      tier_source: args.tierOverrides[item.product_id]
        ? "MANUAL_OVERRIDE"
        : args.decision.resolved_tier_id !== undefined
          ? "PRICE_USD_LOOKUP"
          : null,
      resolved_tier_id: args.decision.resolved_tier_id ?? null,
    },
  });

  // Separate audit row when the row also reached the SUBMIT stage. Keeps
  // bulk-wizard submit signals queryable independently of the per-row
  // create entry (Manager IAP.o.6c audit log discipline).
  if (result.status === "SUCCESS" && result.submitted) {
    await db.from("actions_log").insert({
      batch_id: args.batchId,
      actor: args.actor,
      action_type: "BULK_IMPORT_SUBMIT",
      payload: {
        product_id: result.product_id,
        apple_iap_id: result.apple_iap_id,
        app_id: args.internalAppId,
        via: "bulk",
      },
    });
  }
  return result;
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

