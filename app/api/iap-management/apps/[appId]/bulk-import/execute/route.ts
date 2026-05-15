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
 *   3. POST /v1/inAppPurchaseReviewScreenshots reserve + PUT chunks + PATCH
 *      confirm (deferral 1 absorbed).
 *   4. (optional, when submit_on_create=true) POST /v1/inAppPurchaseSubmissions.
 *   5. Insert iap_mgmt.iaps + iap_localizations + iap_screenshots audit rows.
 *
 * OVERWRITE path: PATCH attributes + DELETE existing localizations + POST new.
 * Screenshot is NOT replaced on overwrite (deferred — Manager uses Apple
 * Connect UI to swap the screenshot of an existing approved IAP).
 *
 * Pricing schedule (deferral 2): wired into CREATE path only — Apple Connect
 * defaults apply on OVERWRITE since price changes mid-import are atypical.
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
  listInAppPurchases,
  listInAppPurchaseLocalizations,
  reserveInAppPurchaseScreenshot,
  uploadScreenshotToOperations,
  confirmInAppPurchaseScreenshot,
  submitInAppPurchase,
  updateInAppPurchase,
} from "@/lib/iap-management/apple/client";
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
  type ConflictMode,
  type ConflictDecision,
} from "@/lib/iap-management/bulk-import/conflict-resolution";
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
    const existingRes = await withRetry(() =>
      listInAppPurchases(creds, ctx.params.appId),
    );
    existingByProductId = new Map(
      (existingRes.data ?? []).map((iap) => [iap.attributes.productId, iap.id]),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Apple sync failed";
    await log("iap-bulk-execute", `apple resolve failed: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── Conflict resolution ─────────────────────────────────────────────────
  const resolved = resolveConflicts({
    parsed: parsed.items,
    existing_product_ids: new Set(existingByProductId.keys()),
    default_mode: config.default_mode,
    overrides: config.overrides,
  });

  // ── Open audit batch ────────────────────────────────────────────────────
  const db = iapDb();
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
      appleAppId: ctx.params.appId,
      internalAppId,
      batchId,
      actor,
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
  screenshots: Map<string, File>;
  submit: boolean;
  existingByProductId: Map<string, string>;
  /** Apple's numeric App Store app id (from URL param) — needed for create. */
  appleAppId: string;
  /** Internal iap_mgmt.apps.id — needed for DB FK. */
  internalAppId: string;
  batchId: string;
  actor: string;
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

  // 1. Create shell on Apple
  try {
    const created = await withRetry(() =>
      createInAppPurchase(creds, {
        appId: appleAppId,
        name: item.reference_name,
        productId: item.product_id,
        inAppPurchaseType: "CONSUMABLE", // Excel template doesn't expose type — Manager confirms IAP.i v1 defaults
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

  // 3. Screenshot 3-step (deferral 1 absorbed). Walk screenshot files;
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

  // 4. Optional submit
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
  });
}

async function runOverwrite(args: OrchestrateArgs): Promise<PerIapResult> {
  const { creds, decision, existingByProductId } = args;
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

  // Screenshot preservation: skip replacement on overwrite (v1 limitation —
  // documented in commit body).
  return await persistResult(args, {
    product_id: item.product_id,
    disposition: "OVERWRITE",
    status: "SUCCESS",
    apple_iap_id: appleIapId,
    failed_locales: failedLocales,
    screenshot_uploaded: false,
  });
}

// ─── Persistence helpers ────────────────────────────────────────────────────

async function persistResult(
  args: OrchestrateArgs,
  result: PerIapResult,
): Promise<PerIapResult> {
  const db = iapDb();
  if (result.status === "SUCCESS" && result.apple_iap_id) {
    // Upsert into iaps table — best-effort, surface only via log on conflict.
    try {
      const item = args.decision.source;
      await db
        .from("iaps")
        .upsert(
          {
            app_id: args.internalAppId,
            apple_iap_id: result.apple_iap_id,
            product_id: item.product_id,
            reference_name: item.reference_name,
            type: "CONSUMABLE",
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
    action_type: "CREATE_IAP",
    payload: {
      ...result,
      app_id: args.internalAppId,
    },
  });
  return result;
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
