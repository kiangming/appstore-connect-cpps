/**
 * Update an existing IAP — PATCH handler (g1.h).
 *
 * Validation mirrors POST handler (create); decimal validation throws from
 * decimalToMicros inside the orchestrator. If diff is empty, returns 200
 * with hasChanges=false rather than calling Google.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import { getEncryptedCredentials } from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { getIapDetail } from "@/lib/google-iap-management/repository/iaps";
import { updateIapOnGoogle } from "@/lib/google-iap-management/orchestration/update-iap";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";

export const dynamic = "force-dynamic";

interface UpdateBody {
  purchaseType?: "managed" | "consumable";
  status?: "active" | "inactive";
  defaultLanguage?: string;
  listings?: Array<{ locale: string; title: string; description: string }>;
  baseCurrency?: string;
  basePriceDecimal?: string;
  regionOverrides?: Array<{ region: string; currency: string; priceDecimal: string }>;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function PATCH(
  req: Request,
  { params }: { params: { packageName: string; sku: string } },
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
  const sku = decodeURIComponent(params.sku);

  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  const detail = await getIapDetail(app.id, sku);
  if (!detail) {
    return NextResponse.json(
      { error: `IAP "${sku}" not found in cache. Refresh IAPs and retry.` },
      { status: 404 },
    );
  }

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.purchaseType !== "managed" && body.purchaseType !== "consumable") {
    return NextResponse.json(
      { error: "purchaseType must be 'managed' or 'consumable'." },
      { status: 400 },
    );
  }
  if (body.status !== "active" && body.status !== "inactive") {
    return NextResponse.json(
      { error: "status must be 'active' or 'inactive'." },
      { status: 400 },
    );
  }
  if (!isNonEmptyString(body.defaultLanguage)) {
    return NextResponse.json(
      { error: "defaultLanguage is required (e.g. 'en-US')." },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.listings) || body.listings.length === 0) {
    return NextResponse.json(
      { error: "At least one locale listing is required." },
      { status: 400 },
    );
  }
  if (!isNonEmptyString(body.baseCurrency)) {
    return NextResponse.json(
      { error: "baseCurrency is required (e.g. 'USD')." },
      { status: 400 },
    );
  }
  if (!isNonEmptyString(body.basePriceDecimal)) {
    return NextResponse.json(
      { error: "basePriceDecimal is required (e.g. '1.99')." },
      { status: 400 },
    );
  }

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const result = await updateIapOnGoogle(jwt, {
      appId: app.id,
      packageName,
      sku,
      purchaseType: body.purchaseType,
      status: body.status,
      defaultLanguage: body.defaultLanguage.trim(),
      listings: body.listings
        .filter((l) => isNonEmptyString(l.locale))
        .map((l) => ({
          locale: l.locale.trim(),
          title: l.title?.trim() ?? "",
          description: l.description?.trim() ?? "",
        })),
      baseCurrency: body.baseCurrency.trim(),
      basePriceDecimal: body.basePriceDecimal.trim(),
      regionOverrides: (body.regionOverrides ?? [])
        .filter((r) => isNonEmptyString(r.region) && isNonEmptyString(r.priceDecimal))
        .map((r) => ({
          region: r.region.trim(),
          currency: (r.currency ?? "USD").trim(),
          priceDecimal: r.priceDecimal.trim(),
        })),
      actorEmail: session.user.email ?? null,
      current: detail,
    });

    return NextResponse.json(result);
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    const message = e?.message ?? "Failed to update IAP";
    const httpStatus = typeof e?.code === "number" && e.code >= 400 && e.code < 600
      ? e.code
      : 500;
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
