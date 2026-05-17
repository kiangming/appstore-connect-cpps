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
 *   5. (optional, when submit_on_create=true) POST /v1/inAppPurchaseSubmissions.
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
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  createInAppPurchase,
  createInAppPurchaseLocalization,
  listAllInAppPurchases,
  listInAppPurchaseLocalizations,
  reserveInAppPurchaseScreenshot,
  uploadScreenshotToOperations,
  confirmInAppPurchaseScreenshot,
  submitInAppPurchase,
  updateInAppPurchase,
} from "@/lib/iap-management/apple/client";
import { replaceScreenshotOnApple } from "@/lib/iap-management/apple/screenshot-upload";
import {
  applyPricingSchedule,
  type PricingOutcome,
} from "@/lib/iap-management/apple/pricing-orchestration";
import { pollIapReadyForPricing } from "@/lib/iap-management/apple/poll-iap-ready";
import {
  withRetry,
  AppleApiError,
  iapFetch,
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
import { listUsdTiers } from "@/lib/iap-management/queries/price-tiers";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import { log } from "@/lib/logger";
import type {
  AscCredentials,
} from "@/lib/asc-jwt";

export const runtime = "nodejs";

const CONCURRENCY_LIMIT = 5;

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
  submitted?: boolean;
  stage?: string;
  error?: string;
}

interface ExecuteSummary {
  batch_id: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: PerIapResult[];
}

export async function POST(
  req: Request,
  ctx: { params: { appId: string } },
) {
  let session;
  try {
    session = await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof IapForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
  const actor = session.user.email ?? "unknown";

  // ── Parse multipart FormData ─────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form body" }, { status: 400 });
  }

  const excel = form.get("excel");
  if (!(excel instanceof File)) {
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
  };
  try {
    config = JSON.parse(
      typeof configRaw === "string" ? configRaw : "{}",
    );
    if (config.default_mode !== "OVERWRITE" && config.default_mode !== "SKIP") {
      config.default_mode = "OVERWRITE";
    }
  } catch {
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
    });
    const existingRes = await listAllInAppPurchases(creds, ctx.params.appId);
    existingByProductId = new Map(
      (existingRes.data ?? []).map((iap) => [iap.attributes.productId, iap.id]),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Apple sync failed";
    await log("iap-bulk-execute", `apple resolve failed: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── Conflict resolution + tier inference (IAP.h2) ───────────────────────
  const conflicts = resolveConflicts({
    parsed: parsed.items,
    existing_product_ids: new Set(existingByProductId.keys()),
    default_mode: config.default_mode,
    overrides: config.overrides,
  });
  let usdTiers: Awaited<ReturnType<typeof listUsdTiers>>;
  try {
    usdTiers = await listUsdTiers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "USD tiers fetch failed";
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
    return NextResponse.json(
      { error: `audit batch open failed: ${batchIns.error?.message}` },
      { status: 500 },
    );
  }
  const batchId = (batchIns.data as { id: string }).id;

  // Build tier_id → USA/USD customer_price lookup once (IAP.o.10a). Apple
  // price-point matching switched from priceTier integer (volatile across
  // Apple's 2024 numbering rollover) to customerPrice string — local USD is
  // the canonical match key.
  const usdPriceByTier = new Map<string, number>();
  for (const t of usdTiers) {
    usdPriceByTier.set(t.tier_id, t.customer_price);
  }

  // ── Orchestrate per-IAP with bounded concurrency ────────────────────────
  const results: PerIapResult[] = await withConcurrency(
    resolved.decisions,
    CONCURRENCY_LIMIT,
    async (decision) => orchestrateOne({
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
    }),
  );

  // ── Tally + close audit batch ───────────────────────────────────────────
  const succeeded = results.filter((r) => r.status === "SUCCESS").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  const failed = results.filter((r) => r.status === "ERROR").length;

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
    },
  });

  const summary: ExecuteSummary = {
    batch_id: batchId,
    total: parsed.items.length,
    succeeded,
    failed,
    skipped,
    results,
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
    const created = await withRetry(() =>
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
      await withRetry(() =>
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
      const reserved = await withRetry(() =>
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
      await withRetry(() =>
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

  // 5. Optional submit
  let submitted = false;
  if (submit && screenshotOk && failedLocales.length === 0) {
    try {
      await withRetry(() => submitInAppPurchase(creds, appleIapId));
      submitted = true;
    } catch (err) {
      return await persistResult(args, {
        product_id: item.product_id,
        disposition: "CREATE",
        status: "ERROR",
        stage: "apple-submit",
        apple_iap_id: appleIapId,
        failed_locales: failedLocales,
        screenshot_uploaded: screenshotOk,
        price_schedule_set: pricing.kind === "set",
        pricing_outcome: pricing.kind,
        ...(pricing.kind === "failed-lookup" ||
        pricing.kind === "failed-set" ||
        pricing.kind === "failed-exception"
          ? { pricing_error: pricing.error }
          : {}),
        error: errMsg(err),
      });
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
    price_schedule_set: pricing.kind === "set",
    pricing_outcome: pricing.kind,
    ...(pricing.kind === "failed-lookup" ||
    pricing.kind === "failed-set" ||
    pricing.kind === "failed-exception"
      ? { pricing_error: pricing.error }
      : {}),
  });
}

async function runOverwrite(args: OrchestrateArgs): Promise<PerIapResult> {
  const { creds, decision, existingByProductId, screenshots } = args;
  const item = decision.source;
  const appleIapId = existingByProductId.get(item.product_id)!;

  // 1. PATCH attributes
  try {
    await withRetry(() =>
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

  // 2. Replace localizations: list + delete + POST new
  const failedLocales: string[] = [];
  try {
    const existing = await withRetry(() =>
      listInAppPurchaseLocalizations(creds, appleIapId),
    );
    for (const loc of existing.data ?? []) {
      try {
        await withRetry(() =>
          iapFetch<unknown>(
            creds,
            "DELETE",
            `/v1/inAppPurchaseLocalizations/${loc.id}`,
          ),
        );
      } catch (err) {
        await log(
          "iap-bulk-execute",
          `delete loc ${loc.id} failed: ${errMsg(err)}`,
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

  for (const loc of item.localizations) {
    try {
      await withRetry(() =>
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
        `repost loc ${loc.locale} on ${item.product_id}: ${errMsg(err)}`,
        "WARN",
      );
    }
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

  // Pricing schedule conditional (IAP.o.9a + IAP.o.10a → IAP.o.11a). Only
  // re-apply when the resolved tier differs from the locally cached row.
  // Missing-from-cache treated as "differs" so pricing stays in sync. No
  // poll on OVERWRITE — IAP already exists on Apple (state has long since
  // propagated). Orchestrator owns the SET_PRICE_SCHEDULE audit log.
  const resolvedTier = decision.resolved_tier_id ?? null;
  const cachedTier = args.existingTierByProductId.get(item.product_id) ?? null;
  let pricing: PricingOutcome | null = null;
  if (resolvedTier && resolvedTier !== cachedTier) {
    const usdPrice = args.usdPriceByTier.get(resolvedTier) ?? null;
    console.log(
      `[bulk-execute] OVERWRITE pricing starting product_id=${item.product_id} apple_iap_id=${appleIapId} tier_id=${resolvedTier} cached=${cachedTier ?? "<null>"} usd=${usdPrice}`,
    );
    pricing = await applyPricingSchedule({
      creds,
      appleIapId,
      localTierId: resolvedTier,
      usdPrice,
      audit: {
        iapId: args.existingByProductId.get(item.product_id) ?? null,
        actor: args.actor,
        batchId: args.batchId,
        productId: item.product_id,
        internalAppId: args.internalAppId,
      },
    });
    console.log(
      `[bulk-execute] OVERWRITE pricing result product_id=${item.product_id} outcome=${pricing.kind}`,
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
            state: result.submitted ? "WAITING_FOR_REVIEW" : "READY_TO_SUBMIT",
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

