/**
 * Create a new IAP under an app — POST handler.
 *
 * Q-GIAP.F: Manager input arrives as decimal strings; conversion to
 * micros happens server-side via the orchestrator.
 *
 * Validation strategy: structural (zod-light, since we already have
 * the orchestrator throwing on semantic problems). Decimal validation
 * is done inside decimalToMicros which throws on negative or
 * over-precision input.
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
import { createIapOnGoogle } from "@/lib/google-iap-management/orchestration/create-iap";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";
import { lookupTemplateEntriesForIdentifier } from "@/lib/google-iap-management/queries/templates";

export const dynamic = "force-dynamic";

interface CreateBody {
  sku?: string;
  purchaseType?: "managed" | "consumable";
  status?: "active" | "inactive";
  defaultLanguage?: string;
  listings?: Array<{ locale: string; title: string; description: string }>;
  baseCurrency?: string;
  basePriceDecimal?: string;
  regionOverrides?: Array<{ region: string; currency: string; priceDecimal: string }>;
  pricingSource?: "google_default" | "default_template" | "app_template";
  tierIdentifier?: string | null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function POST(
  req: Request,
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

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate
  if (!isNonEmptyString(body.sku)) {
    return NextResponse.json({ error: "sku is required." }, { status: 400 });
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
    let regionOverrides = (body.regionOverrides ?? [])
      .filter((r) => isNonEmptyString(r.region) && isNonEmptyString(r.priceDecimal))
      .map((r) => ({
        region: r.region.trim(),
        currency: (r.currency ?? "USD").trim(),
        priceDecimal: r.priceDecimal.trim(),
      }));

    // Q-GIAP.D: template-source picks override the manual region grid with
    // the template tier's entries. App template > Default template.
    if (
      (body.pricingSource === "default_template" || body.pricingSource === "app_template") &&
      isNonEmptyString(body.tierIdentifier)
    ) {
      const scope = body.pricingSource === "app_template" ? "APP" : "GLOBAL";
      const entries = await lookupTemplateEntriesForIdentifier({
        scope,
        appId: scope === "APP" ? app.id : null,
        identifier: body.tierIdentifier.trim(),
      });
      if (entries.length === 0) {
        return NextResponse.json(
          {
            error: `Tier "${body.tierIdentifier}" not found in the selected template.`,
          },
          { status: 404 },
        );
      }
      regionOverrides = entries.map((e) => ({
        region: e.regionCode,
        currency: e.currency,
        priceDecimal: microsToDecimal(e.priceMicros, 6),
      }));
    }

    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const result = await createIapOnGoogle(jwt, {
      appId: app.id,
      packageName,
      sku: body.sku.trim(),
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
      regionOverrides,
      actorEmail: session.user.email ?? null,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Google API errors come through as { code, message } from googleapis.
    const e = err as { code?: number; status?: number; message?: string };
    const message = e?.message ?? "Failed to create IAP";
    const httpStatus = typeof e?.code === "number" && e.code >= 400 && e.code < 600
      ? e.code
      : 500;
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
