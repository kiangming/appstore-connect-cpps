/**
 * Refresh IAPs cache for a single Google Play app under the active account.
 *
 * Calls listInAppProducts (monetization.onetimeproducts.list first — see
 * publisher-client.ts) and replaces the cache via batchSyncIapsFromGoogle.
 *
 * Audit: IAPS_LIST_SYNC entry with synced + failed counts + duration.
 *
 * D0 [arc-google-missing-purchase-options]: a COMPLETE refresh stamps
 * apps.iaps_last_synced_at. Bulk import refuses while that stamp is NULL — an
 * app whose IAP list was never read must not be imported as "every SKU is
 * new". Whether a refresh is complete is decided in ONE place,
 * decideMirrorStamp (bulk-import-mirror-gate.ts): no stamp when rows failed,
 * and (C2.1a) no stamp when Google answered with an EMPTY list while the mirror
 * still holds items — logged, audited and told to the Manager, never silent.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import { listInAppProducts } from "@/lib/google-iap-management/google/publisher-client";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import {
  getAppByPackage,
  markIapsMirrorSynced,
} from "@/lib/google-iap-management/repository/apps";
import {
  batchSyncIapsFromGoogle,
  countLiveMirrorItems,
} from "@/lib/google-iap-management/repository/iaps";
import { decideMirrorStamp } from "@/lib/google-iap-management/bulk-import-mirror-gate";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { packageName: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      {
        error:
          "No Google Console accounts configured. Add one in Settings → Google Console Accounts first.",
      },
      { status: 400 },
    );
  }

  const packageName = decodeURIComponent(params.packageName);
  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  const t0 = Date.now();
  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    // listInAppProducts fully paginates or throws — reaching here means the
    // fetch completed, so flag-reconcile may run.
    const products = await listInAppProducts(jwt, packageName);
    // C2.1a — measured BEFORE the sync, and only for an empty answer: did the
    // mirror hold items when Google said there are none? Throws on a read
    // error (→ 500, no stamp): "could not count" must never read as 0.
    const liveMirrorItems =
      products.length === 0 ? await countLiveMirrorItems(app.id) : null;
    const { synced, failed, flagReconcile } = await batchSyncIapsFromGoogle(
      app.id,
      products,
      { fetchComplete: true },
    );

    const stampDecision = decideMirrorStamp({ fetched: products.length, failed, liveMirrorItems });

    await appendAction({
      actionType: "IAPS_LIST_SYNC",
      actorEmail: session.user.email ?? null,
      targetId: app.id,
      payload: {
        package_name: packageName,
        synced,
        failed,
        total: products.length,
        duration_ms: Date.now() - t0,
        // Soft-delete reconcile — SEPARATE from synced/failed accounting.
        flagged: flagReconcile.flagged,
        unflagged: flagReconcile.unflagged,
        flagged_skus: flagReconcile.flaggedSkus,
        unflagged_skus: flagReconcile.unflaggedSkus,
        flag_reconcile_skipped: flagReconcile.skippedReason,
        // C2.1a — the stamp DECISION (not its write outcome).
        stamp_decision: stampDecision.stamp ? "stamp" : `skip:${stampDecision.reason}`,
        mirror_live_items_before: liveMirrorItems,
      },
    });

    // D0 — stamp ONLY a complete mirror. A throw here (0 rows written, DB
    // error) lands in the catch below as a 500: the products were synced, but
    // bulk import would still see "never synced", and saying "ok" would
    // report a goal (mirror usable for import) that was not reached.
    const mirrorComplete = stampDecision.stamp;
    let iapsLastSyncedAt: string | null = null;
    if (stampDecision.stamp) {
      iapsLastSyncedAt = new Date().toISOString();
      await markIapsMirrorSynced(app.id, iapsLastSyncedAt);
    } else {
      console.warn(
        `[google-iap:iap-refresh] NOT stamping pkg=${packageName} reason=${stampDecision.reason} ` +
          `fetched=${products.length} failed=${failed} mirror_live_before=${liveMirrorItems ?? "-"}`,
      );
    }

    return NextResponse.json({
      ok: true,
      synced,
      failed,
      total: products.length,
      flagged: flagReconcile.flagged,
      unflagged: flagReconcile.unflagged,
      flag_reconcile_skipped: flagReconcile.skippedReason,
      duration_ms: Date.now() - t0,
      mirror_complete: mirrorComplete,
      // null when THIS run did not stamp — not "never synced".
      mirror_synced_at: iapsLastSyncedAt,
      // Why it did not stamp, in words the Manager can act on (null if stamped).
      mirror_not_complete_reason: stampDecision.stamp ? null : stampDecision.reason,
      mirror_warning: stampDecision.stamp ? null : stampDecision.message,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh IAPs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
