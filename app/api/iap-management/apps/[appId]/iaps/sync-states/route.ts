/**
 * POST /api/iap-management/apps/[appId]/iaps/sync-states
 *
 * IAP.o.6c — Manager-triggered Apple state refresh.
 *
 * Calls `listInAppPurchases` for the app and mirrors the fresh state of every
 * returned IAP into `iap_mgmt.iaps.state` (matched by apple_iap_id).
 *
 * The list-page Refresh button hits this — keeps Apple as source of truth
 * without users needing to trigger a manual reload of the page itself.
 *
 * Audit log: single action_type='SYNC_STATE_FROM_APPLE' row per call (the
 * per-IAP detail is in the payload to avoid log explosion for large apps).
 */

import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { findAppByAppleId } from "@/lib/iap-management/queries/iaps";
import { getActiveAccount } from "@/lib/get-active-account";
import { listInAppPurchases } from "@/lib/iap-management/apple/client";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

interface SyncResponse {
  synced_count: number;
  unchanged_count: number;
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

  // Fresh Apple list
  let appleIaps;
  try {
    const creds = await getActiveAccount();
    const res = await withRetry(() => listInAppPurchases(creds, appleAppId));
    appleIaps = res.data ?? [];
  } catch (err) {
    const msg = errMsg(err);
    await log("iap-sync-states", `apple list failed: ${msg}`, "ERROR");
    return NextResponse.json(
      { error: msg },
      { status: err instanceof AppleApiError && err.status < 500 ? err.status : 502 },
    );
  }

  // Read current local cache for the app — used to count "unchanged"
  // vs "synced" (state mismatch).
  const db = iapDb();
  const internalAppId = await findAppByAppleId(appleAppId);
  const currentByAppleId = new Map<string, string>();
  if (internalAppId) {
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

  let synced = 0;
  let unchanged = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  for (const iap of appleIaps) {
    const appleState = iap.attributes.state;
    const localState = currentByAppleId.get(iap.id);
    if (localState === appleState) {
      // Still touch synced_at so the row reflects a fresh check.
      const res = await db
        .from("iaps")
        .update({ synced_at: now })
        .eq("apple_iap_id", iap.id);
      if (res.error) {
        errors.push(`${iap.attributes.productId}: ${res.error.message}`);
      } else {
        unchanged++;
      }
      continue;
    }
    const res = await db
      .from("iaps")
      .update({ state: appleState, synced_at: now })
      .eq("apple_iap_id", iap.id);
    if (res.error) {
      errors.push(`${iap.attributes.productId}: ${res.error.message}`);
      continue;
    }
    // Update issued — counts as "synced" whether the row existed locally
    // or not (PostgreSQL no-ops the match-zero case silently).
    synced++;
  }

  await db.from("actions_log").insert({
    actor,
    action_type: "SYNC_STATE_FROM_APPLE",
    payload: {
      apple_app_id: appleAppId,
      apple_count: appleIaps.length,
      synced_count: synced,
      unchanged_count: unchanged,
      error_count: errors.length,
    },
  });

  const response: SyncResponse = {
    synced_count: synced,
    unchanged_count: unchanged,
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
