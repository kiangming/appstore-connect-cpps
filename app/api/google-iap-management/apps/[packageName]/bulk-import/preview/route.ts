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
 * Tier column: 0 candidates → "Auto-converted by Google", 1 → read-only
 * tier display, >1 → dropdown with primary tier pre-selected.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { listIapsForApp } from "@/lib/google-iap-management/repository/iaps";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { parseIapTemplate } from "@/lib/google-iap-management/parsers/excel-parser";
import { filePriceOf } from "@/lib/google-iap-management/orchestration/file-price";
import {
  findRowCandidates,
  type TemplateScopeRef,
  getPrimaryTierFromCandidates,
  type TierCandidate,
} from "@/lib/google-iap-management/queries/templates";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import {
  MIRROR_READ_FAILED,
  bulkImportGateRefusal,
  mirrorReadFailedMessage,
  readBulkImportGate,
} from "@/lib/google-iap-management/bulk-import-mirror-gate";

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

  // THE bulk-import gate (D0): refuse before parsing when the IAP mirror was
  // never refreshed completely (an empty mirror then means "unknown", not
  // "nothing exists"). The app's currency/language are NOT conditions (C2.1).
  const gate = await readBulkImportGate(app.id);
  if (gate.kind !== "ok") {
    const refusal = bulkImportGateRefusal(gate, packageName);
    return NextResponse.json(refusal.body, { status: refusal.status });
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
  // H4: the parser takes NO app currency — a price header without its
  // currency is refused (Q1), and nothing below reads it either (H4.2).
  const parsed = parseIapTemplate(buffer);
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { errors: parsed.errors, warnings: parsed.warnings },
      { status: 422 },
    );
  }

  // D2 — a mirror READ error is NOT "empty mirror". The old
  // `.catch(() => [])` turned it into "every row NEW" with no log and no
  // warning (measured: byte-identical to a genuinely empty mirror), and every
  // NEW row is sent as a CREATE. Refuse instead.
  let existing: Awaited<ReturnType<typeof listIapsForApp>>;
  try {
    existing = await listIapsForApp(app.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[google-iap:bulk-import:preview] mirror read failed pkg=${packageName} err="${detail.replace(/"/g, "'")}"`,
    );
    return NextResponse.json(
      { error: mirrorReadFailedMessage(detail), code: MIRROR_READ_FAILED },
      { status: 503 },
    );
  }
  const existingSkus = new Set(existing.map((i) => i.sku));

  // Per-row candidate lookup — ONE path for every row (H4.2, Manager Q2):
  // the tier named after the SKU first, then the tier whose price in the
  // FILE's currency equals the FILE's price (findRowCandidates). The app's
  // currency takes no part; there is no cross-currency branch any more.
  // Google Conversion has no template: no lookup.
  // G1b — MỘT ref cho cả route. `app` đến từ getAppByPackage(accountId, …)
  // nên account sở hữu app == accountId theo cấu trúc.
  const templateRef: TemplateScopeRef =
    pricingSource === "app_template"
      ? { scope: "APP", appId: app.id, accountId: null }
      : { scope: "ACCOUNT", accountId: app.google_console_account_id, appId: null };

  type RowCandidateData = {
    candidates: TierCandidate[];
    defaultTierSelection: string | null;
    matchedBy: "sku" | "currency_price" | "none";
  };
  const NO_CANDIDATES: RowCandidateData = { candidates: [], defaultTierSelection: null, matchedBy: "none" };
  let candidateLookupError: string | null = null;

  const candidateData: RowCandidateData[] = await withConcurrency(
    parsed.rows,
    CANDIDATE_LOOKUP_CONCURRENCY,
    async (row): Promise<RowCandidateData> => {
      if (pricingSource === "google_default") return NO_CANDIDATES;
      try {
        // The parser already refused rows whose file price is invalid.
        const filePrice = filePriceOf({ currency: row.baseCurrency, priceDecimal: row.basePriceDecimal });
        if (!filePrice.ok) throw new Error(filePrice.reason);
        const result = await findRowCandidates({
          ...templateRef,
          sku: row.sku,
          currencyCode: filePrice.currency,
          priceMicros: filePrice.priceMicros,
        });
        return {
          candidates: result.candidates,
          defaultTierSelection: getPrimaryTierFromCandidates(result.candidates),
          matchedBy: result.matchedBy,
        };
      } catch (err) {
        candidateLookupError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[google-iap:bulk-import:preview] candidate lookup failed sku=${row.sku} err="${candidateLookupError}"`,
        );
        return NO_CANDIDATES;
      }
    },
  );

  const rows = parsed.rows.map((row, i) => ({
    ...row,
    exists: existingSkus.has(row.sku),
    tierCandidates: candidateData[i].candidates,
    defaultTierSelection: candidateData[i].defaultTierSelection,
    tierMatchedBy: candidateData[i].matchedBy,
    // Every row is priced from its own file price since H4.2; the
    // cross-currency kinds the wizard still knows are no longer produced.
    resolution: { kind: "same_currency" as const },
  }));

  const ambiguousCount = rows.filter((r) => r.tierCandidates.length > 1).length;
  const warningsOut = [...parsed.warnings];
  if (candidateLookupError) {
    // H4.2 — the old text promised a per-row refusal at push time, which the
    // push path never did (BACKLOG [GOOGLE-bulk-import-db-throws-outside-try]).
    warningsOut.push(
      `Tier lookup failed for one or more rows (${candidateLookupError}); those rows show no tier here. Run the preview again before pushing.`,
    );
  }

  return NextResponse.json({
    filename: file.name,
    pricingSource,
    // D3 — when the mirror these EXISTS/NEW flags came from was last filled
    // completely. Read at the same moment as the mirror itself.
    iapsLastSyncedAt: gate.iapsLastSyncedAt,
    rows,
    // H4.1 — rows the file states but the tool cannot honour exactly (price
    // or GT price). Not in `rows`; the wizard names them and blocks Push.
    refusedRows: parsed.refusedRows,
    warnings: warningsOut,
    counts: {
      total: rows.length,
      refusedInFile: parsed.refusedRows.length,
      existing: rows.filter((r) => r.exists).length,
      new: rows.filter((r) => !r.exists).length,
      ambiguous: ambiguousCount,
    },
  });
}
