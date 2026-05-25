/**
 * POST /api/iap-management/apps/[appId]/iaps/submit-batch
 *
 * IAP.o.6b — list-page multi-select Submit Selected flow.
 *
 * Two phases controlled by body.execute:
 *
 *   • Phase 1 (preflight, default): one Apple `listInAppPurchases` call,
 *     fresh state bucketed per selected IAP. Returns ready / missing_metadata
 *     / other / not_on_apple lists for the Manager preview modal.
 *
 *   • Phase 2 (execute, body.execute=true): submits the supplied iap_ids in
 *     parallel via `submitInAppPurchase` (concurrency 5). Each result is
 *     audit-logged with action_type=SUBMIT_APPLE_REVIEW.
 *
 * Apple state is canonical — the local cache (iap_mgmt.iaps.state) is the
 * mirror, refreshed by both phases (post-listInAppPurchases for preflight,
 * post-submitInAppPurchase GET for execute).
 *
 * Body shape:
 *   { iap_ids: string[]; execute?: boolean }
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
 */
const SUBMIT_CONCURRENCY = 2;

const BodySchema = z.object({
  iap_ids: z.array(z.string().uuid()).min(1).max(200),
  execute: z.boolean().optional().default(false),
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
  const localRows = (localRes.data ?? []) as Array<{
    id: string;
    apple_iap_id: string | null;
    product_id: string;
    reference_name: string;
  }>;

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
  return await runExecute(appleAppId, localRows, actor, skipCheck);
}

async function runPreflight(
  appleAppId: string,
  localRows: Array<{
    id: string;
    apple_iap_id: string | null;
    product_id: string;
    reference_name: string;
  }>,
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

async function runExecute(
  appleAppId: string,
  localRows: Array<{
    id: string;
    apple_iap_id: string | null;
    product_id: string;
    reference_name: string;
  }>,
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

  // ─── IAP.q.1.IV — server-side state guard ───────────────────────────────
  // Defence-in-depth: even when the modal preflight passed only `ready` IDs,
  // a race (Apple flipped state) or direct API call could land non-ready
  // submissions here. Refetch Apple state and partition `onApple` into
  // `eligible` (state === READY_TO_SUBMIT) vs `skipped` (anything else).
  // `?skipCheck=true` bypasses the guard for explicit internal callers.
  let eligible: Array<{
    id: string;
    apple_iap_id: string | null;
    product_id: string;
    reference_name: string;
  }> = onApple;
  const skippedResults: ExecuteResultRow[] = [];

  if (!skipCheck) {
    let stateByAppleId: Map<string, string>;
    try {
      const res = await withRetry(() =>
        listInAppPurchases(creds, appleAppId),
      );
      stateByAppleId = new Map(
        (res.data ?? []).map((iap) => [iap.id, iap.attributes.state]),
      );
    } catch (err) {
      return NextResponse.json(
        { error: `State recheck failed: ${errMsg(err)}` },
        { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
      );
    }

    const partition = partitionByStateGuard(
      onApple.map((r) => ({ id: r.id, apple_iap_id: r.apple_iap_id! })),
      stateByAppleId,
    );

    // Audit + mirror skipped rows; surface in results.
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
        .update({
          state: skip.apple_state,
          synced_at: new Date().toISOString(),
        })
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

    // Rehydrate eligible rows from the original onApple list (helper returns
    // the narrow {id, apple_iap_id} shape but downstream needs full row).
    const eligibleIds = new Set(partition.eligible.map((e) => e.id));
    eligible = onApple.filter((r) => eligibleIds.has(r.id));
  }

  // ─── Submit eligible rows ──────────────────────────────────────────────
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

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
