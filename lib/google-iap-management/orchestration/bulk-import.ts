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
 *     come back. If the new-API call throws, `batchUpsertInAppProducts`
 *     falls back to the legacy endpoint and that throw bubbles here.
 *   - Per-row regions bootstrap failures are non-fatal; the row falls
 *     through with only Manager's explicit prices and Google may then
 *     reject it with a clear actionable error.
 */
import type { JWT } from "google-auth-library";

import {
  batchUpsertInAppProducts,
  type InAppProduct,
} from "../google/publisher-client";
import { decimalToMicros, microsToDecimal } from "../google/price-conversion";
import { buildRegionMapFromBasePrice } from "../google/regions-helper";
import { syncIapFromGoogle } from "../repository/iaps";
import { appendAction } from "../repository/actions-log";
import { googleIapDb } from "../db";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import { PRICING_SOURCE_LABELS } from "../pricing-source-labels";
import type {
  ParsedIapRow,
  ParsedRegionOverride,
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
import {
  detectCrossCurrencyTrigger,
  findCrossCurrencyCandidates,
  resolveAppCurrencyEntryForTier,
  fileDecimalToAnchorMicros,
  REFUSAL_REASONS,
} from "./cross-currency";

/** Bound on per-row convertRegionPrices fanout. Google's Publisher API
 *  doesn't publish a documented rate limit for read endpoints but bulk
 *  callers should keep concurrent in-flight to a reasonable cap.
 *  5 mirrors the Apple submit orchestrator (lib/iap-management/concurrency.ts). */
const REGIONS_BOOTSTRAP_CONCURRENCY = 5;

export type PricingSource = "google_default" | "default_template" | "app_template";
export type RowDecision = "overwrite" | "skip" | "create";

export interface BulkImportRow extends ParsedIapRow {
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
  /** Cross-currency resolution outcome stamped by the orchestrator's
   *  cross-currency pre-pass. When set, `buildProduct` uses this
   *  {currency, priceMicros} pair for `defaultPrice` instead of
   *  decimalToMicros(basePriceDecimal, baseCurrency). Only set for
   *  cross-currency rows that resolved successfully via template
   *  lookup; null/undefined for same-currency rows (current path). */
  resolvedDefaultPrice?: { currency: string; priceMicros: string } | null;
  /** Cross-currency refusal — the row qualified for resolution but
   *  could not be resolved (no template, template miss, ambiguous
   *  without chooser pick, etc.). Per-row fail-soft: the row is
   *  excluded from the Google batch, audit-logged, and returned to
   *  the caller in `refusedRows`. The batch as a whole still ships
   *  the resolvable rows. */
  crossCurrencyRefusal?: {
    reason: string;
    /** Which refusal class fired — for audit + UI grouping. */
    kind:
      | "google_default"
      | "template_miss"
      | "multi_match_unresolved"
      | "missing_entries"
      | "no_app_currency_entry";
    usdAnchorMicros: string | null;
  } | null;
  /** Per-item custom prices (Phase 3). ABSOLUTE per-country amounts the
   *  Manager typed in the Preview step's dialog — independent of the batch
   *  template. The client only sends this for template sources on
   *  non-skipped rows; the execute route re-validates before it gets here.
   *
   *  Presence of this field makes the row skip BOTH the cross-currency
   *  pre-pass and the template-resolution loop (see the guard below) —
   *  that is what stops the template from overwriting these values. */
  customPrices?: {
    entries: ParsedRegionOverride[];
    baselineTier: string | null;
    /** ISO timestamp stamped when the dialog saved — audit provenance. */
    editedAt?: string | null;
  } | null;
  /** Custom-price refusal — the row carried a custom set that could not be
   *  applied. Per-row fail-soft, same channel as crossCurrencyRefusal: the
   *  row is excluded from the batch, audit-logged and returned in
   *  `refusedRows`. It NEVER falls through to the template price. */
  customPriceRefusal?: {
    reason: string;
    kind:
      | "custom_invalid_price"
      /** Template sources only — under Google Conversion the base price
       *  supplies defaultPrice, so no app-currency entry is required. */
      | "custom_no_app_currency_entry";
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
  actorEmail: string | null;
  /** Cross-currency resolution needs the app's default currency to
   *  pick the matching entry from a template tier (e.g. tier's VND
   *  entry when app currency is VND). Pass through from the execute
   *  route, which already reads it via getAppByPackage. Null on
   *  legacy callers; cross-currency rows then refuse with the
   *  google_default message. */
  appDefaultCurrency?: string | null;
}

export interface BulkImportResult {
  batchId: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
  /** Per-row fail-soft refusal count (cross-currency unresolvable, or a
   *  custom-price set that could not be applied). */
  rowsRefused: number;
  /** Rows whose prices came from a per-item custom set (Phase 3). */
  customPricedRows: number;
  /** Custom rows REFUSED. Surfaced separately from `rowsRefused` because
   *  the Hub terminal status treats them differently: a cross-currency
   *  refusal is a soft skip, but a custom refusal is a Manager
   *  instruction that did not happen (Q5 / P5). */
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
  for (const r of row.regionOverrides as ParsedRegionOverride[]) {
    if (!r.priceDecimal.trim()) continue;
    prices[r.region] = {
      currency: r.currency.trim().toUpperCase(),
      // Hotfix 5: per-region currency drives precision validation.
      priceMicros: decimalToMicros(r.priceDecimal, r.currency),
    };
  }

  // Cross-currency resolution (Cycle 43 feature): when the orchestrator's
  // pre-pass resolved the row to a template entry, use that entry's
  // (currency, priceMicros) verbatim for defaultPrice instead of
  // re-computing decimalToMicros(basePriceDecimal, baseCurrency). The raw
  // basePriceDecimal in cross-currency rows is a USD anchor (e.g. "4.99")
  // and would throw under VND precision; this branch sends the resolved
  // VND amount (e.g. "120000000000" micros = ₫120,000) instead.
  const defaultPrice = row.resolvedDefaultPrice
    ? {
        currency: row.resolvedDefaultPrice.currency.trim().toUpperCase(),
        priceMicros: row.resolvedDefaultPrice.priceMicros,
      }
    : {
        currency: row.baseCurrency.trim().toUpperCase(),
        // Hotfix 5: base price must match the app's configured currency
        // precision — VND rejects fractions, etc.
        priceMicros: decimalToMicros(row.basePriceDecimal, row.baseCurrency),
      };

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

/** Stamp a row with the outcome of a cross-currency tier resolution.
 *  Mutates the row in place: either sets `resolvedDefaultPrice` +
 *  `regionOverrides` (success) or `crossCurrencyRefusal` (failure).
 *  Also stamps `chosenTierIdentifier` on success so downstream audit
 *  logging picks up the tier the orchestrator actually used. */
function applyResolveOutcome(
  row: BulkImportRow,
  outcome: Awaited<ReturnType<typeof resolveAppCurrencyEntryForTier>>,
  usdAnchorMicros: string | null,
  appDefaultCurrency: string,
  tierIdentifier: string,
): void {
  if (outcome.kind === "resolved") {
    row.resolvedDefaultPrice = {
      currency: outcome.entry.currency,
      priceMicros: outcome.entry.priceMicros,
    };
    row.regionOverrides = outcome.allEntries.map((e) => ({
      region: e.regionCode,
      currency: e.currency,
      priceDecimal: microsToDecimal(e.priceMicros, 6),
    }));
    row.chosenTierIdentifier = tierIdentifier;
    row.tierCandidateCount = Math.max(row.tierCandidateCount ?? 0, 1);
  } else if (outcome.kind === "missing-entries") {
    row.crossCurrencyRefusal = {
      kind: "missing_entries",
      reason: REFUSAL_REASONS.missingEntries(tierIdentifier),
      usdAnchorMicros,
    };
  } else {
    row.crossCurrencyRefusal = {
      kind: "no_app_currency_entry",
      reason: REFUSAL_REASONS.noAppCurrencyEntry(
        tierIdentifier,
        appDefaultCurrency,
      ),
      usdAnchorMicros,
    };
  }
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
      rows_total: input.rows.length,
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

  const actionableRows = input.rows.filter((r) => r.decision !== "skip");
  const skippedCount = input.rows.length - actionableRows.length;

  // Cross-currency resolution pre-pass (Cycle 43 feature + 2026-06-01
  // header-first correction).
  //
  // Trigger order (detectCrossCurrencyTrigger):
  //   1. EXPLICIT header "Price (XXX)" with XXX ≠ app currency →
  //      header-first cross-currency, anchor = XXX (parameterized; may
  //      be USD, EUR, etc — NOT hardcoded).
  //   2. INFERRED header (generic "Price"/"Default Price"/"Base Price")
  //      with raw value that violates app-currency precision →
  //      value-based fallback cross-currency, anchor = USD by
  //      Manager-template convention.
  //   3. Neither → same-currency, current orchestrator path runs
  //      unchanged.
  //
  // Resolution (when cross-currency):
  //   - google_default source: refuse — no template to resolve against.
  //   - template source: look up (anchorCurrency, anchorMicros)
  //     candidates in the template.
  //       0 candidates → refuse (template miss).
  //       1 candidate  → load tier entries, pick app-currency entry,
  //                      stamp resolvedDefaultPrice + regionOverrides
  //                      so buildProduct sends the resolved app-currency
  //                      amount.
  //      >1 candidates → refuse (handler must pick via chosenTierIdentifier
  //                      from the wizard's multi-match dropdown; on the
  //                      next push that branch resolves the chosen tier).
  //   - chosenTierIdentifier already set + cross-currency: handler picked
  //     from a prior preview; resolve from that tier directly.
  //
  // Refused rows are excluded from the Google batch (per-row fail-soft,
  // Q-K) and surfaced in BulkImportResult.refusedRows + the audit log.
  // ── Custom-price pre-pass (Phase 3) ────────────────────────────────
  //
  // Runs BEFORE the cross-currency pre-pass and before the template loop.
  // Ordering is deliberate: custom prices are ABSOLUTE and already
  // denominated per country, so there is nothing to convert and nothing
  // to look up. Custom WINS over both.
  //
  // On success the row is stamped exactly the way the cross-currency path
  // stamps a resolved row — `regionOverrides` + `resolvedDefaultPrice` —
  // so `buildProduct` needs no change at all.
  //
  // On failure the row is REFUSED (per-row fail-soft) and excluded from
  // the batch. It must never fall through to the template price: shipping
  // a price the Manager did not choose, and reporting success for it,
  // is the exact failure this feature exists to prevent.
  const appCurrencyForCustom = (input.appDefaultCurrency ?? "").trim().toUpperCase();
  let customPricedRows = 0;
  let customRefusedRows = 0;

  for (const row of actionableRows) {
    if (!row.customPrices) continue;
    const entries = row.customPrices.entries ?? [];

    if (entries.length === 0) {
      row.customPriceRefusal = {
        kind: "custom_invalid_price",
        reason: `Row ${row.rowNumber} (${row.sku}): custom prices were marked but no country prices were supplied. Row not sent.`,
      };
      customRefusedRows += 1;
      continue;
    }

    // Validate every entry against ITS OWN currency. decimalToMicros is
    // the throwing backstop (the same guard the single-item write path
    // relies on); the route has already run the non-throwing check.
    const priced: Array<{ region: string; currency: string; priceMicros: string }> = [];
    let invalid: string | null = null;
    for (const e of entries) {
      const region = e.region.trim().toUpperCase();
      const currency = e.currency.trim().toUpperCase();
      if (!region || !currency) {
        invalid = `Row ${row.rowNumber} (${row.sku}): a custom price is missing its country or currency. Row not sent.`;
        break;
      }
      try {
        priced.push({
          region,
          currency,
          priceMicros: decimalToMicros(e.priceDecimal, currency),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        invalid = `Row ${row.rowNumber} (${row.sku}): custom price "${e.priceDecimal}" is invalid for ${currency} — ${detail} Row not sent.`;
        break;
      }
    }
    if (invalid) {
      row.customPriceRefusal = { kind: "custom_invalid_price", reason: invalid };
      customRefusedRows += 1;
      continue;
    }

    // ── defaultPrice: the semantics differ by source, and conflating them
    // was a real bug ────────────────────────────────────────────────────
    //
    // TEMPLATE source: the custom set REPLACES the full ~170-country set,
    //   so it is the only thing that can supply defaultPrice. Google
    //   requires one, and it must be in the app's configured currency
    //   (Q6). A set with no such entry is genuinely unusable → refuse.
    //
    // GOOGLE CONVERSION: the custom set is a SPARSE OVERLAY on top of the
    //   file's base price, which already supplies defaultPrice via
    //   buildProduct's fallback branch. Requiring an app-currency entry
    //   here would refuse a user who overrode three countries, none of
    //   them the app's own — something entirely legitimate, and the
    //   long-standing behaviour of the file's GT-Price column. We stamp
    //   resolvedDefaultPrice ONLY when the user actually set an
    //   app-currency price, because an explicit instruction should beat
    //   the file's base price.
    const isTemplateSource = input.pricingSource !== "google_default";
    const appCurrencyEntry = appCurrencyForCustom
      ? priced.find((p) => p.currency === appCurrencyForCustom)
      : undefined;

    if (isTemplateSource) {
      if (!appCurrencyForCustom) {
        row.customPriceRefusal = {
          kind: "custom_no_app_currency_entry",
          reason: `Row ${row.rowNumber} (${row.sku}): this app has no cached default currency, so no defaultPrice can be derived from the custom prices. Refresh the app from Google and retry. Row not sent.`,
        };
        customRefusedRows += 1;
        continue;
      }
      if (!appCurrencyEntry) {
        row.customPriceRefusal = {
          kind: "custom_no_app_currency_entry",
          reason: `Row ${row.rowNumber} (${row.sku}): custom prices carry no ${appCurrencyForCustom} entry, which Google requires for defaultPrice. Row not sent.`,
        };
        customRefusedRows += 1;
        continue;
      }
    }

    row.regionOverrides = priced.map((p) => ({
      region: p.region,
      currency: p.currency,
      priceDecimal: microsToDecimal(p.priceMicros, 6),
    }));
    if (appCurrencyEntry) {
      row.resolvedDefaultPrice = {
        currency: appCurrencyEntry.currency,
        priceMicros: appCurrencyEntry.priceMicros,
      };
    }
    // Under Google Conversion with no app-currency entry, resolvedDefaultPrice
    // stays unset on purpose: buildProduct then uses the row's base price
    // (bulk-import.ts buildProduct defaultPrice fallback), which is exactly
    // what a sparse overlay should do.
    customPricedRows += 1;
    console.info(
      `[google-iap:bulk-import:custom-prices] applied sku=${row.sku} source=${input.pricingSource} entries=${priced.length} default=${appCurrencyEntry ? `${appCurrencyEntry.currency}/${appCurrencyEntry.priceMicros}` : "base-price"} baseline_tier=${row.customPrices.baselineTier ?? "-"}`,
    );
  }

  const appCurrencyNorm = (input.appDefaultCurrency ?? "").trim().toUpperCase();
  const crossCurrencyRef: TemplateScopeRef =
    input.pricingSource === "app_template"
      ? { scope: "APP", appId: input.appId, accountId: null }
      : { scope: "ACCOUNT", accountId: input.accountId, appId: null };
  let crossCurrencyResolved = 0;
  let crossCurrencyRefused = 0;
  let crossCurrencyByExplicitHeader = 0;
  let crossCurrencyByValueFallback = 0;

  for (const row of actionableRows) {
    // CUSTOM WINS. A custom row is already denominated per country in
    // absolute amounts — there is no anchor to re-interpret and no tier to
    // resolve against. Applies to refused custom rows too: they are
    // already excluded, and re-refusing them here would overwrite the
    // accurate reason with a cross-currency one.
    if (row.customPrices) continue;

    const trigger = detectCrossCurrencyTrigger({
      basePriceDecimal: row.basePriceDecimal,
      baseCurrency: row.baseCurrency,
      priceHeaderSource: row.priceHeaderSource,
      appDefaultCurrency: input.appDefaultCurrency ?? null,
    });
    if (!trigger) continue;

    if (trigger.kind === "explicit_header") crossCurrencyByExplicitHeader += 1;
    else crossCurrencyByValueFallback += 1;

    const anchorMicros = fileDecimalToAnchorMicros(
      row.basePriceDecimal,
      trigger.anchorCurrency,
    );
    const appCurrencyForMsg = appCurrencyNorm || row.baseCurrency || "(unknown)";

    // google_default OR missing app currency → no template to resolve against.
    if (input.pricingSource === "google_default" || !appCurrencyNorm) {
      row.crossCurrencyRefusal = {
        kind: "google_default",
        reason: REFUSAL_REASONS.googleDefault(
          appCurrencyForMsg,
          row.basePriceDecimal,
          trigger.anchorCurrency,
        ),
        usdAnchorMicros: anchorMicros,
      };
      crossCurrencyRefused += 1;
      console.info(
        `[google-iap:bulk-import:cross-currency] refused sku=${row.sku} kind=google_default trigger=${trigger.kind} anchor=${trigger.anchorCurrency} price=${row.basePriceDecimal} app_currency=${appCurrencyForMsg}`,
      );
      continue;
    }

    // Template-based source. If the handler already picked a tier
    // (multi-match flow), resolve from it directly. Otherwise look up
    // candidates via the trigger's anchor currency.
    if (row.chosenTierIdentifier) {
      const outcome = await resolveAppCurrencyEntryForTier({
        ...crossCurrencyRef,
        identifier: row.chosenTierIdentifier,
        appDefaultCurrency: appCurrencyNorm,
      });
      applyResolveOutcome(
        row,
        outcome,
        anchorMicros,
        appCurrencyNorm,
        row.chosenTierIdentifier,
      );
    } else {
      const candidates = await findCrossCurrencyCandidates({
        ...crossCurrencyRef,
        filePriceDecimal: row.basePriceDecimal,
        anchorCurrency: trigger.anchorCurrency,
      });

      if (candidates.length === 0) {
        row.crossCurrencyRefusal = {
          kind: "template_miss",
          reason: REFUSAL_REASONS.templateMiss(
            appCurrencyNorm,
            row.basePriceDecimal,
            trigger.anchorCurrency,
          ),
          usdAnchorMicros: anchorMicros,
        };
      } else if (candidates.length > 1) {
        row.crossCurrencyRefusal = {
          kind: "multi_match_unresolved",
          reason: REFUSAL_REASONS.multiMatchUnresolved(
            appCurrencyNorm,
            row.basePriceDecimal,
            candidates.length,
            trigger.anchorCurrency,
          ),
          usdAnchorMicros: anchorMicros,
        };
        // Surface candidate count so the wizard's tier dropdown wires up
        // correctly on the next preview round.
        row.tierCandidateCount = candidates.length;
      } else {
        // Exactly 1 candidate — auto-resolve.
        const tier = candidates[0];
        const outcome = await resolveAppCurrencyEntryForTier({
          ...crossCurrencyRef,
          identifier: tier.identifier,
          appDefaultCurrency: appCurrencyNorm,
        });
        applyResolveOutcome(
          row,
          outcome,
          anchorMicros,
          appCurrencyNorm,
          tier.identifier,
        );
      }
    }

    if (row.crossCurrencyRefusal) {
      crossCurrencyRefused += 1;
      console.info(
        `[google-iap:bulk-import:cross-currency] refused sku=${row.sku} kind=${row.crossCurrencyRefusal.kind} trigger=${trigger.kind} anchor=${trigger.anchorCurrency} price=${row.basePriceDecimal} app_currency=${appCurrencyForMsg}`,
      );
    } else if (row.resolvedDefaultPrice) {
      crossCurrencyResolved += 1;
      console.info(
        `[google-iap:bulk-import:cross-currency] resolved sku=${row.sku} trigger=${trigger.kind} anchor=${trigger.anchorCurrency} src_price=${row.basePriceDecimal} → ${row.resolvedDefaultPrice.currency}/${row.resolvedDefaultPrice.priceMicros} tier=${row.chosenTierIdentifier ?? "?"}`,
      );
    }
  }

  // Split actionable into pushable (will hit Google) and refused
  // (cross-currency fail-soft). Order is preserved for both groups.
  const pushableRows = actionableRows.filter(
    (r) => !r.crossCurrencyRefusal && !r.customPriceRefusal,
  );
  const refusedRowsDetail = actionableRows
    .filter((r) => r.crossCurrencyRefusal || r.customPriceRefusal)
    .map((r) =>
      r.customPriceRefusal
        ? {
            sku: r.sku,
            rowNumber: r.rowNumber,
            reason: r.customPriceRefusal.reason,
            kind: r.customPriceRefusal.kind as string,
          }
        : {
            sku: r.sku,
            rowNumber: r.rowNumber,
            reason: r.crossCurrencyRefusal!.reason,
            kind: r.crossCurrencyRefusal!.kind as string,
          },
    );

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
  type PriceProvenance =
    | "custom"
    | "custom_refused"
    | "template"
    | "cross_currency_resolved"
    | "auto_bootstrap";
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

      // ⚠ TWO THINGS PROTECT CUSTOM PRICES HERE — BOTH ARE LOAD-BEARING.
      //
      // The design called this guard "the one line that is the whole
      // feature". Measured against the implementation that is not quite
      // right, and the difference matters to anyone editing this:
      //
      //   1. SUCCESS path — protected by `row.resolvedDefaultPrice`,
      //      stamped by the custom pre-pass above. That clause is what
      //      actually skips an applied custom row. Mutation-checked:
      //      deleting the stamp makes the anchor test fail with TEMPLATE
      //      prices in the payload.
      //   2. REFUSED path — protected by `row.customPrices`. A refused
      //      row has no resolvedDefaultPrice, so without this clause it
      //      falls through, has `row.regionOverrides` overwritten with
      //      template entries, and emits a diagnostic claiming
      //      provenance "template" for a row the Manager marked Custom.
      //      Mutation-checked by the provenance test.
      //
      // Keying off the INTENT (customPrices) as well as the outcome also
      // means a future refactor that stops excluding refused rows can't
      // silently start shipping template prices under a Custom label.
      //
      // Cross-currency pre-pass already handled this row — either
      // resolved (regionOverrides + resolvedDefaultPrice stamped) or
      // refused (excluded from pushable). In both cases the existing
      // same-currency template lookup below would call
      // decimalToMicros(row.basePriceDecimal, row.baseCurrency) which
      // throws for cross-currency. Skip.
      //
      // `row.customPrices` is the Phase-3 addition and it is NOT
      // redundant with `resolvedDefaultPrice`: a REFUSED custom row has
      // no resolvedDefaultPrice, and without this clause it would fall
      // into the template lookup below, get `row.regionOverrides`
      // overwritten with template entries (see the assignment ~100 lines
      // down), and then be excluded anyway — but a future refactor that
      // stops excluding refused rows would silently ship template prices
      // under a "custom" label. Key off the INTENT (customPrices), not
      // the outcome.
      //
      if (row.crossCurrencyRefusal || row.resolvedDefaultPrice || row.customPrices) {
        continue;
      }

      const baseMicros = decimalToMicros(
        row.basePriceDecimal,
        row.baseCurrency,
      );
      let entries: ParsedPricingEntry[] = [];
      let selectionPath: SelectionPath = "no_candidates_auto_bootstrap";
      let matchStrategy: "sku" | "currency_price" | "none" = "none";
      let candidateCount = row.tierCandidateCount ?? 0;
      const defaultTierOffered = row.defaultTierIdentifier ?? null;
      let selectedTier: string | null = null;

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
          singleMatchRows += 1;
        } else if (
          row.defaultTierIdentifier &&
          row.chosenTierIdentifier === row.defaultTierIdentifier
        ) {
          selectionPath = "default_accepted";
          defaultAcceptedRows += 1;
          ambiguousRows += 1;
        } else {
          selectionPath = "manager_explicit";
          managerOverrodeRows += 1;
          ambiguousRows += 1;
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
          singleMatchRows += 1;
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
              singleMatchRows += 1;
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

      if (entries.length > 0) {
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
          price_provenance: row.resolvedDefaultPrice
            ? "cross_currency_resolved"
            : "auto_bootstrap",
        });
      }
    }
  }

  if (pushableRows.length > BATCH_MAX) {
    throw new Error(
      `Bulk import exceeds Google's per-call cap (${BATCH_MAX}). ` +
        `Got ${pushableRows.length} rows after skips and cross-currency refusals. Reduce the file or split into batches.`,
    );
  }

  let created = 0;
  let overwritten = 0;
  let failed = 0;

  if (pushableRows.length === 0) {
    // Nothing to send to Google; close out the batch. Cross-currency
    // refusals are still recorded so the caller (and audit log) see
    // exactly which rows were rejected and why.
    await db
      .from("import_batches")
      .update({
        status: refusedRowsDetail.length > 0 ? "FAILED" : "COMPLETE",
        rows_skipped: skippedCount,
        rows_success: 0,
        rows_failed: refusedRowsDetail.length,
        executed_at: new Date().toISOString(),
      })
      .eq("id", batchId);

    await appendAction({
      actionType: "BULK_IMPORT_BATCH",
      actorEmail: input.actorEmail,
      targetId: input.appId,
      payload: {
        batch_id: batchId,
        package_name: input.packageName,
        pricing_source: input.pricingSource,
        rows_total: input.rows.length,
        rows_skipped: skippedCount,
        rows_created: 0,
        rows_overwritten: 0,
        rows_failed: 0,
        rows_refused: refusedRowsDetail.length,
        refused_rows: refusedRowsDetail,
        cross_currency_resolved: crossCurrencyResolved,
        cross_currency_refused: crossCurrencyRefused,
        cross_currency_by_explicit_header: crossCurrencyByExplicitHeader,
        cross_currency_by_value_fallback: crossCurrencyByValueFallback,
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
      rowsTotal: input.rows.length,
      rowsCreated: 0,
      rowsOverwritten: 0,
      rowsSkipped: skippedCount,
      rowsFailed: 0,
      rowsRefused: refusedRowsDetail.length,
      refusedRows: refusedRowsDetail,
      customPricedRows,
      customRefusedRows,
      durationMs: Date.now() - t0,
    };
  }

  // Hotfix 14 Phase 3: per-row regions bootstrap via convertRegionPrices.
  // Bounded concurrency keeps the pre-batch fanout from saturating
  // Google's API. Each row gets its own {regions, regionsVersion} —
  // regionsVersion threads through to the batch upsert so the resource
  // is pinned to the same catalog the conversion came from (Hotfix 9
  // pattern carries forward to the batch path).
  //
  // Cross-currency rows that resolved via template use the
  // resolvedDefaultPrice (app-currency micros) as the bootstrap anchor;
  // their raw basePriceDecimal is a USD anchor that would throw under
  // VND precision. Custom rows use it too (their app-currency entry).
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
  };
  const bootstraps = await withConcurrency(
    pushableRows,
    REGIONS_BOOTSTRAP_CONCURRENCY,
    async (row): Promise<RowBootstrap> => {
      try {
        const baseMicros = row.resolvedDefaultPrice
          ? row.resolvedDefaultPrice.priceMicros
          : decimalToMicros(row.basePriceDecimal, row.baseCurrency);
        const baseCurrencyForBootstrap = row.resolvedDefaultPrice
          ? row.resolvedDefaultPrice.currency
          : row.baseCurrency;
        const result = await buildRegionMapFromBasePrice(
          jwt,
          input.packageName,
          baseMicros,
          baseCurrencyForBootstrap,
        );
        return {
          regions: result.regions,
          regionsVersion: result.regionsVersion ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[google-iap:bulk-import] regions bootstrap failed sku=${row.sku} err="${
            err instanceof Error ? err.message.replace(/"/g, "'") : String(err)
          }"`,
        );
        return { regions: [] };
      }
    },
  );

  // Build per-row InAppProduct. Manager region overrides (already in
  // row.regionOverrides after the template-resolution loop above) win
  // over auto-converted catalog values — explicit intent beats
  // catalog defaults.
  const upsertInputs = pushableRows.map((row, i) => {
    const product = buildProduct(input.packageName, row);
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

    return {
      body: {
        ...product,
        ...(Object.keys(existing).length > 0 ? { prices: existing } : {}),
      },
      regionsVersion: bootstrap.regionsVersion,
      // Signal the publisher layer to do a read-modify-write GET for overwrite
      // rows so it can include the product's FULL existing purchase options in
      // the PATCH body (Google rejects partial sets — "Missing: legacy-base").
      isOverwrite: row.decision === "overwrite",
    };
  });

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
        continue;
      }
      try {
        await syncIapFromGoogle(input.appId, product);
        if (row.decision === "overwrite") overwritten += 1;
        else created += 1;
      } catch (err) {
        console.error(
          `[google-iap:bulk-import] cache_sync_failed sku=${row.sku} err="${err instanceof Error ? err.message : String(err)}"`,
        );
        failed += 1;
      }
    }

    await db
      .from("import_batches")
      .update({
        status: failed > 0 ? "FAILED" : "COMPLETE",
        rows_success: created + overwritten,
        rows_overwritten: overwritten,
        rows_skipped: skippedCount,
        rows_failed: failed,
        executed_at: new Date().toISOString(),
      })
      .eq("id", batchId);
  } catch (err) {
    failed = pushableRows.length;
    await db
      .from("import_batches")
      .update({
        status: "FAILED",
        rows_failed: failed + refusedRowsDetail.length,
        rows_skipped: skippedCount,
        executed_at: new Date().toISOString(),
      })
      .eq("id", batchId);
    await appendAction({
      actionType: "BULK_IMPORT_BATCH",
      actorEmail: input.actorEmail,
      targetId: input.appId,
      payload: {
        batch_id: batchId,
        package_name: input.packageName,
        pricing_source: input.pricingSource,
        rows_total: input.rows.length,
        rows_skipped: skippedCount,
        rows_failed: failed,
        rows_refused: refusedRowsDetail.length,
        refused_rows: refusedRowsDetail,
        cross_currency_resolved: crossCurrencyResolved,
        cross_currency_refused: crossCurrencyRefused,
        cross_currency_by_explicit_header: crossCurrencyByExplicitHeader,
        cross_currency_by_value_fallback: crossCurrencyByValueFallback,
        custom_priced_rows: customPricedRows,
        custom_refused_rows: customRefusedRows,
        error: err instanceof Error ? err.message : String(err),
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
      // Cycle 43 cross-currency telemetry — per-row fail-soft counts +
      // detail so Manager debugging can correlate refused-row SKUs with
      // the wizard preview and the file's Price column.
      rows_refused: refusedRowsDetail.length,
      refused_rows: refusedRowsDetail,
      cross_currency_resolved: crossCurrencyResolved,
      cross_currency_refused: crossCurrencyRefused,
      // Phase 3 — per-item custom pricing.
      custom_priced_rows: customPricedRows,
      custom_refused_rows: customRefusedRows,
      rows_total: input.rows.length,
      rows_created: created,
      rows_overwritten: overwritten,
      rows_skipped: skippedCount,
      rows_failed: failed,
      duration_ms: Date.now() - t0,
    },
  });

  return {
    batchId,
    rowsTotal: input.rows.length,
    rowsCreated: created,
    rowsOverwritten: overwritten,
    rowsSkipped: skippedCount,
    rowsFailed: failed,
    rowsRefused: refusedRowsDetail.length,
    refusedRows: refusedRowsDetail,
    customPricedRows,
    customRefusedRows,
    durationMs: Date.now() - t0,
  };
}
