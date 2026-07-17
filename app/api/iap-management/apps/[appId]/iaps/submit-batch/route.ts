/**
 * POST /api/iap-management/apps/[appId]/iaps/submit-batch
 *
 * IAP.o.6b — list-page multi-select Submit Selected flow.
 *
 * Two phases controlled by body.execute:
 *
 *   • Phase 1 (preflight, default): one Apple `listInAppPurchases` call,
 *     fresh state bucketed per selected IAP. Returns ready / missing_metadata
 *     / other / not_on_apple lists for the Manager preview modal. Identical
 *     regardless of submit mechanism (v1 or v2) — Apple state bucketing
 *     doesn't depend on how submission is triggered.
 *
 *   • Phase 2 (execute, body.execute=true): submits the supplied iap_ids.
 *     Branches on `IAP_SUBMIT_V2_APPS` (lib/iap-management/submit-v2-toggle.ts):
 *
 *       - v2 OFF (default) — LEGACY path, unchanged: one
 *         `POST /v1/inAppPurchaseSubmissions` per item via
 *         `submitInAppPurchase`, concurrency 2. Kept fully intact for
 *         rollback safety — see design doc.
 *
 *       - v2 ON for this app — reviewSubmissions-based path
 *         (lib/iap-management/apple/submit-v2.ts): create-or-reuse the
 *         app's open reviewSubmission (NEVER blind-creates — Decision A),
 *         check for foreign items already in it (conflict dialog, see
 *         `phase: "conflict"` response below), then add each item as a
 *         reviewSubmissionItem (paced + retried) and PATCH-submit once.
 *
 * Body shape:
 *   { iap_ids: string[]; execute?: boolean; confirmConflict?: boolean;
 *     proceedPartial?: { reviewSubmissionId; submittedIapIds }
 *     rollback?: { reviewSubmissionId; reused; addedIapIds } }
 *
 * Apple state is canonical — the local cache (iap_mgmt.iaps.state) is the
 * mirror, refreshed by both phases.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  listInAppPurchases,
  submitInAppPurchase,
  getInAppPurchase,
} from "@/lib/iap-management/apple/client";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import {
  bucketSelection,
  partitionByStateGuard,
  type AppleStateRow,
  type NotOnAppleRow,
  type PreflightRow,
} from "@/lib/iap-management/submit-batch/bucket";
import { v2ToggleDecision } from "@/lib/iap-management/submit-v2-toggle";
import {
  checkForConflict,
  executeSubmitV2,
  confirmSubmitV2,
  rollbackOrLeaveSubmitV2,
  type SubmitV2Item,
} from "@/lib/iap-management/apple/submit-v2";
import type { ForeignItemsSummary } from "@/lib/shared/review-submission";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Cycle 40 Phase B1 — concurrency 5 → 2 alignment with Hotfix 26 Bulk
 * Import + Cycle 40 Phase A Bulk Availability. Apple ASC ~1 req/sec
 * conservative protection; each submit-batch row issues 1-3 Apple calls
 * (preflight read + submit + post-submit refetch), so at concurrency 5
 * the peak in-flight rate burst past Apple's sustained budget on larger
 * batches. Zero-risk alignment — withRetry already wraps every call site
 * in this route (Hotfix 26 audit confirmed), so this only smooths the
 * burst profile. Telemetry from `[asc-client] budget=` Railway logs +
 * actions_log.payload.rate_limit will reveal whether further Phase B
 * subsets (token bucket, auto-retry) are needed.
 *
 * LEGACY PATH ONLY — the v2 path (submit-v2.ts) uses sequential
 * inter-item pacing instead of a concurrency pool; see design doc §5.
 */
const SUBMIT_CONCURRENCY = 2;

const BodySchema = z.object({
  iap_ids: z.array(z.string().uuid()).min(1).max(200),
  execute: z.boolean().optional().default(false),
  /** v2 only — user has seen the conflict dialog and explicitly chose to
   *  co-submit everything already in the shared reviewSubmission. */
  confirmConflict: z.boolean().optional().default(false),
  /** v2 only — user chose "proceed" after a partial item-add failure:
   *  submit the container as-is (only successfully-added items go to
   *  review). `submittedIapIds` lets the server finalize DB mirror +
   *  audit logging without needing server-side session state. */
  proceedPartial: z
    .object({
      reviewSubmissionId: z.string(),
      submittedIapIds: z.array(z.string().uuid()),
    })
    .optional(),
  /** v2 only — user chose "rollback" after a partial item-add failure. */
  rollback: z
    .object({
      reviewSubmissionId: z.string(),
      reused: z.boolean(),
      addedIapIds: z.array(z.string().uuid()).optional().default([]),
    })
    .optional(),
});

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
  /** IAP.q.1.IV: `SKIPPED_BY_STATE_GUARD` added — server-side state recheck
   *  blocked a row whose Apple state was not `READY_TO_SUBMIT`. The UI
   *  renders these distinctly from `ERROR`s (which represent real Apple
   *  submission failures). */
  status: "SUCCESS" | "ERROR" | "SKIPPED_BY_STATE_GUARD";
  state?: string;
  error?: string;
}

interface ExecuteResponse {
  phase: "execute";
  submitted: number;
  failed: number;
  /** IAP.q.1.IV — count of rows the server-side state guard blocked
   *  before Apple was called. Modal preflight normally filters these
   *  client-side; this counter > 0 means a race or direct-API call landed. */
  skipped: number;
  results: ExecuteResultRow[];
}

/** v2 only — Decision A conflict dialog data. Zero Apple writes have
 *  happened when this is returned. */
interface ConflictResponse {
  phase: "conflict";
  reviewSubmissionId: string;
  eligibleCount: number;
  foreignItemsSummary: ForeignItemsSummary;
}

/** v2 only — some reviewSubmissionItem adds failed after retries. Client
 *  must show proceed/rollback choice (CPP's existing partial-fail UX). */
interface PartialFailResponse {
  phase: "partial-fail";
  reviewSubmissionId: string;
  reused: boolean;
  items: Array<{
    iap_id: string;
    apple_iap_id: string;
    status: "SUCCESS" | "ERROR";
    error?: string;
    orphanedVersionWarning?: boolean;
  }>;
  skipped: ExecuteResultRow[];
}

interface ConfirmedResponse {
  phase: "confirmed";
}

interface RolledBackResponse {
  phase: "rolled-back";
  deleted: boolean;
}

type LocalRow = {
  id: string;
  apple_iap_id: string | null;
  product_id: string;
  reference_name: string;
};

export async function POST(
  req: Request,
  ctx: { params: { appId: string } },
) {
  let session;
  try {
    // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
  const actor = session.user.email ?? "unknown";
  const appleAppId = ctx.params.appId;

  // Parse + validate body
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    body = BodySchema.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 },
    );
  }

  // ─── v2-only follow-up actions (proceed / rollback after partial fail) ──
  if (body.rollback) {
    return await runRollback(actor, body.rollback);
  }
  if (body.proceedPartial) {
    return await runProceedPartial(actor, body.proceedPartial);
  }

  // Load local rows for the selected IAPs (need apple_iap_id mapping + names).
  const db = iapDb();
  const localRes = await db
    .from("iaps")
    .select("id, apple_iap_id, product_id, reference_name")
    .in("id", body.iap_ids);
  if (localRes.error) {
    return NextResponse.json(
      { error: `iaps lookup failed: ${localRes.error.message}` },
      { status: 500 },
    );
  }
  const localRows = (localRes.data ?? []) as LocalRow[];

  // ─── Phase 1 — preflight ─────────────────────────────────────────────────
  if (!body.execute) {
    return await runPreflight(appleAppId, localRows);
  }

  // ─── Phase 2 — execute ───────────────────────────────────────────────────
  // IAP.q.1.IV: `?skipCheck=true` bypasses the server-side state guard
  // (parity with the single-IAP `/submit?skipCheck=true` convention). The
  // modal UI never sends `skipCheck=true`; the bypass exists for internal
  // automation / replay scripts that have already verified state out-of-band.
  const url = new URL(req.url);
  const skipCheck = url.searchParams.get("skipCheck") === "true";

  const { enabled: v2Enabled, reason: toggleReason } = v2ToggleDecision(appleAppId);
  await log(
    "iap-submit-v2",
    `app=${appleAppId} → ${v2Enabled ? "v2" : "legacy"} path (${toggleReason})`,
  );

  if (v2Enabled) {
    return await runExecuteV2(
      appleAppId,
      localRows,
      actor,
      skipCheck,
      body.confirmConflict,
    );
  }
  return await runExecuteLegacy(appleAppId, localRows, actor, skipCheck);
}

async function runPreflight(
  appleAppId: string,
  localRows: LocalRow[],
): Promise<NextResponse> {
  const appleIdsToFetch = new Set<string>();
  for (const row of localRows) {
    if (row.apple_iap_id) appleIdsToFetch.add(row.apple_iap_id);
  }

  // Fresh Apple state — single batch call.
  let appleByAppleId: Map<string, AppleStateRow>;
  try {
    const creds = await getActiveAccount();
    const res = await withRetry(() =>
      listInAppPurchases(creds, appleAppId),
    );
    appleByAppleId = new Map(
      (res.data ?? [])
        .filter((iap) => appleIdsToFetch.has(iap.id))
        .map((iap) => [
          iap.id,
          { apple_iap_id: iap.id, state: iap.attributes.state },
        ]),
    );
  } catch (err) {
    return NextResponse.json(
      { error: errMsg(err) },
      { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
    );
  }

  // Mirror fresh states back to local cache (best-effort).
  const db = iapDb();
  for (const apple of appleByAppleId.values()) {
    await db
      .from("iaps")
      .update({ state: apple.state, synced_at: new Date().toISOString() })
      .eq("apple_iap_id", apple.apple_iap_id);
  }

  const buckets = bucketSelection(
    localRows.map((r) => ({
      id: r.id,
      apple_iap_id: r.apple_iap_id,
      product_id: r.product_id,
      reference_name: r.reference_name,
    })),
    appleByAppleId,
  );

  const response: PreflightResponse = {
    phase: "preflight",
    total: localRows.length,
    ready: buckets.ready,
    missing_metadata: buckets.missing_metadata,
    other: buckets.other,
    not_on_apple: buckets.not_on_apple,
  };
  return NextResponse.json(response);
}

/**
 * Shared state-guard step used by both the legacy and v2 execute paths.
 * Refetches Apple state and partitions `onApple` into eligible vs skipped —
 * defence-in-depth against a race between preflight and execute.
 */
async function runStateGuard(
  appleAppId: string,
  onApple: LocalRow[],
  actor: string,
  skipCheck: boolean,
): Promise<
  | { ok: true; eligible: LocalRow[]; skippedResults: ExecuteResultRow[] }
  | { ok: false; response: NextResponse }
> {
  if (skipCheck) {
    return { ok: true, eligible: onApple, skippedResults: [] };
  }

  const creds = await getActiveAccount();
  const db = iapDb();
  let stateByAppleId: Map<string, string>;
  try {
    const res = await withRetry(() => listInAppPurchases(creds, appleAppId));
    stateByAppleId = new Map(
      (res.data ?? []).map((iap) => [iap.id, iap.attributes.state]),
    );
  } catch (err) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `State recheck failed: ${errMsg(err)}` },
        { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
      ),
    };
  }

  const partition = partitionByStateGuard(
    onApple.map((r) => ({ id: r.id, apple_iap_id: r.apple_iap_id! })),
    stateByAppleId,
  );

  const skippedResults: ExecuteResultRow[] = [];
  for (const skip of partition.skipped) {
    skippedResults.push({
      iap_id: skip.id,
      apple_iap_id: skip.apple_iap_id,
      status: "SKIPPED_BY_STATE_GUARD",
      state: skip.apple_state,
      error: `State guard blocked: Apple reports state="${skip.apple_state}".`,
    });
    await db
      .from("iaps")
      .update({ state: skip.apple_state, synced_at: new Date().toISOString() })
      .eq("id", skip.id);
    await db.from("actions_log").insert({
      iap_id: skip.id,
      actor,
      action_type: "SUBMIT_APPLE_REVIEW",
      payload: {
        apple_iap_id: skip.apple_iap_id,
        result: "SKIPPED",
        reason: "state_guard",
        apple_state: skip.apple_state,
        via: "batch",
      },
    });
  }

  const eligibleIds = new Set(partition.eligible.map((e) => e.id));
  const eligible = onApple.filter((r) => eligibleIds.has(r.id));
  return { ok: true, eligible, skippedResults };
}

// ─── Legacy execute path (unchanged behavior) ───────────────────────────────

async function runExecuteLegacy(
  appleAppId: string,
  localRows: LocalRow[],
  actor: string,
  skipCheck: boolean,
): Promise<NextResponse> {
  const onApple = localRows.filter((r) => r.apple_iap_id);
  if (onApple.length === 0) {
    return NextResponse.json(
      { error: "No selected IAPs are on Apple — Create on Apple first." },
      { status: 422 },
    );
  }

  const creds = await getActiveAccount();
  const db = iapDb();

  const guard = await runStateGuard(appleAppId, onApple, actor, skipCheck);
  if (!guard.ok) return guard.response;
  const { eligible, skippedResults } = guard;

  const submitResults: ExecuteResultRow[] = await withConcurrency(
    eligible,
    SUBMIT_CONCURRENCY,
    async (row) => {
      const appleIapId = row.apple_iap_id!;
      try {
        await withRetry(() => submitInAppPurchase(creds, appleIapId));
        // Fetch post-submit authoritative state.
        let finalState = "WAITING_FOR_REVIEW";
        try {
          const fresh = await withRetry(() =>
            getInAppPurchase(creds, appleIapId),
          );
          finalState = fresh.data.attributes.state ?? finalState;
        } catch (err) {
          await log(
            "iap-submit-batch",
            `post-submit GET failed iap=${row.id}: ${errMsg(err)}`,
            "WARN",
          );
        }
        await db
          .from("iaps")
          .update({ state: finalState, synced_at: new Date().toISOString() })
          .eq("id", row.id);
        await db.from("actions_log").insert({
          iap_id: row.id,
          actor,
          action_type: "SUBMIT_APPLE_REVIEW",
          payload: {
            apple_iap_id: appleIapId,
            result: "SUCCESS",
            state: finalState,
            via: "batch",
          },
        });
        return {
          iap_id: row.id,
          apple_iap_id: appleIapId,
          status: "SUCCESS" as const,
          state: finalState,
        };
      } catch (err) {
        await db.from("actions_log").insert({
          iap_id: row.id,
          actor,
          action_type: "SUBMIT_APPLE_REVIEW",
          payload: {
            apple_iap_id: appleIapId,
            result: "ERROR",
            error: errMsg(err),
            via: "batch",
          },
        });
        return {
          iap_id: row.id,
          apple_iap_id: appleIapId,
          status: "ERROR" as const,
          error: errMsg(err),
        };
      }
    },
  );

  const results: ExecuteResultRow[] = [...submitResults, ...skippedResults];
  const submitted = results.filter((r) => r.status === "SUCCESS").length;
  const failed = results.filter((r) => r.status === "ERROR").length;
  const skipped = results.filter(
    (r) => r.status === "SKIPPED_BY_STATE_GUARD",
  ).length;
  const response: ExecuteResponse = {
    phase: "execute",
    submitted,
    failed,
    skipped,
    results,
  };
  return NextResponse.json(response);
}

// ─── v2 execute path (reviewSubmissions) ────────────────────────────────────

async function runExecuteV2(
  appleAppId: string,
  localRows: LocalRow[],
  actor: string,
  skipCheck: boolean,
  confirmConflict: boolean,
): Promise<NextResponse> {
  const onApple = localRows.filter((r) => r.apple_iap_id);
  if (onApple.length === 0) {
    return NextResponse.json(
      { error: "No selected IAPs are on Apple — Create on Apple first." },
      { status: 422 },
    );
  }

  const creds = await getActiveAccount();
  const db = iapDb();

  const guard = await runStateGuard(appleAppId, onApple, actor, skipCheck);
  if (!guard.ok) return guard.response;
  const { eligible, skippedResults } = guard;

  if (eligible.length === 0) {
    const response: ExecuteResponse = {
      phase: "execute",
      submitted: 0,
      failed: 0,
      skipped: skippedResults.length,
      results: skippedResults,
    };
    return NextResponse.json(response);
  }

  // ─── Decision A — conflict check (read-only) before any write ──────────
  if (!confirmConflict) {
    let conflict;
    try {
      conflict = await checkForConflict(creds, appleAppId);
    } catch (err) {
      return NextResponse.json(
        { error: errMsg(err) },
        { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
      );
    }
    if (conflict.kind === "conflict") {
      const response: ConflictResponse = {
        phase: "conflict",
        reviewSubmissionId: conflict.reviewSubmissionId,
        eligibleCount: eligible.length,
        foreignItemsSummary: conflict.foreignItemsSummary,
      };
      return NextResponse.json(response);
    }
    // clear-no-existing / clear-reuse — nothing to confirm, fall through.
  }

  // ─── Write phase ─────────────────────────────────────────────────────────
  const items: SubmitV2Item[] = eligible.map((r) => ({
    iapId: r.id,
    appleIapId: r.apple_iap_id!,
    productId: r.product_id,
  }));

  let writeResult;
  try {
    writeResult = await executeSubmitV2(creds, appleAppId, items);
  } catch (err) {
    return NextResponse.json(
      { error: errMsg(err) },
      { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
    );
  }

  const allSucceeded = writeResult.items.every((i) => i.status === "SUCCESS");

  if (!allSucceeded) {
    const response: PartialFailResponse = {
      phase: "partial-fail",
      reviewSubmissionId: writeResult.reviewSubmissionId,
      reused: writeResult.reused,
      items: writeResult.items.map((i) => ({
        iap_id: i.iapId,
        apple_iap_id: i.appleIapId,
        status: i.status,
        error: i.error,
        orphanedVersionWarning: i.orphanedVersionWarning,
      })),
      skipped: skippedResults,
    };
    // Audit every item now — partial-fail may never be confirmed/rolled
    // back if the user abandons the modal, so log outcomes as they happen.
    for (const item of writeResult.items) {
      await db.from("actions_log").insert({
        iap_id: item.iapId,
        actor,
        action_type: "SUBMIT_APPLE_REVIEW",
        payload: {
          apple_iap_id: item.appleIapId,
          result: item.status === "SUCCESS" ? "ADDED_TO_SUBMISSION" : "ERROR",
          error: item.error,
          via: "batch_v2",
          review_submission_id: writeResult.reviewSubmissionId,
          orphaned_version_warning: item.orphanedVersionWarning ?? false,
        },
      });
    }
    return NextResponse.json(response);
  }

  // All items added successfully — auto-confirm (mirrors CPP's
  // all-succeeded auto-confirm behavior).
  try {
    await confirmSubmitV2(creds, writeResult.reviewSubmissionId);
  } catch (err) {
    // Items are added but the submit PATCH failed — surface as partial-fail
    // so the user can retry confirm (proceedPartial) or leave/rollback,
    // rather than silently losing the "added but not submitted" state.
    const confirmErrorMsg = `Added to submission, but the final submit failed: ${errMsg(err)}`;
    const response: PartialFailResponse = {
      phase: "partial-fail",
      reviewSubmissionId: writeResult.reviewSubmissionId,
      reused: writeResult.reused,
      items: writeResult.items.map((i) => ({
        iap_id: i.iapId,
        apple_iap_id: i.appleIapId,
        status: i.status,
        error: confirmErrorMsg,
      })),
      skipped: skippedResults,
    };
    await log(
      "iap-submit-v2",
      `confirm PATCH failed for reviewSubmission=${writeResult.reviewSubmissionId}: ${errMsg(err)}`,
      "ERROR",
    );
    return NextResponse.json(response);
  }

  const results: ExecuteResultRow[] = [];
  for (const item of writeResult.items) {
    await db
      .from("iaps")
      .update({ state: "WAITING_FOR_REVIEW", synced_at: new Date().toISOString() })
      .eq("id", item.iapId);
    await db.from("actions_log").insert({
      iap_id: item.iapId,
      actor,
      action_type: "SUBMIT_APPLE_REVIEW",
      payload: {
        apple_iap_id: item.appleIapId,
        result: "SUCCESS",
        state: "WAITING_FOR_REVIEW",
        via: "batch_v2",
        review_submission_id: writeResult.reviewSubmissionId,
      },
    });
    results.push({
      iap_id: item.iapId,
      apple_iap_id: item.appleIapId,
      status: "SUCCESS",
      state: "WAITING_FOR_REVIEW",
    });
  }

  const response: ExecuteResponse = {
    phase: "execute",
    submitted: results.length,
    failed: 0,
    skipped: skippedResults.length,
    results: [...results, ...skippedResults],
  };
  return NextResponse.json(response);
}

// ─── v2 follow-up actions ───────────────────────────────────────────────────

async function runProceedPartial(
  actor: string,
  args: { reviewSubmissionId: string; submittedIapIds: string[] },
): Promise<NextResponse> {
  const creds = await getActiveAccount();
  const db = iapDb();
  try {
    await confirmSubmitV2(creds, args.reviewSubmissionId);
  } catch (err) {
    return NextResponse.json(
      { error: errMsg(err) },
      { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
    );
  }

  for (const iapId of args.submittedIapIds) {
    await db
      .from("iaps")
      .update({ state: "WAITING_FOR_REVIEW", synced_at: new Date().toISOString() })
      .eq("id", iapId);
    await db.from("actions_log").insert({
      iap_id: iapId,
      actor,
      action_type: "SUBMIT_APPLE_REVIEW",
      payload: {
        result: "SUCCESS",
        state: "WAITING_FOR_REVIEW",
        via: "batch_v2_proceed_partial",
        review_submission_id: args.reviewSubmissionId,
      },
    });
  }

  const response: ConfirmedResponse = { phase: "confirmed" };
  return NextResponse.json(response);
}

async function runRollback(
  actor: string,
  args: { reviewSubmissionId: string; reused: boolean; addedIapIds: string[] },
): Promise<NextResponse> {
  const creds = await getActiveAccount();
  const db = iapDb();
  let deleted: boolean;
  try {
    const result = await rollbackOrLeaveSubmitV2(
      creds,
      args.reviewSubmissionId,
      args.reused,
    );
    deleted = result.deleted;
  } catch (err) {
    return NextResponse.json(
      { error: errMsg(err) },
      { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
    );
  }

  for (const iapId of args.addedIapIds) {
    await db.from("actions_log").insert({
      iap_id: iapId,
      actor,
      action_type: "SUBMIT_APPLE_REVIEW",
      payload: {
        result: deleted ? "ROLLED_BACK" : "LEFT_UNSUBMITTED",
        via: "batch_v2_rollback",
        review_submission_id: args.reviewSubmissionId,
      },
    });
  }

  const response: RolledBackResponse = { phase: "rolled-back", deleted };
  return NextResponse.json(response);
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
