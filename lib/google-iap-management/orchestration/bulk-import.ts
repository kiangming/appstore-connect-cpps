/**
 * Bulk-import orchestrator (Q-GIAP.E + Hotfix 14 Phase 3 migration).
 *
 * Pushes the Manager's parsed Excel rows + per-row Overwrite/Skip
 * decisions to Google Play in a single round-trip via
 * `batchUpsertInAppProducts` (Hotfix 14, Monetization API). Each request
 * carries `allowMissing: true` so new SKUs are inserted and existing
 * SKUs are updated in the same call.
 *
 * Hotfix 14 — Phase 3 migration: the legacy `inappproducts.batchUpdate`
 * enforces that `defaultPrice.currency` matches the app's configured
 * currency, which rejected the Manager's Excel-with-USD bulk imports
 * against VND-configured apps with "Expecting currency VND for default
 * price but found USD instead." The new Monetization batch endpoint
 * instead expects comprehensive regional pricing per product, with
 * each region carrying its own currency — sidestepping the legacy
 * equality check.
 *
 * Per-row regions bootstrap: we call `convertRegionPrices` per row to
 * expand the Manager's base price (any currency — USD, VND, EUR…) into
 * comprehensive regional prices in their local currencies, then
 * overlay Manager-supplied region overrides on top. Concurrency-
 * bounded to avoid Google rate-limit spikes on 100-row batches.
 *
 * Post-call we resync the cache from the response (one row per
 * affected IAP) and emit a BULK_IMPORT_BATCH audit entry with the
 * counters.
 *
 * Failure modes:
 *   - batchUpdate caps at 100 requests per Google's docs. The caller
 *     surfaces an error >100 so the wizard can show it. Manager flow
 *     today rarely hits that ceiling.
 *   - Per-row failures inside batchUpdate aren't surfaced by Google
 *     as a structured per-row error array — only success responses
 *     come back. If the new-API call throws, that error bubbles here
 *     verbatim — `batchUpsertInAppProducts` has NO legacy fallback
 *     (H4.2, Manager Q8).
 *   - A row whose file price cannot be sent exactly as written is refused
 *     before anything is called (`file_price_invalid`).
 *   - A per-row regions bootstrap failure refuses a row whose file price is
 *     not in USD (`conversion_failed`, Manager Q7); a USD row is still sent,
 *     its file price being the US price.
 */
import type { JWT } from "google-auth-library";

import {
  batchUpsertInAppProducts,
  type InAppProduct,
} from "../google/publisher-client";
import { googleErrorPayload } from "../google/google-error-descriptor";
import { decimalToMicros, microsToDecimal } from "../google/price-conversion";
import { buildRegionMapFromBasePrice } from "../google/regions-helper";
import { syncIapFromGoogle } from "../repository/iaps";
import { appendAction } from "../repository/actions-log";
import { googleIapDb } from "../db";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import { PRICING_SOURCE_LABELS } from "../pricing-source-labels";
import type {
  ParsedIapRow,
  ParsedListing,
} from "../parsers/excel-parser";
import type { ParsedPricingEntry } from "../parsers/pricing-template-parser";
import {
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice,
  templateExists,
  findTemplateId,
  type TemplateScopeRef,
} from "../queries/templates";
import { filePriceOf, statedPriceOf, storedRegionPriceOf } from "./file-price";
import { describeGoogleError } from "../google/google-error-descriptor";
import { PRICING_RULE } from "../bulk-import-contract";

/** Bound on per-row convertRegionPrices fanout. Google's Publisher API
 *  doesn't publish a documented rate limit for read endpoints but bulk
 *  callers should keep concurrent in-flight to a reasonable cap.
 *  5 mirrors the Apple submit orchestrator (lib/iap-management/concurrency.ts). */
const REGIONS_BOOTSTRAP_CONCURRENCY = 5;

export type PricingSource = "google_default" | "default_template" | "app_template";
export type RowDecision = "overwrite" | "skip" | "create";

/** One country's price, in the currency Google bills it in. */
export interface RegionOverride {
  region: string;
  currency: string;
  priceDecimal: string;
}

export interface BulkImportRow extends ParsedIapRow {
  /** SERVER-SIDE carrier of the row's per-country prices: its custom set
   *  (custom pre-pass) or its matched tier's entries (template loop) —
   *  buildProduct's only source of region prices; Google converts every
   *  other country from the file price. Always EMPTY on input:
   *  [GOOGLE-bulkimport-drop-gt] (Manager Q4, 2026-10-21) — the file's GT
   *  used to arrive here and be posted as that country's price; the parser
   *  no longer reads it and the execute route refuses a client-sent one. */
  regionOverrides: RegionOverride[];
  /** Manager decision for this row. "create" = SKU not yet on Google;
   *  "overwrite" = SKU exists, push the update; "skip" = leave as-is. */
  decision: RowDecision;
  /** Hotfix 19 — wizard's explicit tier selection. The orchestrator
   *  uses this verbatim instead of running its own tier-picker. Null
   *  means "no template lookup applies" (e.g. google_default path) and
   *  the orchestrator falls through to auto-bootstrap.
   *
   *  The companion fields let the audit log classify the row's
   *  selection_path without the orchestrator re-running the lookup:
   *    - tierCandidateCount === 0           → no_candidates_auto_bootstrap
   *    - tierCandidateCount === 1           → single_match (no choice required)
   *    - tierCandidateCount  >  1 + chosen === default → default_accepted
   *    - tierCandidateCount  >  1 + chosen !== default → manager_explicit */
  chosenTierIdentifier?: string | null;
  defaultTierIdentifier?: string | null;
  tierCandidateCount?: number;
  /** A price refusal — per-row fail-soft: excluded from the batch,
   *  audit-logged, returned in `refusedRows`. Never replaced by another price.
   *   - `file_price_invalid` (H4.2): the price the FILE states cannot be
   *     sent exactly (filePriceOf refused it);
   *   - `conversion_failed` (H4.2, Manager Q7): Google's conversion of the
   *     file price failed, or returned no US price, and the file price is
   *     not USD;
   *   - `tier_price_invalid` (H4.3): the matched pricing-template tier holds
   *     an amount that cannot be sent (wrong precision, 0) — it used to
   *     throw the whole batch;
   *   - `price_build_failed` (H4.3): building the row's prices threw anyway
   *     — a guard, so no price can ever 500 the batch; its own kind so it
   *     can never stand in for one of the checks above. */
  priceRefusal?: {
    reason: string;
    kind: "file_price_invalid" | "conversion_failed" | "tier_price_invalid" | "price_build_failed";
  } | null;
  /** Per-item custom prices (Phase 3). ABSOLUTE per-country amounts the
   *  Manager typed in the Preview step's dialog — independent of the batch
   *  template. Sent under EVERY pricing source on non-skipped rows; the
   *  execute route checks their STRUCTURE, the custom pre-pass below checks
   *  their PRICES (statedPriceOf — H4.3, the one server re-check).
   *
   *  Presence of this field makes the row skip the template-resolution
   *  loop (see the guard below) — that is what stops the template from
   *  overwriting these values. */
  customPrices?: {
    entries: RegionOverride[];
    baselineTier: string | null;
    /** ISO timestamp stamped when the dialog saved — audit provenance. */
    editedAt?: string | null;
  } | null;
  /** Custom-price refusal — the row carried a custom set that could not be
   *  applied. Per-row fail-soft, same channel as priceRefusal: the
   *  row is excluded from the batch, audit-logged and returned in
   *  `refusedRows`. It NEVER falls through to the template price. */
  customPriceRefusal?: {
    reason: string;
    kind: "custom_invalid_price";
  } | null;
}

export interface BulkImportInput {
  appId: string;
  /** G1b — account SỞ HỮU app này. Route execute đã đọc sẵn
   *  (bulk-import/execute/route.ts:127) rồi mới `getAppByPackage(accountId,
   *  packageName)`, nên app và account ở đây luôn khớp nhau theo cấu
   *  trúc. Orchestrator KHÔNG tự đi lấy account — nó nhận từ tầng biết. */
  accountId: string;
  packageName: string;
  pricingSource: PricingSource;
  sourceFilename: string | null;
  rows: BulkImportRow[];
  /** H4.3 — rows of the file the preview refused, which the Manager chose
   *  to leave out ("push the rest"). Never sent; recorded so the batch,
   *  the audit, the Done report and the Hub status all count them (P5 — a
   *  partial import must not close SUCCESS). The route dedupes them
   *  against `rows`. */
  droppedRows?: Array<{ rowNumber: number; sku: string; reason: string }>;
  /** H4.4 — the file's price header as the preview read it. Audit only. */
  priceHeader?: string | null;
  /** [GOOGLE-bulkimport-drop-gt] (Manager Q5) — rows of the file with data in
   *  the retired GT columns, as the preview counted them; null = the file had
   *  no GT column. Audit only: how often the preview's GT notice was shown.
   *  Never a price — GT values never reach the server. */
  gtRowsWithData?: number | null;
  actorEmail: string | null;
  // ⚠ H4 (Manager 2026-10-16): NO app currency. The currency written in the
  //   file is the only price source; this input type deliberately has no
  //   field for it (re-adding one is a compile-visible change, and the
  //   structural T2 test bans it on the pricing path).
}

export interface BulkImportResult {
  batchId: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
  /** EVERY row of the file that was not written, other than a Manager Skip
   *  or a Google-side failure: price refusals, custom refusals and the rows
   *  dropped in the file (H4.3). = `refusedRows.length`. The Hub terminal
   *  status counts it as failed (status principle, P5). */
  rowsRefused: number;
  /** Price refusals (`file_price_invalid`, `conversion_failed`,
   *  `tier_price_invalid`, `price_build_failed`) — audit breakdown. */
  priceRefusedRows: number;
  /** H4.3 — rows refused in the file and left out by the Manager. */
  droppedRows: number;
  /** Rows whose prices came from a per-item custom set (Phase 3). */
  customPricedRows: number;
  /** Custom rows REFUSED — audit breakdown; included in `rowsRefused`, which
   *  the Hub terminal status counts as failed (Q5 / P5). */
  customRefusedRows: number;
  /** Refused rows surfaced for caller display — each carries its SKU
   *  and the human-readable reason. Order matches input order for
   *  affected rows. */
  refusedRows: Array<{
    sku: string;
    rowNumber: number;
    reason: string;
    kind: string;
  }>;
  durationMs: number;
}

const BATCH_MAX = 100;

export function buildProduct(
  packageName: string,
  row: BulkImportRow,
): InAppProduct {
  const listings: NonNullable<InAppProduct["listings"]> = {};
  for (const l of row.listings as ParsedListing[]) {
    if (!l.title.trim() && !l.description.trim()) continue;
    listings[l.locale] = {
      title: l.title.trim(),
      description: l.description.trim(),
    };
  }
  // Default locale must have a title — fall back to placeholder if Manager
  // shipped an empty English row to avoid Google rejecting the entire batch.
  if (Object.keys(listings).length === 0) {
    listings["en-US"] = { title: row.sku, description: "" };
  } else if (!listings["en-US"]) {
    const firstLocale = Object.keys(listings)[0];
    listings["en-US"] = { ...listings[firstLocale] };
  }

  const prices: NonNullable<InAppProduct["prices"]> = {};
  for (const r of row.regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    prices[r.region] = {
      currency: r.currency.trim().toUpperCase(),
      // Hotfix 5: per-region currency drives precision validation.
      priceMicros: decimalToMicros(r.priceDecimal, r.currency),
    };
  }

  // H4.2 — defaultPrice is ALWAYS the file's price in the file's currency
  // (the choke point). executeBulkImport refuses a row whose file price is
  // invalid before it gets here; a direct caller with one gets a throw, never
  // a substitute price.
  const filePrice = filePriceOf({ currency: row.baseCurrency, priceDecimal: row.basePriceDecimal });
  if (!filePrice.ok) {
    throw new Error(`buildProduct: row ${row.rowNumber} (${row.sku}) — ${filePrice.reason}`);
  }
  const defaultPrice = { currency: filePrice.currency, priceMicros: filePrice.priceMicros };

  return {
    packageName,
    sku: row.sku,
    status: "active",
    purchaseType: "managedUser",
    defaultLanguage: "en-US",
    defaultPrice,
    listings,
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
  };
}

/** H4.3 — what a failed conversion was. Manager 2026-10-19: the reason must
 *  say "temporary — run this row again later", so a failed conversion is
 *  not mistaken for bad data. Three classes, each named for what it is (P5):
 *   - "temporary": 5xx, 408, 429, a network error, or an error with no HTTP
 *     status — the Manager's wording;
 *   - "price": Google answered 400 INVALID_ARGUMENT — it says the request
 *     (the price) is invalid; retrying cannot help;
 *   - "access": any other 4xx (401, 403 PERMISSION_DENIED, 404, a token 400
 *     such as invalid_grant) — an access / account / app problem, NOT the
 *     row's data; telling the Manager to check the price would hide it
 *     (the 2026-10-12 403 incident class). */
type ConversionFailure = { kind: "temporary" | "price" | "access"; detail: string };

function classifyConversionFailure(err: unknown): ConversionFailure {
  const d = describeGoogleError(err);
  const code = (err as { code?: unknown } | null)?.code;
  const network = typeof code === "string" && /^E[A-Z0-9_]+$/.test(code);
  const s = d.httpStatus;
  const kind: ConversionFailure["kind"] =
    s === undefined || s >= 500 || s === 408 || s === 429
      ? "temporary"
      : s === 400 && d.status === "INVALID_ARGUMENT"
        ? "price"
        : s >= 400 && s < 500
          ? "access"
          : "temporary";
  const detail =
    s !== undefined
      ? `HTTP ${s}${d.status ? ` ${d.status}` : ""}: ${d.message}`
      : network
        ? `${code as string}: ${d.message}`
        : d.message;
  return { kind, detail };
}

function conversionFailedReason(
  row: BulkImportRow,
  fileCurrency: string,
  failure: ConversionFailure | undefined,
): string {
  const head = `Row ${row.rowNumber} (${row.sku}):`;
  const rule = "A row whose price is not in USD is not sent without Google's conversion.";
  if (!failure || failure.kind === "temporary") {
    return (
      `${head} Google's price conversion failed temporarily${failure ? ` (${failure.detail})` : ""} — ` +
      `this is not a problem with the row's data: run this row again later. ${rule} Row not sent.`
    );
  }
  if (failure.kind === "price") {
    return (
      `${head} Google rejected the file price ${fileCurrency} ${row.basePriceDecimal} as invalid (${failure.detail}). ` +
      `This is not a temporary failure — check the price. ${rule} Row not sent.`
    );
  }
  return (
    `${head} Google refused the conversion request (${failure.detail}) — an access, account or app problem, ` +
    `not the row's data, and not temporary: fix the access, then run this row again. ${rule} Row not sent.`
  );
}

export async function executeBulkImport(
  jwt: JWT,
  input: BulkImportInput,
): Promise<BulkImportResult> {
  const t0 = Date.now();
  const db = googleIapDb();

  // Insert import_batches row up front for audit linkage.
  const { data: batchRow, error: batchErr } = await db
    .from("import_batches")
    .insert({
      app_id: input.appId,
      source_filename: input.sourceFilename,
      pricing_source: input.pricingSource,
      // H4.3: the rows the Manager left out are rows of the file too.
      rows_total: input.rows.length + (input.droppedRows?.length ?? 0),
      status: "IN_PROGRESS",
    })
    .select("id")
    .single();

  if (batchErr || !batchRow) {
    throw new Error(
      `Failed to create import batch row: ${batchErr?.message ?? "unknown"}`,
    );
  }
  const batchId = (batchRow as { id: string }).id;

  // KB P10 — finalize-in-finally (Manager 2026-10-19). From here on the
  // batch row MUST end in a terminal state, whatever throws — a DB / network
  // error in a template lookup, a drifted tier, more than BATCH_MAX rows.
  // Every legitimate exit closes it through finalizeImportBatch; anything
  // that escapes without doing so is closed FAILED here. Before this, those
  // exits left import_batches IN_PROGRESS for good.
  const batch: BatchTracker = { db, batchId, finalized: false };
  let cause: unknown = null;
  try {
    return await runBulkImport(jwt, input, t0, batch);
  } catch (err) {
    cause = err;
    throw err;
  } finally {
    if (!batch.finalized) {
      const skipped = input.rows.filter((r) => r.decision === "skip").length;
      const total = input.rows.length + (input.droppedRows?.length ?? 0);
      const why = cause === null ? "no error captured" : describeGoogleError(cause).message;
      console.error(
        `[google-iap:bulk-import] batch=${batchId} ended by a throw before it was closed — closing it FAILED (finally) err="${why.replace(/"/g, "'")}"`,
      );
      await finalizeImportBatch(batch, {
        status: "FAILED",
        rows_success: 0,
        rows_skipped: skipped,
        // Nothing was written: the throw sites are all before the push.
        rows_failed: total - skipped,
        executed_at: new Date().toISOString(),
      });
      // The batch still gets its audit row — with the rule it ran under and
      // the cause (design §5.4 item 8: every batch records pricing_rule).
      await appendAction({
        actionType: "BULK_IMPORT_BATCH",
        actorEmail: input.actorEmail,
        targetId: input.appId,
        payload: {
          batch_id: batchId,
          package_name: input.packageName,
          pricing_source: input.pricingSource,
          pricing_rule: PRICING_RULE,
          price_header: input.priceHeader ?? null,
          gt_rows_with_data: input.gtRowsWithData ?? null,
          rows_total: total,
          rows_skipped: skipped,
          rows_failed: total - skipped,
          closed_by: "finally",
          ...(cause === null ? {} : googleErrorPayload(cause)),
          duration_ms: Date.now() - t0,
        },
      });
    }
  }
}

/** The import_batches row being run, and whether it has been closed. */
type BatchTracker = { db: ReturnType<typeof googleIapDb>; batchId: string; finalized: boolean };

/**
 * THE one way an import_batches row is closed (KB P10 + P2). Marks the batch
 * finalized BEFORE writing — an attempted close is never overwritten by the
 * finally's FAILED (that would misreport a batch that did complete) — and
 * checks the write's `error`: a refused / failed update is logged, never
 * silent. Never throws.
 */
async function finalizeImportBatch(batch: BatchTracker, patch: Record<string, unknown>): Promise<void> {
  batch.finalized = true;
  try {
    const { error } = await batch.db.from("import_batches").update(patch).eq("id", batch.batchId);
    if (error) {
      console.error(
        `[google-iap:bulk-import] import_batches close FAILED batch=${batch.batchId} status=${String(patch.status)} err="${error.message}"`,
      );
    }
  } catch (err) {
    console.error(
      `[google-iap:bulk-import] import_batches close THREW batch=${batch.batchId} status=${String(patch.status)} err="${
        err instanceof Error ? err.message : String(err)
      }"`,
    );
  }
}

async function runBulkImport(
  jwt: JWT,
  input: BulkImportInput,
  t0: number,
  batch: BatchTracker,
): Promise<BulkImportResult> {
  const { batchId } = batch;
  // [GOOGLE-bulkimport-drop-gt] (Manager Q4) — a row's region prices are set
  // HERE (custom pre-pass, template loop), never handed in: the execute route
  // refuses client-sent ones. A caller that hands some in is a programming
  // error — thrown before anything is sent (the finally closes the batch
  // FAILED), never posted as a price. Twin of the route's check.
  const handedIn = input.rows.find((r) => r.regionOverrides.length > 0);
  if (handedIn) {
    throw new Error(
      `executeBulkImport: row ${handedIn.rowNumber} (${handedIn.sku}) came with regionOverrides — a row's region prices come only from its custom set or its matched tier.`,
    );
  }
  const actionableRows = input.rows.filter((r) => r.decision !== "skip");
  const skippedCount = input.rows.length - actionableRows.length;

  // ── H4.2 file-price pre-pass — the FILE is the only price source ───────
  //
  // Every actionable row's price goes through the ONE choke point
  // (file-price.ts) before anything else. A price that cannot be sent
  // exactly as the file states it refuses THE ROW (per-row fail-soft) — it never crashes the batch (decimalToMicros used to throw
  // outside any try) and is never replaced by another price. The app
  // currency takes no part: there is no cross-currency branch any more.
  let priceRefusedRows = 0;
  for (const row of actionableRows) {
    const base = filePriceOf({ currency: row.baseCurrency, priceDecimal: row.basePriceDecimal });
    if (!base.ok) {
      row.priceRefusal = {
        kind: "file_price_invalid",
        reason: `Row ${row.rowNumber} (${row.sku}): price "${row.basePriceDecimal}" ${row.baseCurrency} — ${base.reason} Row not sent.`,
      };
      priceRefusedRows += 1;
      console.info(`[google-iap:bulk-import] refused sku=${row.sku} kind=file_price_invalid`);
    }
  }

  // ── Custom-price pre-pass (Phase 3) ────────────────────────────────
  //
  // Custom prices are ABSOLUTE and already denominated per country: they
  // become the row's region prices and skip the template loop. H4.2 (Q6): the conversion anchor and
  // defaultPrice stay the FILE's price; a custom set needs no entry in any
  // particular currency (the app-currency requirement is gone, client and
  // server alike).
  //
  // On failure the row is REFUSED (per-row fail-soft) and excluded from
  // the batch. It must never fall through to the template price: shipping
  // a price the Manager did not choose, and reporting success for it,
  // is the exact failure this feature exists to prevent.
  let customPricedRows = 0;
  let customRefusedRows = 0;

  for (const row of actionableRows) {
    if (!row.customPrices || row.priceRefusal) continue;
    // H4.3 — the route already refused this set (a malformed entry): keep
    // ITS reason. Overwriting it with "no country prices were supplied"
    // hid the real cause (the route empties `entries` when it refuses).
    if (row.customPriceRefusal) {
      customRefusedRows += 1;
      continue;
    }
    const entries = row.customPrices.entries ?? [];

    if (entries.length === 0) {
      row.customPriceRefusal = {
        kind: "custom_invalid_price",
        reason: `Row ${row.rowNumber} (${row.sku}): custom prices were marked but no country prices were supplied. Row not sent.`,
      };
      customRefusedRows += 1;
      continue;
    }

    // H4.3 (Q9, Manager 2026-10-19) — every entry through THE rules for a
    // price a person wrote (statedPriceOf): precision against its OWN
    // currency, "26.000" in a currency without decimals refused as a
    // possible thousands separator, no 0. The SAME function the dialog
    // gates Save with — this is the server's re-check (client state is
    // untrusted), and the only one: the route checks structure only.
    // Every bad entry is named, so the Manager can fix them in one pass.
    const priced: Array<{ region: string; currency: string; priceMicros: string }> = [];
    const problems: string[] = [];
    for (const e of entries) {
      const region = e.region.trim().toUpperCase();
      const currency = e.currency.trim().toUpperCase();
      if (!region || !currency) {
        problems.push("a custom price is missing its country or currency.");
        continue;
      }
      const stated = statedPriceOf({ currency, priceDecimal: e.priceDecimal });
      if (!stated.ok) {
        problems.push(`custom price ${region} "${e.priceDecimal}" ${currency} — ${stated.reason}`);
        continue;
      }
      priced.push({ region, currency, priceMicros: stated.priceMicros });
    }
    const invalid = problems.length > 0 ? `Row ${row.rowNumber} (${row.sku}): ${problems.join(" ")} Row not sent.` : null;
    if (invalid) {
      row.customPriceRefusal = { kind: "custom_invalid_price", reason: invalid };
      customRefusedRows += 1;
      continue;
    }

    row.regionOverrides = priced.map((p) => ({
      region: p.region,
      currency: p.currency,
      priceDecimal: microsToDecimal(p.priceMicros, 6),
    }));
    customPricedRows += 1;
    console.info(
      `[google-iap:bulk-import:custom-prices] applied sku=${row.sku} source=${input.pricingSource} entries=${priced.length} default=file-price baseline_tier=${row.customPrices.baselineTier ?? "-"}`,
    );
  }

  // Q-GIAP.D + Hotfix 15 → Hotfix 19: template-driven price resolution.
  //
  // Hotfix 19 reshape: the wizard's Preview step pre-computes per-row
  // tier candidates and asks Manager to pick when >1 tier matches at
  // the same `(currency, priceMicros)`. The orchestrator now consumes
  // the Manager's explicit selection (row.chosenTierIdentifier) and
  // loads exactly that tier's entries — no silent first-match fallback
  // (the root cause Hotfix 18 instrumentation pinpointed in batch
  // 4895756e: 4 tiers priced 0.99 USD, picker returned the wrong one).
  //
  // Legacy clients that don't send chosenTierIdentifier fall back to
  // the older SKU-then-currency-price logic — but with one critical
  // difference: when currency-price returns >1 candidates, we throw
  // (rather than silently pick the first). Internal-only tool, so the
  // only realistic caller is the wizard itself.
  let templateMatchCount = 0;
  let templateMatchBySku = 0;
  let templateMatchByCurrencyPrice = 0;
  let templateNoMatchRows = 0;
  // Hotfix 19 — new selection-path counters.
  let ambiguousRows = 0;
  let managerOverrodeRows = 0;
  let defaultAcceptedRows = 0;
  let singleMatchRows = 0;
  // Hotfix 18 diagnostic context — populated whenever the batch uses
  // a template scope. Surfaced in the audit log + Railway logs so
  // Manager can correlate "matched" counters with the actual entries
  // the orchestrator applied.
  let templateIdResolved: string | null = null;
  let templateScopeUsed: "ACCOUNT" | "APP" | null = null;
  let templateAccountIdUsed: string | null = null;
  let templateAppIdUsed: string | null = null;
  type PriceProvenance = "custom" | "custom_refused" | "template" | "template_refused" | "auto_bootstrap";
  type SelectionPath =
    | "manager_explicit"
    | "default_accepted"
    | "single_match"
    | "no_candidates_auto_bootstrap";
  const perRowDiagnostic: Array<{
    row_index: number;
    sku: string;
    base_currency: string;
    base_price_decimal: string;
    candidate_count: number;
    default_tier_offered: string | null;
    selected_tier: string | null;
    selection_path: SelectionPath;
    // Backward-compat fields for SQL queries written against pre-H19 audit shape.
    match_strategy: "sku" | "currency_price" | "none";
    entries_count: number;
    vn_currency: string | null;
    vn_price_decimal: string | null;
    // Phase 3 — per-item price provenance. Without this nobody can
    // reconstruct WHY an item got its price: the batch-level
    // `pricing_source` is no longer the whole truth once individual rows
    // can opt out of the template.
    price_provenance?: PriceProvenance;
    custom_entry_count?: number | null;
    custom_baseline_tier?: string | null;
    custom_blank_regions?: number | null;
    custom_edited_at?: string | null;
  }> = [];

  // Emitted for every actionable row with a custom set — including refused
  // ones, so the audit shows the attempt and its reason, not just silence.
  for (let i = 0; i < actionableRows.length; i += 1) {
    const row = actionableRows[i];
    if (!row.customPrices) continue;
    perRowDiagnostic.push({
      row_index: i,
      sku: row.sku,
      base_currency: row.baseCurrency,
      base_price_decimal: row.basePriceDecimal,
      candidate_count: row.tierCandidateCount ?? 0,
      default_tier_offered: row.defaultTierIdentifier ?? null,
      // A custom row has no selected tier — that is the point of it.
      selected_tier: null,
      selection_path: "no_candidates_auto_bootstrap",
      match_strategy: "none",
      entries_count: row.customPrices.entries.length,
      vn_currency:
        row.regionOverrides.find((r) => r.region === "VN")?.currency ?? null,
      vn_price_decimal:
        row.regionOverrides.find((r) => r.region === "VN")?.priceDecimal ?? null,
      price_provenance: row.customPriceRefusal ? "custom_refused" : "custom",
      custom_entry_count: row.customPrices.entries.length,
      custom_baseline_tier: row.customPrices.baselineTier,
      // Countries the custom set does NOT cover are filled by Google's
      // conversion at push — worth recording, it explains prices the
      // Manager never typed.
      custom_blank_regions: null,
      custom_edited_at: row.customPrices.editedAt ?? null,
    });
  }

  if (input.pricingSource !== "google_default") {
    // G1b — MỘT ref duy nhất cho cả khối, thay cho việc dựng lại
    // `{scope, appId}` ở từng lời gọi. Dựng lại từng chỗ chính là chỗ để
    // quên `accountId` mà vẫn biên dịch sạch.
    const templateRef: TemplateScopeRef =
      input.pricingSource === "app_template"
        ? { scope: "APP", appId: input.appId, accountId: null }
        : { scope: "ACCOUNT", accountId: input.accountId, appId: null };
    const scope = templateRef.scope;
    const appIdForScope = templateRef.appId;
    templateScopeUsed = scope;
    templateAppIdUsed = appIdForScope;
    templateAccountIdUsed = templateRef.accountId;

    // Hotfix 17 pre-flight (preserved): refuse to silently auto-bootstrap
    // when the selected template scope has no rows.
    const exists = await templateExists(templateRef);
    if (!exists) {
      // Every name in this message must be one the operator can actually
      // SEE. It previously interpolated the raw enum (`"app_template"`,
      // `change the pricing source to "google_default"`) — strings that
      // appear nowhere in the UI — pointed at the APPLE module's nav label
      // ("Settings → Pricing Tiers"; Google's is "Pricing Templates"), and
      // identified the app by its internal UUID. Same accurate-error
      // discipline as the false NOT_FOUND wording that sent the Manager to
      // App Store Connect for nothing.
      const which =
        input.pricingSource === "app_template"
          ? `${PRICING_SOURCE_LABELS.app_template} for ${input.packageName}`
          : PRICING_SOURCE_LABELS.default_template;
      throw new Error(
        `Bulk import was set to "${PRICING_SOURCE_LABELS[input.pricingSource]}" but no ${which} has been uploaded. ` +
          `Upload one in Settings → Pricing Templates, or go back to Step 1 and pick "${PRICING_SOURCE_LABELS.google_default}".`,
      );
    }

    templateIdResolved = await findTemplateId(templateRef);
    console.info(
      `[google-iap:bulk-import] template_resolved scope=${scope} app_id=${appIdForScope ?? "-"} template_id=${templateIdResolved ?? "?"}`,
    );

    for (let rowIndex = 0; rowIndex < actionableRows.length; rowIndex += 1) {
      const row = actionableRows[rowIndex];

      // ⚠ `row.customPrices` IS THE GUARD FOR CUSTOM ROWS — applied or
      // refused. Keyed off the INTENT, not the outcome: a refused custom row
      // that fell through would get its overrides replaced by template
      // entries and a diagnostic claiming provenance "template" for a row
      // the Manager marked Custom (mutation-checked by the provenance test).
      // `row.priceRefusal` — the file price is invalid (pre-pass above).
      if (row.priceRefusal || row.customPrices) {
        continue;
      }

      // Validated by the file-price pre-pass above (refused rows skipped).
      const filePrice = filePriceOf({ currency: row.baseCurrency, priceDecimal: row.basePriceDecimal });
      if (!filePrice.ok) continue;
      const baseMicros = filePrice.priceMicros;
      let entries: ParsedPricingEntry[] = [];
      let selectionPath: SelectionPath = "no_candidates_auto_bootstrap";
      let matchStrategy: "sku" | "currency_price" | "none" = "none";
      let candidateCount = row.tierCandidateCount ?? 0;
      const defaultTierOffered = row.defaultTierIdentifier ?? null;
      let selectedTier: string | null = null;
      // H4.3 — counted only once the tier's prices pass the check below, so
      // the audit's selection counters never include a tier_price_invalid row
      // (a row refused LATER — conversion_failed, price_build_failed — is
      // still counted: the tier did match it).
      let selectionCounter: "single" | "default_accepted" | "manager_explicit" | null = null;

      if (row.chosenTierIdentifier) {
        // Wizard supplied an explicit selection — honour it verbatim.
        // No silent picker; if the tier no longer exists in the
        // template (Manager edited Settings between Preview and Push),
        // throw rather than guess.
        selectedTier = row.chosenTierIdentifier;
        entries = await lookupTemplateEntriesForIdentifier({
          ...templateRef,
          identifier: row.chosenTierIdentifier,
        });
        if (entries.length === 0) {
          throw new Error(
            `Bulk import row ${row.rowNumber} (SKU "${row.sku}") references tier ` +
              `"${row.chosenTierIdentifier}" which has no entries in the ${scope} template. ` +
              `The wizard's selection state appears to have drifted — re-run Preview and try again.`,
          );
        }
        matchStrategy =
          row.chosenTierIdentifier === row.sku ? "sku" : "currency_price";
        if (candidateCount <= 1) {
          selectionPath = "single_match";
          selectionCounter = "single";
        } else if (
          row.defaultTierIdentifier &&
          row.chosenTierIdentifier === row.defaultTierIdentifier
        ) {
          selectionPath = "default_accepted";
          selectionCounter = "default_accepted";
        } else {
          selectionPath = "manager_explicit";
          selectionCounter = "manager_explicit";
        }
      } else if (candidateCount > 0) {
        // Wizard reported candidates but no selection — should never
        // happen with the new wizard (the Push gate forces a selection
        // on every ambiguous row + seeds singletons from the primary
        // tier). Throw rather than silently fall through.
        throw new Error(
          `Bulk import row ${row.rowNumber} (SKU "${row.sku}") has ${candidateCount} candidate ` +
            `tier(s) but the wizard did not provide an explicit tier selection. ` +
            `Re-run the Bulk Import wizard.`,
        );
      } else {
        // Legacy path — wizard didn't send tier metadata (older clients
        // or direct API consumers). Fall back to SKU lookup, then to a
        // candidate probe via `findCandidateTiersForCurrencyPrice` —
        // but only accept the result when exactly 1 candidate exists.
        // Multiple candidates throws (Hotfix 19 silent-pick removal).
        const skuEntries = await lookupTemplateEntriesForIdentifier({
          ...templateRef,
          identifier: row.sku,
        });
        if (skuEntries.length > 0) {
          entries = skuEntries;
          matchStrategy = "sku";
          selectionPath = "single_match";
          selectedTier = row.sku;
          candidateCount = 1;
          selectionCounter = "single";
        } else {
          let candidates: Array<{ identifier: string }> = [];
          try {
            candidates = await findCandidateTiersForCurrencyPrice({
              ...templateRef,
              currencyCode: row.baseCurrency,
              priceMicros: baseMicros,
            });
          } catch (err) {
            console.warn(
              `[google-iap:bulk-import] candidate probe failed sku=${row.sku} err="${err instanceof Error ? err.message.replace(/"/g, "'") : String(err)}"`,
            );
          }
          if (candidates.length === 1) {
            const probeEntries = await lookupTemplateEntriesForIdentifier({
              ...templateRef,
              identifier: candidates[0].identifier,
            });
            if (probeEntries.length > 0) {
              entries = probeEntries;
              matchStrategy = "currency_price";
              selectionPath = "single_match";
              selectedTier = candidates[0].identifier;
              candidateCount = 1;
              selectionCounter = "single";
            }
          } else if (candidates.length > 1) {
            throw new Error(
              `Bulk import row ${row.rowNumber} (SKU "${row.sku}") matches ${candidates.length} template tiers ` +
                `at ${row.baseCurrency}/${row.basePriceDecimal} but no explicit tier selection was provided. ` +
                `Tiers: ${candidates.map((c) => c.identifier).join(", ")}. ` +
                `Re-run the Bulk Import wizard so you can pick a tier explicitly.`,
            );
          }
          // else: candidates.length === 0 → fall through to auto-bootstrap
        }
      }

      // H4.3 (Manager 2026-10-19) — the tier's stored amounts through the
      // same price rules (storedRegionPriceOf, on micros — "26000.000000" is
      // not a thousands separator). One bad entry (TWD 30.5, a 0) used to
      // throw in buildProduct outside any try: the WHOLE batch 500'd, the
      // valid rows were not sent, import_batches stayed IN_PROGRESS. Now
      // THIS row is refused, naming the tier and every bad entry; the batch
      // goes on. One check covers all three tier paths (chosen, SKU, probe).
      if (entries.length > 0) {
        const bad = entries
          .map((e) => ({ e, r: storedRegionPriceOf({ currency: e.currency, priceMicros: e.priceMicros }) }))
          .filter((x): x is { e: ParsedPricingEntry; r: { ok: false; reason: string } } => !x.r.ok);
        if (bad.length > 0) {
          row.priceRefusal = {
            kind: "tier_price_invalid",
            reason:
              `Row ${row.rowNumber} (${row.sku}): pricing-template tier "${selectedTier ?? "?"}" holds a price that cannot be sent — ` +
              bad.map((x) => `${x.e.regionCode} ${x.e.currency}: ${x.r.reason}`).join(" ") +
              ` Fix the tier in Settings → Pricing Templates, then import this row again. Row not sent.`,
          };
          priceRefusedRows += 1;
          console.info(`[google-iap:bulk-import] refused sku=${row.sku} kind=tier_price_invalid tier=${selectedTier ?? "?"}`);
          perRowDiagnostic.push({
            row_index: rowIndex,
            sku: row.sku,
            base_currency: row.baseCurrency,
            base_price_decimal: row.basePriceDecimal,
            candidate_count: candidateCount,
            default_tier_offered: defaultTierOffered,
            selected_tier: selectedTier,
            selection_path: selectionPath,
            match_strategy: matchStrategy,
            entries_count: entries.length,
            vn_currency: null,
            vn_price_decimal: null,
            price_provenance: "template_refused",
          });
          continue;
        }
        if (selectionCounter === "single") singleMatchRows += 1;
        else if (selectionCounter === "default_accepted") {
          defaultAcceptedRows += 1;
          ambiguousRows += 1;
        } else if (selectionCounter === "manager_explicit") {
          managerOverrodeRows += 1;
          ambiguousRows += 1;
        }
        row.regionOverrides = entries.map((e) => ({
          region: e.regionCode,
          currency: e.currency,
          priceDecimal: microsToDecimal(e.priceMicros, 6),
        }));
        templateMatchCount += 1;
        if (matchStrategy === "sku") templateMatchBySku += 1;
        else if (matchStrategy === "currency_price")
          templateMatchByCurrencyPrice += 1;

        const vnEntry = row.regionOverrides.find((r) => r.region === "VN");
        perRowDiagnostic.push({
          row_index: rowIndex,
          sku: row.sku,
          base_currency: row.baseCurrency,
          base_price_decimal: row.basePriceDecimal,
          candidate_count: candidateCount,
          default_tier_offered: defaultTierOffered,
          selected_tier: selectedTier,
          selection_path: selectionPath,
          match_strategy: matchStrategy,
          entries_count: entries.length,
          vn_currency: vnEntry?.currency ?? null,
          vn_price_decimal: vnEntry?.priceDecimal ?? null,
          price_provenance: "template",
        });
        console.info(
          `[google-iap:bulk-import] template_match sku=${row.sku} path=${selectionPath} tier=${selectedTier ?? "?"} entries=${entries.length} vn=${vnEntry ? `${vnEntry.currency}/${vnEntry.priceDecimal}` : "missing"}`,
        );
      } else {
        templateNoMatchRows += 1;
        perRowDiagnostic.push({
          row_index: rowIndex,
          sku: row.sku,
          base_currency: row.baseCurrency,
          base_price_decimal: row.basePriceDecimal,
          candidate_count: candidateCount,
          default_tier_offered: defaultTierOffered,
          selected_tier: selectedTier,
          selection_path: "no_candidates_auto_bootstrap",
          match_strategy: "none",
          entries_count: 0,
          vn_currency: null,
          vn_price_decimal: null,
          price_provenance: "auto_bootstrap",
        });
      }
    }
  }

  // Rows that passed every price check so far, in input order.
  const candidateRows = actionableRows.filter((r) => !r.priceRefusal && !r.customPriceRefusal);
  if (candidateRows.length > BATCH_MAX) {
    throw new Error(
      `Bulk import exceeds Google's per-call cap (${BATCH_MAX}). ` +
        `Got ${candidateRows.length} rows after skips and refusals. Reduce the file or split into batches.`,
    );
  }

  // Hotfix 14 Phase 3: per-row regions bootstrap via convertRegionPrices.
  // Bounded concurrency keeps the pre-batch fanout from saturating
  // Google's API. Each row gets its own {regions, regionsVersion} —
  // regionsVersion threads through to the batch upsert so the resource
  // is pinned to the same catalog the conversion came from (Hotfix 9
  // pattern carries forward to the batch path).
  //
  // H4.2 — the anchor is ALWAYS the file's price in the file's currency
  // (custom rows included, Q6); no app currency, no template entry.
  //
  // ⚠ DO NOT "OPTIMISE" THIS AWAY FOR CUSTOM ROWS.
  // A custom row that covers all ~170 countries makes the merge below a
  // no-op, so skipping convertRegionPrices for it looks like free
  // latency. It is not: this call is the ONLY source of `regionsVersion`
  // (Hotfix 9 — Google moved BG from BGN to EUR in Jan 2026, and a patch
  // whose pinned catalog version disagrees with the prices is rejected).
  // Skipping it reintroduces a bug that has already been paid for once.
  type RowBootstrap = {
    regions: Array<{ region: string; currency: string; priceMicros: string }>;
    regionsVersion?: string;
    failed: boolean;
    /** H4.4 audit — the price Google was asked to convert from. */
    anchor?: { currency: string; price_micros: string };
    /** H4.3 — what the failure was, so Q7's reason says "temporary — run
     *  this row again later" only when it is (Manager 2026-10-19). */
    failure?: ConversionFailure;
  };
  const bootstraps = await withConcurrency(
    candidateRows,
    REGIONS_BOOTSTRAP_CONCURRENCY,
    async (row): Promise<RowBootstrap> => {
      // Computed before the call so the audit records the anchor Google was
      // asked to convert from even when the conversion fails.
      const anchor = filePriceOf({ currency: row.baseCurrency, priceDecimal: row.basePriceDecimal });
      const anchorAudit = anchor.ok ? { currency: anchor.currency, price_micros: anchor.priceMicros } : undefined;
      try {
        if (!anchor.ok) throw new Error(anchor.reason); // unreachable: refused above
        const result = await buildRegionMapFromBasePrice(
          jwt,
          input.packageName,
          anchor.priceMicros,
          anchor.currency,
        );
        return {
          regions: result.regions,
          regionsVersion: result.regionsVersion ?? undefined,
          failed: false,
          anchor: anchorAudit,
        };
      } catch (err) {
        console.warn(
          `[google-iap:bulk-import] regions bootstrap failed sku=${row.sku} err="${
            err instanceof Error ? err.message.replace(/"/g, "'") : String(err)
          }"`,
        );
        return { regions: [], failed: true, failure: classifyConversionFailure(err), anchor: anchorAudit };
      }
    },
  );

  // Build per-row InAppProduct. The row's own region prices — its custom set
  // or its matched tier's entries, in row.regionOverrides after the passes
  // above — win over the auto-converted catalog values: explicit intent
  // beats catalog defaults.
  const prepared: Array<{
    row: BulkImportRow;
    input: { body: InAppProduct; regionsVersion?: string; isOverwrite: boolean };
  }> = [];
  candidateRows.forEach((row, i) => {
    // H4.3 — a guard: every price was checked above, so this should never
    // throw; if it does, THIS row is refused (its own kind, so it can never
    // pass for one of the checks) and the batch goes on — no price can 500
    // the batch or leave import_batches IN_PROGRESS again.
    let product: InAppProduct;
    try {
      product = buildProduct(input.packageName, row);
    } catch (err) {
      row.priceRefusal = {
        kind: "price_build_failed",
        reason: `Row ${row.rowNumber} (${row.sku}): its prices could not be built — ${
          err instanceof Error ? err.message : String(err)
        } Row not sent.`,
      };
      priceRefusedRows += 1;
      console.error(`[google-iap:bulk-import] refused sku=${row.sku} kind=price_build_failed`);
      return;
    }
    const bootstrap = bootstraps[i];
    const existing: NonNullable<InAppProduct["prices"]> = {
      ...(product.prices ?? {}),
    };
    for (const auto of bootstrap.regions) {
      if (!existing[auto.region]) {
        existing[auto.region] = {
          currency: auto.currency,
          priceMicros: auto.priceMicros,
        };
      }
    }

    // H4.2 — Manager Q7. The v3 body carries the base price only by stamping
    // defaultPrice on the US region when US has no price (adapter). When the
    // conversion failed (or returned no US) and the file price is NOT in
    // USD, that stamp would put a TWD/VND amount on the US store — refuse
    // the row instead. A USD file price is a correct US price: kept.
    // A failed conversion refuses the row even when a tier / custom set
    // already lists US: there is then no catalog version to pin (Hotfix 9)
    // and no price for the countries the tier / set does not list.
    const fileCurrency = product.defaultPrice?.currency ?? "";
    if (fileCurrency !== "USD" && (bootstrap.failed || !existing.US)) {
      row.priceRefusal = {
        kind: "conversion_failed",
        reason: bootstrap.failed
          ? conversionFailedReason(row, fileCurrency, bootstrap.failure)
          : `Row ${row.rowNumber} (${row.sku}): Google's conversion of the file price ${fileCurrency} ` +
            `${row.basePriceDecimal} returned no US price, and the file price is not in USD — the product ` +
            `would have no correct US price. Row not sent; try again.`,
      };
      priceRefusedRows += 1;
      console.info(`[google-iap:bulk-import] refused sku=${row.sku} kind=conversion_failed`);
      return;
    }

    // Hotfix 18 diagnostic: log the VN entry that actually goes into
    // the request body sent to Google. Pair with the post-template-
    // resolution log to pinpoint at which step VN diverges from the
    // template's value (if Manager's symptom recurs).
    if (input.pricingSource !== "google_default") {
      const vnFinal = existing.VN;
      const fromTemplate = product.prices?.VN;
      const fromBootstrap = bootstrap.regions.find((r) => r.region === "VN");
      console.info(
        `[google-iap:bulk-import] final_body sku=${row.sku} ` +
          `template_vn=${fromTemplate ? `${fromTemplate.currency}/${fromTemplate.priceMicros}` : "missing"} ` +
          `bootstrap_vn=${fromBootstrap ? `${fromBootstrap.currency}/${fromBootstrap.priceMicros}` : "missing"} ` +
          `final_vn=${vnFinal ? `${vnFinal.currency}/${vnFinal.priceMicros}` : "missing"}`,
      );
    }

    prepared.push({
      row,
      input: {
        body: {
          ...product,
          ...(Object.keys(existing).length > 0 ? { prices: existing } : {}),
        },
        regionsVersion: bootstrap.regionsVersion,
        // Signal the publisher layer to do a read-modify-write GET for overwrite
        // rows so it can include the product's FULL existing purchase options in
        // the PATCH body (Google rejects partial sets — "Missing: legacy-base").
        isOverwrite: row.decision === "overwrite",
      },
    });
  });

  const pushableRows = prepared.map((p) => p.row);
  const upsertInputs = prepared.map((p) => p.input);
  // H4.3 — the rows dropped in the file (never sent) and the rows refused
  // here, ONE list in file order: the Done report, the audit and the Hub
  // all read it, so no row the file states can go missing from any of them.
  const droppedDetail = (input.droppedRows ?? []).map((d) => ({
    sku: d.sku,
    rowNumber: d.rowNumber,
    reason: `Row ${d.rowNumber} (${d.sku || "no Product ID"}): ${d.reason} Not imported — refused in the file, left out when you pushed.`,
    kind: "refused_in_file",
  }));
  const refusedRowsDetail = [
    ...droppedDetail,
    ...actionableRows
      .filter((r) => r.priceRefusal || r.customPriceRefusal)
      .map((r) => {
        const refusal = (r.customPriceRefusal ?? r.priceRefusal) as { reason: string; kind: string };
        return { sku: r.sku, rowNumber: r.rowNumber, reason: refusal.reason, kind: refusal.kind };
      }),
  ].sort((a, b) => a.rowNumber - b.rowNumber);
  const droppedRows = droppedDetail.length;
  const rowsTotal = input.rows.length + droppedRows;

  // H4.4 — how EACH row sent in `rows` was priced (design §5.4 item 8): its
  // file currency and price, the anchor Google was asked to convert from,
  // the catalog version the request pinned, and its outcome. (Before
  // [GOOGLE-bulkimport-drop-gt] it also held the row's `gt` / `gt_outcome` —
  // audit rows under pricing_rule v1; Manager Q5.) Rows dropped in the file are in `refused_rows` (kind
  // refused_in_file). `outcome` is final only after the push — rows in the
  // request start as "in_request" and are resolved below (written /
  // google_failed / cache_sync_failed / google_rejected): a row Google did
  // not write must never read "written" (P5).
  const bootstrapByRow = new Map(candidateRows.map((r, i) => [r, bootstraps[i]]));
  const sentVersionByRow = new Map(prepared.map((p) => [p.row, p.input.regionsVersion ?? null]));
  type RowOutcome = string;
  const perRowPricingByRow = new Map(
    input.rows.map((r) => {
      const refusal = r.customPriceRefusal ?? r.priceRefusal ?? null;
      const outcome: RowOutcome =
        r.decision === "skip" ? "skipped" : refusal ? refusal.kind : sentVersionByRow.has(r) ? "in_request" : "not_sent";
      return [
        r,
        {
          row_number: r.rowNumber,
          sku: r.sku,
          decision: r.decision,
          file_currency: r.baseCurrency,
          file_price: r.basePriceDecimal,
          // The price Google was asked to convert from (also when it failed).
          anchor: bootstrapByRow.get(r)?.anchor ?? null,
          // The catalog version the REQUEST pinned (Hotfix 9): the conversion's,
          // or — when the conversion gave none — the publisher's static
          // default REGIONS_VERSION; null when the row was not sent.
          regions_version: sentVersionByRow.get(r) ?? null,
          regions_version_from: !sentVersionByRow.has(r)
            ? null
            : sentVersionByRow.get(r)
              ? "conversion"
              : "publisher_default",
          outcome,
        },
      ] as [BulkImportRow, Record<string, unknown> & { outcome: RowOutcome }];
    }),
  );
  const setOutcome = (row: BulkImportRow, outcome: RowOutcome) => {
    const rec = perRowPricingByRow.get(row);
    if (rec) rec.outcome = outcome;
  };
  const perRowPricing = input.rows.map((r) => perRowPricingByRow.get(r));

  let created = 0;
  let overwritten = 0;
  let failed = 0;

  if (pushableRows.length === 0) {
    // Nothing to send to Google; close out the batch. Refusals are still
    // recorded so the caller (and audit log) see exactly which rows were
    // rejected and why.
    await finalizeImportBatch(batch, {
      status: refusedRowsDetail.length > 0 ? "FAILED" : "COMPLETE",
      rows_skipped: skippedCount,
      rows_success: 0,
      rows_failed: refusedRowsDetail.length,
      executed_at: new Date().toISOString(),
    });

    await appendAction({
      actionType: "BULK_IMPORT_BATCH",
      actorEmail: input.actorEmail,
      targetId: input.appId,
      payload: {
        batch_id: batchId,
        package_name: input.packageName,
        pricing_source: input.pricingSource,
        // H4.4 — the rule this batch was priced under, the file's price header,
        // and how each row was priced (per_row_pricing, built above).
        pricing_rule: PRICING_RULE,
        price_header: input.priceHeader ?? null,
        gt_rows_with_data: input.gtRowsWithData ?? null,
        per_row_pricing: perRowPricing,
        rows_total: rowsTotal,
        rows_skipped: skippedCount,
        rows_created: 0,
        rows_overwritten: 0,
        rows_failed: 0,
        rows_refused: refusedRowsDetail.length,
        refused_rows: refusedRowsDetail,
        price_refused_rows: priceRefusedRows,
        dropped_in_file_rows: droppedRows,
        custom_priced_rows: customPricedRows,
        custom_refused_rows: customRefusedRows,
        // Included on the nothing-to-push path too. This is the branch a
        // fully-refused batch takes, and it is precisely where per-item
        // provenance matters most: without it the audit would record that
        // nothing shipped but not WHY each row was rejected.
        per_row_diagnostic: perRowDiagnostic,
        duration_ms: Date.now() - t0,
      },
    });

    return {
      batchId,
      rowsTotal,
      rowsCreated: 0,
      rowsOverwritten: 0,
      rowsSkipped: skippedCount,
      rowsFailed: 0,
      rowsRefused: refusedRowsDetail.length,
      priceRefusedRows,
      droppedRows,
      refusedRows: refusedRowsDetail,
      customPricedRows,
      customRefusedRows,
      durationMs: Date.now() - t0,
    };
  }

  try {
    const returned = await batchUpsertInAppProducts(
      jwt,
      input.packageName,
      upsertInputs,
    );

    // Map responses back to decisions. Order-preserved — index i
    // matches the request order. Missing positions = row failed.
    for (let i = 0; i < pushableRows.length; i += 1) {
      const row = pushableRows[i];
      const product = returned[i];
      if (!product || !product.sku) {
        failed += 1;
        // Google returned nothing for it — incl. an Overwrite row whose live
        // read failed, which the publisher leaves out of the call.
        setOutcome(row, "google_failed");
        continue;
      }
      try {
        await syncIapFromGoogle(input.appId, product);
        if (row.decision === "overwrite") overwritten += 1;
        else created += 1;
        setOutcome(row, "written");
      } catch (err) {
        console.error(
          `[google-iap:bulk-import] cache_sync_failed sku=${row.sku} err="${err instanceof Error ? err.message : String(err)}"`,
        );
        failed += 1;
        setOutcome(row, "cache_sync_failed");
      }
    }

    // P5 — refused rows are failed rows here too, as on the no-push and
    // catch branches (one rule for all three updates). The CHECK allows only
    // PENDING / IN_PROGRESS / COMPLETE / FAILED: never write a partial value.
    const rowsFailedTotal = failed + refusedRowsDetail.length;
    await finalizeImportBatch(batch, {
      status: rowsFailedTotal > 0 ? "FAILED" : "COMPLETE",
      rows_success: created + overwritten,
      rows_overwritten: overwritten,
      rows_skipped: skippedCount,
      rows_failed: rowsFailedTotal,
      executed_at: new Date().toISOString(),
    });
  } catch (err) {
    failed = pushableRows.length;
    for (const row of pushableRows) setOutcome(row, "google_rejected");
    await finalizeImportBatch(batch, {
      status: "FAILED",
      rows_failed: failed + refusedRowsDetail.length,
      rows_skipped: skippedCount,
      executed_at: new Date().toISOString(),
    });
    await appendAction({
      actionType: "BULK_IMPORT_BATCH",
      actorEmail: input.actorEmail,
      targetId: input.appId,
      payload: {
        batch_id: batchId,
        package_name: input.packageName,
        pricing_source: input.pricingSource,
        // H4.4 — the rule this batch was priced under, the file's price header,
        // and how each row was priced (per_row_pricing, built above).
        pricing_rule: PRICING_RULE,
        price_header: input.priceHeader ?? null,
        gt_rows_with_data: input.gtRowsWithData ?? null,
        per_row_pricing: perRowPricing,
        rows_total: rowsTotal,
        rows_skipped: skippedCount,
        rows_failed: failed,
        rows_refused: refusedRowsDetail.length,
        refused_rows: refusedRowsDetail,
        price_refused_rows: priceRefusedRows,
        dropped_in_file_rows: droppedRows,
        custom_priced_rows: customPricedRows,
        custom_refused_rows: customRefusedRows,
        // ⚠ THE WHOLE REASON THIS ARC EXISTS. `error` used to be
        // `err.message` and nothing else, so a batch could record
        // "The caller does not have permission" 16 times and carry not
        // one field saying WHICH permission, on WHOSE behalf, or whether
        // the legacy fallback failed for the same reason. The spread
        // adds `error_full` / `error_http_status` / `error_status` /
        // `error_reasons` / `error_details`. (The `error_fallback_*` half
        // cannot appear here any more: the batch path has no legacy
        // fallback since H4.2 / Q8.) `error` keeps its old meaning and
        // position, so every existing reader is unaffected.
        ...googleErrorPayload(err),
        duration_ms: Date.now() - t0,
      },
    });
    throw err;
  }

  await appendAction({
    actionType: "BULK_IMPORT_BATCH",
    actorEmail: input.actorEmail,
    targetId: input.appId,
    payload: {
      batch_id: batchId,
      package_name: input.packageName,
      pricing_source: input.pricingSource,
      // H4.4 — the rule this batch was priced under, the file's price header,
      // and how each row was priced (per_row_pricing, built above).
      pricing_rule: PRICING_RULE,
      price_header: input.priceHeader ?? null,
      gt_rows_with_data: input.gtRowsWithData ?? null,
      per_row_pricing: perRowPricing,
      template_matched_rows: templateMatchCount,
      // Hotfix 15 → Hotfix 16: split per match strategy so a future
      // audit can tell how many rows used the documented SKU-identifier
      // path vs the currency-price fallback. Hotfix 16 generalised the
      // fallback from USD-only to currency-aware, so the field name is
      // template_matched_by_currency_price (was _by_usd in Hotfix 15).
      template_matched_by_sku: templateMatchBySku,
      template_matched_by_currency_price: templateMatchByCurrencyPrice,
      // Hotfix 17: rows where pricingSource was a template scope but
      // neither SKU nor currency-price lookup found a tier — these
      // rows fall through to Hotfix 14 USD auto-bootstrap (Google's
      // convertRegionPrices). Surfacing the count lets Manager debug
      // mismatches between Excel rows and template coverage without
      // inferring from the gap between matched_rows and rows_total.
      template_no_match_rows: templateNoMatchRows,
      // Hotfix 19: selection-path counters. The wizard pre-selects a
      // primary tier for each ambiguous row (Q5.B); Manager can override.
      //   - ambiguous_rows:        rows with >1 candidate tiers
      //   - manager_overrode_rows: subset of ambiguous where Manager picked != default
      //   - default_accepted_rows: subset of ambiguous where Manager kept the default
      //   - single_match_rows:     rows with exactly 1 candidate (no choice)
      // Sum of (default_accepted + manager_overrode) == ambiguous_rows.
      ambiguous_rows: ambiguousRows,
      manager_overrode_rows: managerOverrodeRows,
      default_accepted_rows: defaultAcceptedRows,
      single_match_rows: singleMatchRows,
      // Hotfix 18 diagnostics: surface which template the orchestrator
      // actually queried + a compact per-row record of (strategy,
      // entries_count, VN price applied). Manager queries the audit log
      // alongside Q5's template SQL output and can spot at which step
      // the VN price diverges from the template entry.
      template_id_resolved: templateIdResolved,
      template_scope_used: templateScopeUsed,
      template_app_id_used: templateAppIdUsed,
      /** G1b — account mà bản Default được đọc từ đó. Không có trường
       *  này thì audit log nói "đã dùng Default" mà không nói Default
       *  CỦA AI, đúng câu hỏi mà arc này sinh ra để trả lời. */
      template_account_id_used: templateAccountIdUsed,
      per_row_diagnostic: perRowDiagnostic,
      // Every row not sent, with its kind and reason (file_price_invalid,
      // conversion_failed, tier_price_invalid, price_build_failed,
      // custom_invalid_price, refused_in_file), so each can be correlated
      // with the file.
      rows_refused: refusedRowsDetail.length,
      refused_rows: refusedRowsDetail,
      price_refused_rows: priceRefusedRows,
      dropped_in_file_rows: droppedRows,
      // Phase 3 — per-item custom pricing.
      custom_priced_rows: customPricedRows,
      custom_refused_rows: customRefusedRows,
      rows_total: rowsTotal,
      rows_created: created,
      rows_overwritten: overwritten,
      rows_skipped: skippedCount,
      rows_failed: failed,
      duration_ms: Date.now() - t0,
    },
  });

  return {
    batchId,
    rowsTotal,
    rowsCreated: created,
    rowsOverwritten: overwritten,
    rowsSkipped: skippedCount,
    rowsFailed: failed,
    rowsRefused: refusedRowsDetail.length,
    priceRefusedRows,
    droppedRows,
    refusedRows: refusedRowsDetail,
    customPricedRows,
    customRefusedRows,
    durationMs: Date.now() - t0,
  };
}
