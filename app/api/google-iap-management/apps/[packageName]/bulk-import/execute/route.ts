/**
 * Bulk-import execute endpoint (g1.i).
 *
 * Accepts the wizard's parsed rows + per-row decisions (already shown in
 * the preview step) and calls the bulk-import orchestrator, which fires
 * a single batchUpdate request to Google Play.
 *
 * Hub tracking: the whole handler is wrapped in try/finally so every exit
 * path — each early return below, and the success/failure of
 * `executeBulkImport` itself — closes the Hub run (opened by the wizard's
 * upload→preview transition) exactly once with the correct terminal
 * status. `tracking.status` defaults to FAILED and is only overwritten to
 * the real terminal value right before the success return; every early
 * return sets `tracking.errorMessage` to its specific reason. Mirrors the
 * Apple IAP Management execute route's fix (commits 95d9413/4ba8e6f).
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
import {
  finalizeHubTracking,
  type HubTerminalStatus,
} from "@/lib/google-iap-management/hub-tracking/tracking";
import { computeGoogleBulkImportTerminalStatus } from "@/lib/google-iap-management/hub-tracking/status-mapping";

export const dynamic = "force-dynamic";

interface ExecuteBody {
  pricingSource?: PricingSource;
  sourceFilename?: string | null;
  /** Threaded from the wizard's upload→preview Hub-tracking start call.
   *  Absent/empty means tracking never started for this batch (no-op). */
  hub_run_id?: string | null;
  rows?: Array<{
    rowNumber?: number;
    sku?: string;
    baseCurrency?: string;
    basePriceDecimal?: string;
    regionOverrides?: Array<{ region: string; currency: string; priceDecimal: string }>;
    listings?: Array<{ locale: string; title: string; description: string }>;
    decision?: RowDecision;
    // Hotfix 19 — explicit tier selection from the wizard's Preview step.
    chosenTierIdentifier?: string | null;
    defaultTierIdentifier?: string | null;
    tierCandidateCount?: number;
    /** Cycle 43: parser provenance of the row's baseCurrency. "explicit"
     *  when the Excel header was "Price (XXX)" (header-first cross-currency
     *  trigger applies); "inferred" when generic "Price"/"Default Price"/
     *  "Base Price" (value-based fallback). Legacy clients that don't
     *  send this default to "inferred" (preserves pre-Cycle-43 behavior). */
    priceHeaderSource?: "explicit" | "inferred";
  }>;
}

const VALID_PRICING_SOURCES: PricingSource[] = [
  "google_default",
  "default_template",
  "app_template",
];
const VALID_DECISIONS: RowDecision[] = ["overwrite", "skip", "create"];

/**
 * Hub-tracking lifecycle state, threaded by reference through the handler.
 * `runId` is parsed as early as the request body is available; `status`/
 * `errorMessage` default to FAILED and are only overwritten right before
 * a legitimate exit, so the `finally` block closes the Hub run correctly
 * on every early-return AND on any unforeseen exception.
 */
interface HubTrackingState {
  runId: string | null;
  status: HubTerminalStatus;
  errorMessage?: string;
}

export async function POST(
  req: Request,
  { params }: { params: { packageName: string } },
) {
  const tracking: HubTrackingState = { runId: null, status: "FAILED" };
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      tracking.errorMessage = "Unauthorized";
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const accounts = await listAccounts().catch(() => []);
    const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
    if (!accountId) {
      tracking.errorMessage =
        "No Google Console accounts configured. Add one in Settings → Google Console Accounts first.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    const packageName = decodeURIComponent(params.packageName);
    const app = await getAppByPackage(accountId, packageName);
    if (!app) {
      tracking.errorMessage = `App "${packageName}" is not cached. Refresh the apps list first.`;
      return NextResponse.json({ error: tracking.errorMessage }, { status: 404 });
    }

    let body: ExecuteBody;
    try {
      body = (await req.json()) as ExecuteBody;
    } catch {
      tracking.errorMessage = "Invalid JSON body.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    // Parsed as early as the body is available — independent of the rest
    // of the payload's validity below.
    tracking.runId =
      typeof body.hub_run_id === "string" && body.hub_run_id.length > 0
        ? body.hub_run_id
        : null;

    const pricingSource = body.pricingSource;
    if (!pricingSource || !VALID_PRICING_SOURCES.includes(pricingSource)) {
      tracking.errorMessage = `pricingSource must be one of ${VALID_PRICING_SOURCES.join(", ")}.`;
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      tracking.errorMessage = "rows is required.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    const rows: BulkImportRow[] = [];
    for (const r of body.rows) {
      if (!r.sku || !r.basePriceDecimal || !r.baseCurrency) {
        tracking.errorMessage = `Row ${r.rowNumber ?? "?"}: sku + basePriceDecimal + baseCurrency are required.`;
        return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
      }
      const decision = r.decision ?? "create";
      if (!VALID_DECISIONS.includes(decision)) {
        tracking.errorMessage = `Row ${r.rowNumber ?? r.sku}: decision must be one of ${VALID_DECISIONS.join(", ")}.`;
        return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
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
        // Hotfix 19 — forward tier selection metadata verbatim. Null when
        // the wizard didn't compute candidates (google_default path or
        // older client). Orchestrator handles all combinations.
        chosenTierIdentifier:
          typeof r.chosenTierIdentifier === "string" && r.chosenTierIdentifier.length > 0
            ? r.chosenTierIdentifier
            : null,
        defaultTierIdentifier:
          typeof r.defaultTierIdentifier === "string" && r.defaultTierIdentifier.length > 0
            ? r.defaultTierIdentifier
            : null,
        tierCandidateCount: typeof r.tierCandidateCount === "number" ? r.tierCandidateCount : 0,
        // Cycle 43 header-first cross-currency trigger needs the parser's
        // provenance. Default "inferred" for legacy clients (pre-Cycle-43
        // wizard) so detection falls back to the value-based path.
        priceHeaderSource:
          r.priceHeaderSource === "explicit" ? "explicit" : "inferred",
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
        // Cycle 43 cross-currency resolution needs the app's default
        // currency to pick the matching entry from a template tier
        // (e.g. the tier's VND entry when the app's default currency is
        // VND). Null is tolerated by the orchestrator — cross-currency
        // rows then refuse with the google_default message.
        appDefaultCurrency: app.default_currency,
      });

      // ── Hub-tracking terminal status (SUCCESS/FAILED/PARTIAL) ──────────
      // rowsRefused (cross-currency fail-soft) folds into "skipped" —
      // neither a success nor a Google-side failure.
      const succeeded = result.rowsCreated + result.rowsOverwritten;
      const terminal = computeGoogleBulkImportTerminalStatus({
        total: result.rowsTotal,
        succeeded,
        failed: result.rowsFailed,
      });
      tracking.status = terminal.status;
      tracking.errorMessage = terminal.errorMessage;

      return NextResponse.json(result);
    } catch (err) {
      const e = err as { code?: number; status?: number; message?: string };
      const message = e?.message ?? "Bulk import failed.";
      tracking.errorMessage = message;
      const httpStatus = typeof e?.code === "number" && e.code >= 400 && e.code < 600
        ? e.code
        : 500;
      return NextResponse.json({ error: message }, { status: httpStatus });
    }
  } finally {
    await finalizeHubTracking(tracking.runId, tracking.status, tracking.errorMessage);
  }
}
