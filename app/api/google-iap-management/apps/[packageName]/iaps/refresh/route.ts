/**
 * Refresh IAPs cache for a single Google Play app under the active account.
 *
 * Calls Android Publisher v3 inappproducts.list (managed products only —
 * subscriptions deferred per Q-GIAP.A) and replaces the cache for each
 * returned IAP via syncIapFromGoogle (top-level UPSERT + listings/prices
 * delete-then-insert).
 *
 * Audit: IAPS_LIST_SYNC entry with synced + failed counts + duration.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import { listInAppProducts } from "@/lib/google-iap-management/google/publisher-client";
import { getEncryptedCredentials } from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { batchSyncIapsFromGoogle } from "@/lib/google-iap-management/repository/iaps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { packageName: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountId = readActiveAccountId();
  if (!accountId) {
    return NextResponse.json(
      { error: "No active Google Console account selected." },
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
    const products = await listInAppProducts(jwt, packageName);
    const { synced, failed } = await batchSyncIapsFromGoogle(app.id, products);

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
      },
    });

    return NextResponse.json({
      ok: true,
      synced,
      failed,
      total: products.length,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh IAPs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
