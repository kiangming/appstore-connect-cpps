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
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { ensureAppRegistered } from "@/lib/iap-management/queries/iaps";
import { getActiveAccount } from "@/lib/get-active-account";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getApp } from "@/lib/asc-client";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { classifySyncStates } from "@/lib/iap-management/sync-states/classify";
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
}

export async function POST(
  _req: Request,
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
  const appleAppId = ctx.params.appId;

  // Apple list + app meta (paginated) — IAP.o.7a established `listAllIn
  // AppPurchases` as the canonical wrapper so apps with >200 IAPs aren't
  // silently truncated. `getApp` gives us bundle_id + name needed by
  // `ensureAppRegistered` on first sync of a never-touched app.
  let appleIaps;
  let internalAppId: string;
  try {
    const creds = await getActiveAccount();
    const [appRes, iapsRes] = await Promise.all([
      getApp(creds, appleAppId),
      withRetry(() => listAllInAppPurchases(creds, appleAppId)),
    ]);
    internalAppId = await ensureAppRegistered({
      apple_app_id: appleAppId,
      bundle_id: appRes.data.attributes.bundleId,
      name: appRes.data.attributes.name,
      asc_account_id: creds.id,
    });
    appleIaps = iapsRes.data ?? [];
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
    },
  });

  const response: SyncResponse = {
    updated_count: updated,
    unchanged_count: unchanged,
    inserted_count: inserted,
    synced_count: synced,
    errors,
  };
  return NextResponse.json(response);
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
