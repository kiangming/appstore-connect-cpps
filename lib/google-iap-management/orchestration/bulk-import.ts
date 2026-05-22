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
import type {
  ParsedIapRow,
  ParsedRegionOverride,
  ParsedListing,
} from "../parsers/excel-parser";
import {
  lookupTemplateEntriesForIdentifier,
  findTemplateTierByUsdMicros,
} from "../queries/templates";

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
}

export interface BulkImportInput {
  appId: string;
  packageName: string;
  pricingSource: PricingSource;
  sourceFilename: string | null;
  rows: BulkImportRow[];
  actorEmail: string | null;
}

export interface BulkImportResult {
  batchId: string;
  rowsTotal: number;
  rowsCreated: number;
  rowsOverwritten: number;
  rowsSkipped: number;
  rowsFailed: number;
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

  return {
    packageName,
    sku: row.sku,
    status: "active",
    purchaseType: "managedUser",
    defaultLanguage: "en-US",
    defaultPrice: {
      currency: row.baseCurrency.trim().toUpperCase(),
      // Hotfix 5: base price must match the app's configured currency
      // precision — VND rejects fractions, etc.
      priceMicros: decimalToMicros(row.basePriceDecimal, row.baseCurrency),
    },
    listings,
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
  };
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

  // Q-GIAP.D + Hotfix 15: template-driven price resolution.
  //
  // Each row's SKU is matched against the template's identifier column
  // first (documented design — wizard step 1 help text). If that returns
  // zero entries (Manager's template is keyed by tier name "Tier 1" /
  // "Tier 2" rather than SKU — by far the more common shape), fall back
  // to USD-price-based tier inference: find the tier whose US-region
  // USD entry equals the row's USD baseline (in micros), then load that
  // tier's regional entries. Either match strategy fully replaces the
  // row's inline regionOverrides. Rows with neither match fall through
  // to USD auto-conversion via the Hotfix 14 bootstrap below — Manager
  // sees the per-row outcome breakdown in the BULK_IMPORT_BATCH audit
  // entry's match_by_strategy counters.
  let templateMatchCount = 0;
  let templateMatchBySku = 0;
  let templateMatchByUsd = 0;
  if (input.pricingSource !== "google_default") {
    const scope = input.pricingSource === "app_template" ? "APP" : "GLOBAL";
    const appIdForScope = scope === "APP" ? input.appId : null;
    for (const row of actionableRows) {
      // Strategy 1: SKU-based lookup (documented design).
      let entries = await lookupTemplateEntriesForIdentifier({
        scope,
        appId: appIdForScope,
        identifier: row.sku,
      });
      let matchedBy: "sku" | "usd" | null = entries.length > 0 ? "sku" : null;

      // Strategy 2: USD-price-based tier inference (Hotfix 15 fallback).
      if (entries.length === 0) {
        try {
          const usdMicros = decimalToMicros(row.basePriceDecimal, row.baseCurrency);
          // Only attempt the USD lookup when the row's base currency is
          // actually USD — otherwise the row's basePriceMicros is in
          // (say) VND and matching it against US/USD entries would be a
          // category error.
          if (row.baseCurrency.trim().toUpperCase() === "USD") {
            const tierId = await findTemplateTierByUsdMicros({
              scope,
              appId: appIdForScope,
              usdPriceMicros: usdMicros,
            });
            if (tierId) {
              entries = await lookupTemplateEntriesForIdentifier({
                scope,
                appId: appIdForScope,
                identifier: tierId,
              });
              if (entries.length > 0) matchedBy = "usd";
            }
          }
        } catch (err) {
          console.warn(
            `[google-iap:bulk-import] usd tier inference failed sku=${row.sku} err="${
              err instanceof Error ? err.message.replace(/"/g, "'") : String(err)
            }"`,
          );
        }
      }

      if (entries.length > 0) {
        row.regionOverrides = entries.map((e) => ({
          region: e.regionCode,
          currency: e.currency,
          priceDecimal: microsToDecimal(e.priceMicros, 6),
        }));
        templateMatchCount += 1;
        if (matchedBy === "sku") templateMatchBySku += 1;
        else if (matchedBy === "usd") templateMatchByUsd += 1;
      }
    }
  }

  if (actionableRows.length > BATCH_MAX) {
    throw new Error(
      `Bulk import exceeds Google's per-call cap (${BATCH_MAX}). ` +
        `Got ${actionableRows.length} rows after skips. Reduce the file or split into batches.`,
    );
  }

  let created = 0;
  let overwritten = 0;
  let failed = 0;

  if (actionableRows.length === 0) {
    // Nothing to send to Google; close out the batch.
    await db
      .from("import_batches")
      .update({
        status: "COMPLETE",
        rows_skipped: skippedCount,
        rows_success: 0,
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
      durationMs: Date.now() - t0,
    };
  }

  // Hotfix 14 Phase 3: per-row regions bootstrap via convertRegionPrices.
  // Bounded concurrency keeps the pre-batch fanout from saturating
  // Google's API. Each row gets its own {regions, regionsVersion} —
  // regionsVersion threads through to the batch upsert so the resource
  // is pinned to the same catalog the conversion came from (Hotfix 9
  // pattern carries forward to the batch path).
  type RowBootstrap = {
    regions: Array<{ region: string; currency: string; priceMicros: string }>;
    regionsVersion?: string;
  };
  const bootstraps = await withConcurrency(
    actionableRows,
    REGIONS_BOOTSTRAP_CONCURRENCY,
    async (row): Promise<RowBootstrap> => {
      try {
        const baseMicros = decimalToMicros(row.basePriceDecimal, row.baseCurrency);
        const result = await buildRegionMapFromBasePrice(
          jwt,
          input.packageName,
          baseMicros,
          row.baseCurrency,
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
  const upsertInputs = actionableRows.map((row, i) => {
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
    return {
      body: {
        ...product,
        ...(Object.keys(existing).length > 0 ? { prices: existing } : {}),
      },
      regionsVersion: bootstrap.regionsVersion,
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
    for (let i = 0; i < actionableRows.length; i += 1) {
      const row = actionableRows[i];
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
    failed = actionableRows.length;
    await db
      .from("import_batches")
      .update({
        status: "FAILED",
        rows_failed: failed,
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
      // Hotfix 15: split per match strategy so a future audit can tell
      // how many rows used the documented SKU-identifier path vs the
      // USD-price fallback. Helps Manager spot when templates need
      // restructuring (USD-only matches signal SKU mismatch).
      template_matched_by_sku: templateMatchBySku,
      template_matched_by_usd: templateMatchByUsd,
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
    durationMs: Date.now() - t0,
  };
}
