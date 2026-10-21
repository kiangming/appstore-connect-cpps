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
 *
 * ⚠ THIS MUST STAY A ROUTE HANDLER — DO NOT CONVERT IT TO A SERVER ACTION.
 * Next.js applies a 1 MB default body limit to Server Actions
 * (`next/dist/server/app-render/action-handler.js` —
 * `serverActions?.bodySizeLimit ?? "1 MB"`); App Router route handlers have
 * no body limit at all. The workspace convention of "user-initiated
 * mutations are Server Actions" therefore does NOT apply here. Measured
 * (design-bulk-import-custom-prices.md §3): a 100-row batch with per-item
 * custom prices serializes to 0.96–1.07 MB — right ON that boundary — so
 * the conversion would start failing custom-heavy batches at ~95 rows with
 * an opaque error. Enforced by a static test in route.test.ts, because a
 * comment alone has already failed this codebase once (the
 * listInAppPurchases docstring warned about the exact bug that was later
 * re-introduced).
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
  bulkImportGateRefusal,
  readBulkImportGate,
} from "@/lib/google-iap-management/bulk-import-mirror-gate";
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
import { MAX_DROPPED_ROWS, PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";
import {
  describeGoogleError,
  GoogleDualPathError,
} from "@/lib/google-iap-management/google/google-error-descriptor";

export const dynamic = "force-dynamic";

interface ExecuteBody {
  pricingSource?: PricingSource;
  sourceFilename?: string | null;
  /** Threaded from the wizard's upload→preview Hub-tracking start call.
   *  Absent/empty means tracking never started for this batch (no-op). */
  hub_run_id?: string | null;
  /** H4.3 — must equal PRICING_RULE; see the check below. */
  pricing_rule?: string;
  /** H4.3 — rows the preview refused that the Manager left out ("push the
   *  rest"). Never sent; counted (Done, audit, Hub). */
  droppedRows?: Array<{ rowNumber?: number; sku?: string; reason?: string }>;
  /** H4.4 — the file's price header as the preview read it (audit only). */
  priceHeader?: string | null;
  /** [GOOGLE-bulkimport-drop-gt] (Manager Q5) — rows of the file with data in
   *  the retired GT columns, as the preview counted them (audit only). */
  gtRowsWithData?: number | null;
  rows?: Array<{
    rowNumber?: number;
    sku?: string;
    baseCurrency?: string;
    basePriceDecimal?: string;
    /** REFUSED when non-empty — see the check below. Only a tab built before
     *  [GOOGLE-bulkimport-drop-gt] or a direct POST sends it. */
    regionOverrides?: unknown;
    listings?: Array<{ locale: string; title: string; description: string }>;
    decision?: RowDecision;
    // Hotfix 19 — explicit tier selection from the wizard's Preview step.
    chosenTierIdentifier?: string | null;
    defaultTierIdentifier?: string | null;
    tierCandidateCount?: number;
    /** Phase 3 — per-item custom prices. Sent under every pricing source,
     *  on non-skipped rows; see the validation below. */
    customPrices?: {
      entries?: Array<{ region?: string; currency?: string; priceDecimal?: string }>;
      baselineTier?: string | null;
      editedAt?: string | null;
    } | null;
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

    // THE bulk-import gate (D0) — same gate as preview (P1/P14: a guard
    // on the read surface alone leaves the WRITE open — a tab previewed before
    // this deploy, or a direct POST, would still push its plan). Placed AFTER
    // runId so the Hub run this request belongs to is closed.
    const gate = await readBulkImportGate(app.id);
    if (gate.kind !== "ok") {
      const refusal = bulkImportGateRefusal(gate, packageName);
      tracking.errorMessage = refusal.message;
      return NextResponse.json(refusal.body, { status: refusal.status });
    }

    // H4.3 — a request built under an older rule cannot be trusted to be
    // priced from the file's price column alone (PRICING_RULE: v1 read a bare
    // "Price" header as the APP's currency before H4; before v2 each row
    // carried its GT as a price). Its rows do not say so. Refuse the whole
    // request, before anything is written, and say how to fix it.
    if (body.pricing_rule !== PRICING_RULE) {
      // ⚠ "Reload": the stale tab runs the OLD wizard code — uploading again
      // in the same tab would build the same old body and get this again.
      tracking.errorMessage =
        "The tool was updated since this page was opened: this preview was made with an older version, which " +
        "priced rows differently (the app's currency, or the GT Price column). Nothing was sent. Reload this " +
        "page, then upload the file and run Preview again.";
      return NextResponse.json(
        { error: tracking.errorMessage, code: "PREVIEW_OUTDATED" },
        { status: 409 },
      );
    }

    const pricingSource = body.pricingSource;
    if (!pricingSource || !VALID_PRICING_SOURCES.includes(pricingSource)) {
      tracking.errorMessage = `pricingSource must be one of ${VALID_PRICING_SOURCES.join(", ")}.`;
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      tracking.errorMessage = "rows is required.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    // Malformed STRUCTURE is a 400 (no wizard sends it); a bad PRICE is a
    // per-row refusal in the orchestrator (Q9 — one refusal path).
    const isStr = (v: unknown): v is string => typeof v === "string";
    const rows: BulkImportRow[] = [];
    for (const r of body.rows) {
      // [GOOGLE-bulkimport-drop-gt] (Manager Q4, 2026-10-21) — a country's own
      // price comes only from a pricing-template tier or a custom set, both
      // resolved server-side. A client-sent override is the retired GT (a tab
      // built before PRICING_RULE v2, or a direct POST), which the server used
      // to post as that country's price. The whole request is refused, before
      // anything is sent — never dropped silently. An empty list is accepted.
      if (r.regionOverrides !== undefined && r.regionOverrides !== null && !(Array.isArray(r.regionOverrides) && r.regionOverrides.length === 0)) {
        tracking.errorMessage =
          `Row ${r.rowNumber ?? "?"}: regionOverrides is not accepted — a country's own price comes only from a ` +
          "pricing-template tier or Custom prices (GT Price / GT Currency are no longer used). Nothing was sent.";
        return NextResponse.json({ error: tracking.errorMessage, code: "REGION_OVERRIDES_REFUSED" }, { status: 400 });
      }
      if (
        !Array.isArray(r.listings ?? []) ||
        !(r.listings ?? []).every((l) => l && isStr(l.locale) && isStr(l.title ?? "") && isStr(l.description ?? ""))
      ) {
        tracking.errorMessage = `Row ${r.rowNumber ?? "?"}: listings are malformed.`;
        return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
      }
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
        // Filled server-side only: the custom pre-pass / the tier loop.
        regionOverrides: [],
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
        // Phase 3 — parsed below; the PRICES are checked in the orchestrator.
        customPrices: null,
      });

      // ── Custom prices: structure here, PRICES in the orchestrator ───────
      // Client state is UNTRUSTED. H4.3 (Q9): the price rules — the same
      // statedPriceOf the dialog gates Save with — run in the orchestrator's
      // custom pre-pass, the one server re-check. Here: only that each entry
      // HAS a country, a currency and an amount.
      if (r.customPrices) {
        // Custom prices are valid under EVERY source, including Google
        // Conversion. There the clobber that motivated the original
        // restriction cannot occur — the template-resolution loop is
        // gated on `pricingSource !== "google_default"`, so
        // regionOverrides flows straight through to buildProduct. Under
        // Google Conversion the set is a sparse overlay on the base
        // price: the countries it lists get its prices, every other
        // country Google's conversion of the file price.
        // A MALFORMED ENTRY — or an empty set — REFUSES THIS ROW ONLY; it
        // must never 400 the whole batch (one bad row cannot block 99 good
        // ones). An empty set reaches the orchestrator, which refuses it
        // ("no country prices were supplied").
        const entries = Array.isArray(r.customPrices.entries) ? r.customPrices.entries : [];
        const parsed: Array<{ region: string; currency: string; priceDecimal: string }> = [];
        let rowError: string | null = null;
        for (const e of entries) {
          const region = isStr(e?.region) ? e.region.trim().toUpperCase() : "";
          const currency = isStr(e?.currency) ? e.currency.trim().toUpperCase() : "";
          const priceDecimal = isStr(e?.priceDecimal) ? e.priceDecimal.trim() : "";
          if (!region || !currency || !priceDecimal) {
            rowError = "a custom price entry is missing its country, currency or amount.";
            break;
          }
          parsed.push({ region, currency, priceDecimal });
        }
        const target = rows[rows.length - 1];
        if (rowError) {
          // Hand the orchestrator an empty-entry set carrying the reason;
          // it refuses the row through the same channel as its own checks
          // so there is exactly one refusal path, not two.
          target.customPrices = { entries: [], baselineTier: null, editedAt: null };
          target.customPriceRefusal = {
            kind: "custom_invalid_price",
            reason: `Row ${target.rowNumber} (${target.sku}): ${rowError} Row not sent.`,
          };
        } else {
          target.customPrices = {
            entries: parsed,
            baselineTier:
              typeof r.customPrices.baselineTier === "string" && r.customPrices.baselineTier
                ? r.customPrices.baselineTier
                : null,
            editedAt:
              typeof r.customPrices.editedAt === "string" ? r.customPrices.editedAt : null,
          };
        }
      }
    }

    // ── H4.3 — rows the preview refused, left out by the Manager ─────────
    // Informational only: they can only add failures, never send anything.
    // Each rowNumber counts once: a row that is ALSO in `rows` (a direct
    // POST) is counted as the sent row (the orchestrator re-checks its
    // prices), and a repeated entry is ignored.
    const droppedIn = body.droppedRows ?? [];
    if (!Array.isArray(droppedIn) || !droppedIn.every((d) => d && typeof d.rowNumber === "number" && isStr(d.sku) && isStr(d.reason))) {
      tracking.errorMessage = "droppedRows entries must each be { rowNumber, sku, reason }.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }
    if (droppedIn.length > MAX_DROPPED_ROWS) {
      tracking.errorMessage =
        `${droppedIn.length} rows of the file cannot be imported — more than ${MAX_DROPPED_ROWS} in one push. ` +
        "Clean the file and run Preview again.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }
    const seenRowNumbers = new Set(rows.map((r) => r.rowNumber));
    const droppedRows = droppedIn
      .filter((d) => {
        if (seenRowNumbers.has(d.rowNumber as number)) return false;
        seenRowNumbers.add(d.rowNumber as number);
        return true;
      })
      .map((d) => ({
        rowNumber: d.rowNumber as number,
        sku: (d.sku as string).trim(),
        reason: (d.reason as string).trim().slice(0, 2000),
      }));

    try {
      const encrypted = await getEncryptedCredentials(accountId);
      const jwt = jwtClientFromEncrypted(encrypted);
      const result = await executeBulkImport(jwt, {
        appId: app.id,
        // G1b — account sở hữu app. `app` đến từ
        // getAppByPackage(accountId, packageName) ngay trên, nên hai giá
        // trị này khớp theo cấu trúc; lấy từ hàng app để hợp đồng
        // "Default của account SỞ HỮU" đúng ngay cả khi guard kia đổi.
        accountId: app.google_console_account_id,
        packageName,
        pricingSource,
        sourceFilename: body.sourceFilename ?? null,
        rows,
        droppedRows,
        priceHeader: isStr(body.priceHeader) ? body.priceHeader.slice(0, 100) : null,
        // Audit only — a count, never a price (Manager Q5).
        gtRowsWithData:
          typeof body.gtRowsWithData === "number" && Number.isSafeInteger(body.gtRowsWithData) && body.gtRowsWithData >= 0
            ? body.gtRowsWithData
            : null,
        actorEmail: session.user.email ?? null,
        // ⚠ H4.2: NO app currency — the file is the only price source.
      });

      // ── Hub-tracking terminal status (SUCCESS/FAILED/PARTIAL) ──────────
      // A refused row is not "skipped": a row of the file did not reach
      // Google (P5, the status principle). H4.3: counted as `rowsRefused` —
      // EVERY refusal kind (file price, conversion, tier, custom, the rows
      // dropped in the file), so a new kind can never slip out of the count.
      // `rowsTotal` includes the dropped rows ("3/2 rows failed" otherwise).
      const succeeded = result.rowsCreated + result.rowsOverwritten;
      const terminal = computeGoogleBulkImportTerminalStatus({
        total: result.rowsTotal,
        succeeded,
        // `?? 0` is not defensive noise: an orchestrator result missing
        // this field would make the sum NaN, and `NaN === 0` is false, so
        // every clean batch would close FAILED. Cheap guard against a
        // partial/legacy result object.
        failed: result.rowsFailed + (result.rowsRefused ?? 0),
      });
      tracking.status = terminal.status;
      tracking.errorMessage = terminal.errorMessage;

      return NextResponse.json(result);
    } catch (err) {
      // ⚠ FORWARD THE STRUCTURED HALF, NOT JUST THE SENTENCE. `e.message`
      // is identical across every cause of a Google 403; `errorStatus`
      // ("PERMISSION_DENIED"), `errorReasons` and `errorDetails` are what
      // tell them apart. The orchestrator has already persisted the same
      // fields to actions_log — this is the live copy, for the wizard and
      // for anyone reading the HTTP response directly.
      //
      // ⛔ Nothing here interprets the error for the Manager. The one
      // hint the UI used to be able to give would have pointed at per-app
      // permissions, which the 2026-10-12 investigation established was
      // the WRONG answer. A guess rendered as advice costs more than no
      // advice, and any future hint must branch on `errorStatus` /
      // `errorReasons`, never on the message string.
      const e = err as { code?: number; status?: number; message?: string };
      const desc = describeGoogleError(err);
      const message = e?.message ?? "Bulk import failed.";
      tracking.errorMessage = message;
      const httpStatus = typeof e?.code === "number" && e.code >= 400 && e.code < 600
        ? e.code
        : 500;
      return NextResponse.json(
        {
          error: message,
          errorFull: desc.full,
          ...(desc.status !== undefined ? { errorStatus: desc.status } : {}),
          ...(desc.httpStatus !== undefined
            ? { errorHttpStatus: desc.httpStatus }
            : {}),
          ...(desc.reasons !== undefined ? { errorReasons: desc.reasons } : {}),
          ...(desc.details !== undefined ? { errorDetails: desc.details } : {}),
          ...(err instanceof GoogleDualPathError
            ? {
                errorBothPathsFailed: true,
                errorFallback: err.fallback.message,
                errorFallbackFull: err.fallback.full,
                ...(err.fallback.status !== undefined
                  ? { errorFallbackStatus: err.fallback.status }
                  : {}),
              }
            : {}),
        },
        { status: httpStatus },
      );
    }
  } finally {
    await finalizeHubTracking(tracking.runId, tracking.status, tracking.errorMessage);
  }
}
