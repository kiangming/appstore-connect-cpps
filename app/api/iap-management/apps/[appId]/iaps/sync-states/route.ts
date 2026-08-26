/**
 * POST /api/iap-management/apps/[appId]/iaps/sync-states
 *
 * IAP.o.6c — Manager-triggered Apple state refresh.
 * IAP.o.8b — Manager MV30 Issue 2: when an app's IAPs were authored on
 * Apple Connect before this tool ever touched them, the local cache was
 * empty and the legacy UPDATE-only flow silently no-op'd. Every per-row
 * checkbox in the IAP list stayed disabled because `appleToInternal` was
 * empty → "Submit Selected" was invisible.
 *
 * New behavior: each Apple IAP is mirrored into `iap_mgmt.iaps` as an UPSERT
 * — existing rows get state + synced_at; missing rows get a minimal stub
 * insert (apple_iap_id, product_id, reference_name = Apple name, type,
 * state, base_territory). Stub rows are eligible for Submit Selected /
 * single-IAP submit immediately on the next render.
 *
 * Stub-row caveats:
 *   • `iap_localizations` + `iap_screenshots` start empty for stubs — the
 *     edit page renders them via the `syncedToApple=true` read-only gate,
 *     and bulk-import will overwrite them when Manager re-imports.
 *   • `listDraftIaps` filters `apple_iap_id IS NULL`, so stubs (which have
 *     an apple_iap_id) don't pollute the Drafts section.
 *   • `listSyncedAppleIapMap` returns stubs by design — that's the whole
 *     point of the fix.
 *
 * Audit log: single SYNC_STATE_FROM_APPLE row per call (the per-IAP detail
 * is in the payload to avoid log explosion for large apps).
 */

import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { ensureAppRegistered } from "@/lib/iap-management/queries/iaps";
import { getActiveAccount } from "@/lib/get-active-account";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getApp } from "@/lib/asc-client";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import { classifySyncStates } from "@/lib/iap-management/sync-states/classify";
import {
  buildSweepTargets,
  runAvailabilitySweep,
} from "@/lib/iap-management/apple/availability-sweep";
import { recordAvailabilityMirrorBatch } from "@/lib/iap-management/queries/availability-mirror";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

interface SyncResponse {
  /** Rows where Apple's state differed from the cache and were UPDATEd. */
  updated_count: number;
  /** Rows present locally with state already matching Apple. synced_at touched. */
  unchanged_count: number;
  /** Rows that didn't exist locally and were INSERTed as stubs. */
  inserted_count: number;
  /**
   * Backwards-compatible alias for callers still reading `synced_count`.
   * Equals `updated_count + inserted_count` — rows whose payload changed.
   */
  synced_count: number;
  errors: string[];
  /**
   * [EXPORT-availability-filter] C4 — the availability half of the refresh.
   *
   * ⚠ Reported SEPARATELY from the state counters above and never folded into
   * them. They are two different questions about the same items — Apple's
   * review status and Apple's territory reach — and the whole reason the
   * export wizard shows both axes is that they can disagree. A single
   * "refreshed N" that averaged them would hide exactly that.
   */
  availability_read_count: number;
  availability_failed_count: number;
  availability_not_attempted_count: number;
  /** True when the sweep stopped early on Apple's rate limit. The items it
   *  never reached keep their PREVIOUS as-of timestamp — including none. */
  availability_stopped: boolean;
}

export async function POST(
  _req: Request,
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

  // Apple list + app meta (paginated) — IAP.o.7a established `listAllIn
  // AppPurchases` as the canonical wrapper so apps with >200 IAPs aren't
  // silently truncated. `getApp` gives us bundle_id + name needed by
  // `ensureAppRegistered` on first sync of a never-touched app.
  let appleIaps;
  // ⚠ C4 — kept alongside `appleIaps` because the availability sweep reads its
  //   ids and flags out of `included[]`. Same list call, same pages; asking for
  //   the include is what makes the sweep 1 request per item instead of 2.
  let appleIncluded: Awaited<ReturnType<typeof listAllInAppPurchases>>["included"];
  let internalAppId: string;
  try {
    const creds = await getActiveAccount();
    // ⚠ NO outer `withRetry` on listAllInAppPurchases — it retries each page
    // internally (client.ts:70) and its docstring forbids wrapping it
    // (client.ts:52-54). The wrapper made it 4 × 4 = 16 attempts, and since
    // the outer retry restarts enumeration from page 1, a tail-page 429 also
    // re-fetched every page already read. Twin of the export:68 site; both
    // fixed together.
    const [appRes, iapsRes] = await Promise.all([
      getApp(creds, appleAppId),
      // ⚠ C4 [EXPORT-avail-read-halving] — the include costs no extra request
      //   and carries the availability resource id + availableInNewTerritories
      //   for every item, which is exactly what `getAvailabilityForIap`'s Step
      //   A would otherwise cost one request each to learn.
      //   ⚠ It does NOT let anything classify availability from the list — see
      //   `availabilityIdFromListedIap`. The verdict still comes from a
      //   territory count, per item, below.
      listAllInAppPurchases(creds, appleAppId, { includeAvailability: true }),
    ]);
    internalAppId = await ensureAppRegistered({
      apple_app_id: appleAppId,
      bundle_id: appRes.data.attributes.bundleId,
      name: appRes.data.attributes.name,
      asc_account_id: creds.id,
    });
    appleIaps = iapsRes.data ?? [];
    appleIncluded = iapsRes.included;
  } catch (err) {
    const msg = errMsg(err);
    await log("iap-sync-states", `apple list failed: ${msg}`, "ERROR");
    return NextResponse.json(
      { error: msg },
      { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
    );
  }

  // Snapshot current local rows for the app so we can classify each Apple
  // IAP as INSERT / UPDATE-state / UNCHANGED without doing a per-row SELECT.
  const db = iapDb();
  const currentByAppleId = new Map<string, string>();
  {
    const localRes = await db
      .from("iaps")
      .select("apple_iap_id, state")
      .eq("app_id", internalAppId)
      .not("apple_iap_id", "is", null);
    if (!localRes.error) {
      for (const row of (localRes.data ?? []) as Array<{
        apple_iap_id: string | null;
        state: string;
      }>) {
        if (row.apple_iap_id) currentByAppleId.set(row.apple_iap_id, row.state);
      }
    }
  }

  // Pure classification (see lib/iap-management/sync-states/classify.ts) —
  // separates the decision matrix from the DB I/O so the per-row routing
  // can be unit-tested without mocking Supabase.
  const { decisions } = classifySyncStates(appleIaps, currentByAppleId);

  let updated = 0;
  let inserted = 0;
  let unchanged = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();
  const productIdByAppleId = new Map(
    appleIaps.map((iap) => [iap.id, iap.attributes.productId]),
  );

  for (const decision of decisions) {
    const productId = productIdByAppleId.get(decision.apple_iap_id) ?? "?";
    if (decision.kind === "INSERT") {
      const payload = decision.insert_payload!;
      const ins = await db.from("iaps").insert({
        app_id: internalAppId,
        apple_iap_id: payload.apple_iap_id,
        product_id: payload.product_id,
        reference_name: payload.reference_name,
        type: payload.type,
        state: payload.state,
        synced_at: now,
      });
      if (ins.error) {
        errors.push(`${productId}: ${ins.error.message}`);
        continue;
      }
      inserted++;
    } else if (decision.kind === "UNCHANGED") {
      const res = await db
        .from("iaps")
        .update({ synced_at: now })
        .eq("apple_iap_id", decision.apple_iap_id);
      if (res.error) {
        errors.push(`${productId}: ${res.error.message}`);
      } else {
        unchanged++;
      }
    } else {
      // UPDATE_STATE
      const res = await db
        .from("iaps")
        .update({ state: decision.state, synced_at: now })
        .eq("apple_iap_id", decision.apple_iap_id);
      if (res.error) {
        errors.push(`${productId}: ${res.error.message}`);
        continue;
      }
      updated++;
    }
  }

  const synced = updated + inserted;

  // ── [EXPORT-availability-filter] C4 — the availability sweep. ─────────────
  //
  // Census M3: this button re-read Apple's IAP list and wrote `state`, and the
  // Manager reasonably believed it also refreshed Available/Removed. It did
  // not — availability was never asked for here, so the list column kept
  // showing whatever it had loaded, including right after a Remove from Sales.
  // The sweep closes that, and it is what gives "as of last sync" something
  // that can make it recent.
  //
  // ⚠ Runs AFTER the state loop, deliberately: the loop is what seeds stubs
  //   for Apple items with no local row, and the mirror is keyed on the
  //   internal id. Sweeping first would silently skip every newly-discovered
  //   item on the very refresh that discovered it.
  //
  // ⚠ NON-FATAL, ALWAYS. The state sync has already succeeded and been
  //   counted by the time we get here. A sweep that fails, or stops on Apple's
  //   rate limit, must not turn a successful refresh into an error response —
  //   it reports its own three counters and lets the Manager see what landed.
  let availabilityRead = 0;
  let availabilityFailed = 0;
  let availabilityNotAttempted = 0;
  let availabilityStopped = false;
  try {
    const internalByAppleId = new Map<string, string>();
    const idRes = await db
      .from("iaps")
      .select("id, apple_iap_id")
      .eq("app_id", internalAppId)
      .not("apple_iap_id", "is", null);
    for (const row of (idRes.data ?? []) as Array<{
      id: string;
      apple_iap_id: string | null;
    }>) {
      if (row.apple_iap_id) internalByAppleId.set(row.apple_iap_id, row.id);
    }

    const targets = buildSweepTargets({
      listed: appleIaps,
      included: appleIncluded,
      internalByAppleId,
    });
    const creds = await getActiveAccount();
    const sweep = await runAvailabilitySweep({ creds, targets });

    // ⚠ ONLY THE ITEMS ACTUALLY READ ARE WRITTEN, and one timestamp is shared
    //   across the sweep so "as of" means a single instant rather than
    //   drifting across however long the fan-out took. Items that FAILED and
    //   items the stop latch never reached are absent from `sweep.read` by
    //   construction — they keep their previous verdict and their previous
    //   timestamp, which is the honest record of when Apple last answered for
    //   them.
    await recordAvailabilityMirrorBatch(sweep.read, new Date().toISOString());

    availabilityRead = sweep.readCount;
    availabilityFailed = sweep.failedCount;
    availabilityNotAttempted = sweep.notAttemptedCount;
    availabilityStopped = sweep.stoppedByRateLimit;
    await log(
      "iap-sync-states",
      `availability sweep app=${appleAppId} read=${availabilityRead} failed=${availabilityFailed} not_attempted=${availabilityNotAttempted} stopped=${availabilityStopped}`,
    );
  } catch (err) {
    await log(
      "iap-sync-states",
      `availability sweep failed app=${appleAppId}: ${errMsg(err)}`,
      "WARN",
    );
  }

  await db.from("actions_log").insert({
    actor,
    action_type: "SYNC_STATE_FROM_APPLE",
    payload: {
      apple_app_id: appleAppId,
      apple_count: appleIaps.length,
      inserted_count: inserted,
      updated_count: updated,
      unchanged_count: unchanged,
      error_count: errors.length,
      availability_read_count: availabilityRead,
      availability_failed_count: availabilityFailed,
      availability_not_attempted_count: availabilityNotAttempted,
      availability_stopped: availabilityStopped,
    },
  });

  const response: SyncResponse = {
    updated_count: updated,
    unchanged_count: unchanged,
    inserted_count: inserted,
    synced_count: synced,
    errors,
    availability_read_count: availabilityRead,
    availability_failed_count: availabilityFailed,
    availability_not_attempted_count: availabilityNotAttempted,
    availability_stopped: availabilityStopped,
  };
  return NextResponse.json(response);
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
