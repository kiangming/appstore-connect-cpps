/**
 * GET live per-territory prices for a single IAP straight from Google
 * (display-only — does NOT write iap_prices).
 *
 * Backs the item detail "Price live on Google" column. Uses the lightest
 * single-item call (monetization.onetimeproducts.get → legacy
 * inappproducts.get fallback) via getInAppProduct. On any failure returns a
 * non-200 with an error message so the client degrades gracefully (the
 * tool/DB column still renders); never persists anything.
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
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import type { RegionPrice } from "@/lib/google-iap-management/price-comparison";

export const dynamic = "force-dynamic";

export async function GET(
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
      { error: `App "${packageName}" is not cached.` },
      { status: 404 },
    );
  }

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const product = await getInAppProduct(jwt, packageName, sku);
    const prices: RegionPrice[] = Object.entries(product.prices ?? {})
      .filter(([, p]) => p?.priceMicros && p?.currency)
      .map(([region, p]) => ({
        region_code: region,
        currency: p.currency as string,
        price_micros: p.priceMicros as string,
      }));
    return NextResponse.json({ ok: true, prices });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch live prices";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
