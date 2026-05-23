/**
 * Bulk-import preview endpoint (g1.i).
 *
 * Accepts a multipart-form Excel upload, parses it via the IAP template
 * parser, looks up which SKUs already exist in cache, and returns a
 * structured preview the wizard can render. Does NOT call Google.
 *
 * Hotfix 19: when the Manager selected a template-based pricing source
 * (default_template / app_template), per-row candidate-tier metadata is
 * surfaced inline. The wizard's Preview step uses these to render the
 * Tier column: 0 candidates → "Auto-converted from USD", 1 → read-only
 * tier display, >1 → dropdown with primary tier pre-selected.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { listIapsForApp } from "@/lib/google-iap-management/repository/iaps";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { parseIapTemplate } from "@/lib/google-iap-management/parsers/excel-parser";
import { decimalToMicros } from "@/lib/google-iap-management/google/price-conversion";
import {
  findRowCandidates,
  getPrimaryTierFromCandidates,
  type TierCandidate,
} from "@/lib/google-iap-management/queries/templates";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { withConcurrency } from "@/lib/iap-management/concurrency";

type PricingSource = "google_default" | "default_template" | "app_template";
const VALID_PRICING_SOURCES: PricingSource[] = [
  "google_default",
  "default_template",
  "app_template",
];
const CANDIDATE_LOOKUP_CONCURRENCY = 5;

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "'file' field is required." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes); cap is ${MAX_BYTES}.` },
      { status: 413 },
    );
  }

  // Hotfix 19: pricingSource arrives alongside the file so the API can
  // pre-compute per-row tier candidates. Optional — wizard sends it from
  // Step 1; falls back to "google_default" for older clients.
  const rawPricingSource = form.get("pricingSource");
  const pricingSource: PricingSource = (() => {
    if (typeof rawPricingSource === "string" && (VALID_PRICING_SOURCES as string[]).includes(rawPricingSource)) {
      return rawPricingSource as PricingSource;
    }
    return "google_default";
  })();

  const buffer = Buffer.from(await file.arrayBuffer());
  // Hotfix 16: thread the app's default currency so the parser can
  // resolve generic "Price" / "Default Price" / "Base Price" headers to
  // the right currency. Falls back to USD when the app row never had a
  // default_currency cached (pre-Hotfix-4 row).
  const parsed = parseIapTemplate(buffer, {
    appDefaultCurrency: app.default_currency ?? "USD",
  });
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { errors: parsed.errors, warnings: parsed.warnings },
      { status: 422 },
    );
  }

  const existing = await listIapsForApp(app.id).catch(() => []);
  const existingSkus = new Set(existing.map((i) => i.sku));

  // Hotfix 19: per-row candidate lookup. Skipped when pricingSource is
  // google_default — that path bypasses template lookup entirely, so
  // every row renders "Auto-converted from USD" client-side.
  type RowCandidateData = {
    candidates: TierCandidate[];
    defaultTierSelection: string | null;
    matchedBy: "sku" | "currency_price" | "none";
  };
  let candidateLookupError: string | null = null;
  const candidateData: RowCandidateData[] =
    pricingSource === "google_default"
      ? parsed.rows.map(() => ({
          candidates: [],
          defaultTierSelection: null,
          matchedBy: "none" as const,
        }))
      : await withConcurrency(
          parsed.rows,
          CANDIDATE_LOOKUP_CONCURRENCY,
          async (row): Promise<RowCandidateData> => {
            try {
              const baseMicros = decimalToMicros(
                row.basePriceDecimal,
                row.baseCurrency,
              );
              const result = await findRowCandidates({
                scope: pricingSource === "app_template" ? "APP" : "GLOBAL",
                appId:
                  pricingSource === "app_template" ? app.id : null,
                sku: row.sku,
                currencyCode: row.baseCurrency,
                priceMicros: baseMicros,
              });
              return {
                candidates: result.candidates,
                defaultTierSelection: getPrimaryTierFromCandidates(
                  result.candidates,
                ),
                matchedBy: result.matchedBy,
              };
            } catch (err) {
              // Capture-don't-throw — one bad row shouldn't 500 the
              // whole preview. The client surfaces the warning; orchestrator
              // re-runs the lookup at execute time and may succeed or
              // throw a clearer error then.
              candidateLookupError =
                err instanceof Error ? err.message : String(err);
              console.warn(
                `[google-iap:bulk-import:preview] candidate lookup failed sku=${row.sku} err="${candidateLookupError}"`,
              );
              return {
                candidates: [],
                defaultTierSelection: null,
                matchedBy: "none",
              };
            }
          },
        );

  const rows = parsed.rows.map((row, i) => ({
    ...row,
    exists: existingSkus.has(row.sku),
    tierCandidates: candidateData[i].candidates,
    defaultTierSelection: candidateData[i].defaultTierSelection,
    tierMatchedBy: candidateData[i].matchedBy,
  }));

  const ambiguousCount = rows.filter((r) => r.tierCandidates.length > 1).length;
  const warningsOut = [...parsed.warnings];
  if (candidateLookupError) {
    warningsOut.push(
      `Tier candidate lookup failed for one or more rows (${candidateLookupError}); affected rows will fall through to auto-bootstrap at push time.`,
    );
  }

  return NextResponse.json({
    filename: file.name,
    pricingSource,
    rows,
    warnings: warningsOut,
    counts: {
      total: rows.length,
      existing: rows.filter((r) => r.exists).length,
      new: rows.filter((r) => !r.exists).length,
      ambiguous: ambiguousCount,
    },
  });
}
