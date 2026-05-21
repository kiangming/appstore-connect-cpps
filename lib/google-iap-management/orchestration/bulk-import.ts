/**
 * Bulk-import orchestrator (Q-GIAP.E).
 *
 * Takes the Manager's parsed Excel rows + per-row Overwrite/Skip decisions
 * and pushes them to Google Play in a single batchUpdate call. Each request
 * carries `allowMissing: true` so new SKUs are inserted and existing SKUs
 * are updated in the same round-trip — matching Google Play Console's own
 * import behaviour.
 *
 * Post-call we resync the cache from the response (one row per affected
 * IAP) and emit a BULK_IMPORT_BATCH audit entry with the counters.
 *
 * Failure modes:
 *   - batchUpdate caps at 100 requests. The caller is responsible for
 *     chunking if a Manager submits >100 rows; v1 surfaces an error so the
 *     wizard can show it. Manager flow today rarely hits that ceiling.
 *   - Per-row failures inside batchUpdate aren't surfaced by Google as
 *     a structured per-row error array — only success responses come back.
 *     If the call throws, the whole batch is treated as failed.
 */
import type { JWT } from "google-auth-library";

import {
  batchUpdateInAppProducts,
  type InAppProduct,
  type InappproductsBatchUpdateRequest,
} from "../google/publisher-client";
import { decimalToMicros, microsToDecimal } from "../google/price-conversion";
import { syncIapFromGoogle } from "../repository/iaps";
import { appendAction } from "../repository/actions-log";
import { googleIapDb } from "../db";
import type {
  ParsedIapRow,
  ParsedRegionOverride,
  ParsedListing,
} from "../parsers/excel-parser";
import { lookupTemplateEntriesForIdentifier } from "../queries/templates";

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

  // Q-GIAP.D: template-driven price resolution — when source is a template,
  // each row's SKU is matched against the template's identifier column.
  // Matched rows have their inline regionOverrides replaced with the
  // template's tier entries; unmatched rows fall back to inline pricing
  // (a warning is recorded but the row still imports).
  let templateMatchCount = 0;
  if (input.pricingSource !== "google_default") {
    const scope = input.pricingSource === "app_template" ? "APP" : "GLOBAL";
    for (const row of actionableRows) {
      const entries = await lookupTemplateEntriesForIdentifier({
        scope,
        appId: scope === "APP" ? input.appId : null,
        identifier: row.sku,
      });
      if (entries.length > 0) {
        row.regionOverrides = entries.map((e) => ({
          region: e.regionCode,
          currency: e.currency,
          priceDecimal: microsToDecimal(e.priceMicros, 6),
        }));
        templateMatchCount += 1;
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

  const requestBody: InappproductsBatchUpdateRequest = {
    requests: actionableRows.map((row) => ({
      packageName: input.packageName,
      sku: row.sku,
      allowMissing: true,
      autoConvertMissingPrices: false,
      inappproduct: buildProduct(input.packageName, row),
    })),
  };

  try {
    const res = await batchUpdateInAppProducts(jwt, input.packageName, requestBody);

    // Map responses back to decisions. Google returns one InAppProduct per
    // request in the same order; if any are missing we count those as failed.
    const returned = res.inappproducts ?? [];
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
