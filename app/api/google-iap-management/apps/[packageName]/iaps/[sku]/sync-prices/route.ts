/**
 * POST — sync ONE IAP's stored prices from Google's live values.
 *
 * Thin wrapper: getInAppProduct (live single-item pull) → syncIapFromGoogle
 * (replace-all of this IAP's iap_prices + listings + last_synced_at, the same
 * writer the list "Refresh" uses) → audit. DB-only overwrite; no Play Store
 * mutation. After this, the detail view's "tool" column equals what was just
 * pulled, so the two columns reconcile.
 *
 * Distinct from the list-level refresh: scoped to a single sku. Reuses the
 * allowed IAPS_LIST_SYNC audit type (no migration) with a single-item payload.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { getInAppProduct } from "@/lib/google-iap-management/google/publisher-client";
import { syncIapFromGoogle } from "@/lib/google-iap-management/repository/iaps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import type { RegionPrice } from "@/lib/google-iap-management/price-comparison";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { packageName: string; sku: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      { error: "No Google Console accounts configured." },
      { status: 400 },
    );
  }

  const packageName = decodeURIComponent(params.packageName);
  const sku = decodeURIComponent(params.sku);

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
    const product = await getInAppProduct(jwt, packageName, sku);

    // Replace-all of this IAP's cached prices/listings from the live pull
    // (same writer as the list refresh; bumps last_synced_at).
    await syncIapFromGoogle(app.id, product);

    const prices: RegionPrice[] = Object.entries(product.prices ?? {})
      .filter(([, p]) => p?.priceMicros && p?.currency)
      .map(([region, p]) => ({
        region_code: region,
        currency: p.currency as string,
        price_micros: p.priceMicros as string,
      }));

    await appendAction({
      actionType: "IAPS_LIST_SYNC",
      actorEmail: session.user.email ?? null,
      targetId: app.id,
      payload: {
        package_name: packageName,
        sku,
        scope: "single-item-price-sync",
        synced: 1,
        failed: 0,
        region_count: prices.length,
        duration_ms: Date.now() - t0,
      },
    });

    return NextResponse.json({ ok: true, sku, prices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to sync prices";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
