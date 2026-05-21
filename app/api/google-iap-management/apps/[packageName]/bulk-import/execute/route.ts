/**
 * Bulk-import execute endpoint (g1.i).
 *
 * Accepts the wizard's parsed rows + per-row decisions (already shown in
 * the preview step) and calls the bulk-import orchestrator, which fires
 * a single batchUpdate request to Google Play.
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
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import {
  executeBulkImport,
  type BulkImportRow,
  type PricingSource,
  type RowDecision,
} from "@/lib/google-iap-management/orchestration/bulk-import";

export const dynamic = "force-dynamic";

interface ExecuteBody {
  pricingSource?: PricingSource;
  sourceFilename?: string | null;
  rows?: Array<{
    rowNumber?: number;
    sku?: string;
    baseCurrency?: string;
    basePriceDecimal?: string;
    regionOverrides?: Array<{ region: string; currency: string; priceDecimal: string }>;
    listings?: Array<{ locale: string; title: string; description: string }>;
    decision?: RowDecision;
  }>;
}

const VALID_PRICING_SOURCES: PricingSource[] = [
  "google_default",
  "default_template",
  "app_template",
];
const VALID_DECISIONS: RowDecision[] = ["overwrite", "skip", "create"];

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

  let body: ExecuteBody;
  try {
    body = (await req.json()) as ExecuteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const pricingSource = body.pricingSource;
  if (!pricingSource || !VALID_PRICING_SOURCES.includes(pricingSource)) {
    return NextResponse.json(
      { error: `pricingSource must be one of ${VALID_PRICING_SOURCES.join(", ")}.` },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows is required." }, { status: 400 });
  }

  const rows: BulkImportRow[] = [];
  for (const r of body.rows) {
    if (!r.sku || !r.basePriceDecimal || !r.baseCurrency) {
      return NextResponse.json(
        { error: `Row ${r.rowNumber ?? "?"}: sku + basePriceDecimal + baseCurrency are required.` },
        { status: 400 },
      );
    }
    const decision = r.decision ?? "create";
    if (!VALID_DECISIONS.includes(decision)) {
      return NextResponse.json(
        { error: `Row ${r.rowNumber ?? r.sku}: decision must be one of ${VALID_DECISIONS.join(", ")}.` },
        { status: 400 },
      );
    }
    rows.push({
      rowNumber: r.rowNumber ?? 0,
      sku: r.sku.trim(),
      baseCurrency: r.baseCurrency.trim(),
      basePriceDecimal: r.basePriceDecimal.trim(),
      regionOverrides: (r.regionOverrides ?? []).map((ro) => ({
        region: ro.region.trim(),
        currency: ro.currency.trim(),
        priceDecimal: ro.priceDecimal.trim(),
      })),
      listings: (r.listings ?? []).map((l) => ({
        locale: l.locale.trim(),
        title: l.title ?? "",
        description: l.description ?? "",
      })),
      decision,
    });
  }

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const result = await executeBulkImport(jwt, {
      appId: app.id,
      packageName,
      pricingSource,
      sourceFilename: body.sourceFilename ?? null,
      rows,
      actorEmail: session.user.email ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    const message = e?.message ?? "Bulk import failed.";
    const httpStatus = typeof e?.code === "number" && e.code >= 400 && e.code < 600
      ? e.code
      : 500;
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
