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
  findTemplateTierByCurrencyMicros,
  templateExists,
  findTemplateId,
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
  let templateMatchByCurrencyPrice = 0;
  let templateNoMatchRows = 0;
  // Hotfix 18 diagnostic context — populated whenever the batch uses
  // a template scope. Surfaced in the audit log + Railway logs so
  // Manager can correlate "matched" counters with the actual entries
  // the orchestrator applied. Production gap (Manager batch 4895756e):
  // audit said matched_by_currency_price=3 but Google received the
  // Default template's VN value — without per-row diagnostics we can't
  // tell whether the bug is in the lookup, the mutation, the merge, or
  // the publisher-client. Capture-then-fix.
  let templateIdResolved: string | null = null;
  let templateScopeUsed: "GLOBAL" | "APP" | null = null;
  let templateAppIdUsed: string | null = null;
  const perRowDiagnostic: Array<{
    row_index: number;
    sku: string;
    base_currency: string;
    base_price_decimal: string;
    match_strategy: "sku" | "currency_price" | "none";
    entries_count: number;
    vn_currency: string | null;
    vn_price_decimal: string | null;
  }> = [];

  if (input.pricingSource !== "google_default") {
    const scope = input.pricingSource === "app_template" ? "APP" : "GLOBAL";
    const appIdForScope = scope === "APP" ? input.appId : null;
    templateScopeUsed = scope;
    templateAppIdUsed = appIdForScope;

    // Hotfix 17: pre-flight check. When Manager selects "Per-App
    // Template" (or "Default Template") but no template of that scope
    // exists, fail fast with an actionable message instead of silently
    // auto-bootstrapping every row from USD. Previously the orchestrator
    // looped all N rows, all lookups returned null, all rows fell
    // through to Hotfix 14 auto-bootstrap (Google's convertRegionPrices)
    // — Manager saw "items created with auto-converted prices" and
    // assumed Default fallback when in fact no template applied at all.
    const exists = await templateExists({ scope, appId: appIdForScope });
    if (!exists) {
      const which =
        input.pricingSource === "app_template"
          ? `Per-App Template for app ${input.appId}`
          : `Default Template`;
      throw new Error(
        `Bulk import was set to "${input.pricingSource}" but no ${which} has been uploaded. ` +
          `Upload one in Settings → Pricing Tiers, or change the pricing source to "google_default".`,
      );
    }

    // Hotfix 18: capture the template UUID the orchestrator's scope
    // resolution returned. Surfaced in audit log + per-row logs so
    // Manager can SQL-verify the right template was queried. If the
    // logged template_id ≠ the expected (Per-App) UUID, the bug is in
    // the scope→template resolution; if it matches but the row's
    // entries are still wrong, the bug is in the entries query or
    // downstream.
    templateIdResolved = await findTemplateId({ scope, appId: appIdForScope });
    console.info(
      `[google-iap:bulk-import] template_resolved scope=${scope} app_id=${appIdForScope ?? "-"} template_id=${templateIdResolved ?? "?"}`,
    );

    for (let rowIndex = 0; rowIndex < actionableRows.length; rowIndex += 1) {
      const row = actionableRows[rowIndex];
      // Strategy 1: SKU-based lookup (documented design).
      let entries = await lookupTemplateEntriesForIdentifier({
        scope,
        appId: appIdForScope,
        identifier: row.sku,
      });
      let matchedBy: "sku" | "currency_price" | null =
        entries.length > 0 ? "sku" : null;

      // Strategy 2: currency-aware price-based tier inference. Hotfix
      // 15 shipped a USD-only variant; Hotfix 16 generalises so VND /
      // EUR / etc. apps benefit from the same fallback. The match is
      // region-agnostic (a template tier's EUR price is the same micros
      // value under any Eurozone region code).
      if (entries.length === 0) {
        try {
          const baseMicros = decimalToMicros(
            row.basePriceDecimal,
            row.baseCurrency,
          );
          const tierId = await findTemplateTierByCurrencyMicros({
            scope,
            appId: appIdForScope,
            currencyCode: row.baseCurrency,
            priceMicros: baseMicros,
          });
          if (tierId) {
            entries = await lookupTemplateEntriesForIdentifier({
              scope,
              appId: appIdForScope,
              identifier: tierId,
            });
            if (entries.length > 0) matchedBy = "currency_price";
          }
        } catch (err) {
          console.warn(
            `[google-iap:bulk-import] currency tier inference failed sku=${row.sku} currency=${row.baseCurrency} err="${
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
        else if (matchedBy === "currency_price") templateMatchByCurrencyPrice += 1;

        // Hotfix 18 diagnostic: log + capture the resolved VN entry
        // (Manager symptom region) immediately after the mutation. If
        // this disagrees with the final body's VN entry logged below,
        // the gap is in the bootstrap merge. If it disagrees with what
        // Google receives, the gap is in publisher-client.
        const vnEntry = row.regionOverrides.find((r) => r.region === "VN");
        perRowDiagnostic.push({
          row_index: rowIndex,
          sku: row.sku,
          base_currency: row.baseCurrency,
          base_price_decimal: row.basePriceDecimal,
          match_strategy: matchedBy ?? "none",
          entries_count: entries.length,
          vn_currency: vnEntry?.currency ?? null,
          vn_price_decimal: vnEntry?.priceDecimal ?? null,
        });
        console.info(
          `[google-iap:bulk-import] template_match sku=${row.sku} strategy=${matchedBy ?? "?"} entries=${entries.length} vn=${vnEntry ? `${vnEntry.currency}/${vnEntry.priceDecimal}` : "missing"}`,
        );
      } else {
        // Hotfix 17: template scope was selected but this row didn't
        // match any tier — track the count so the audit log surfaces
        // "how many rows fell through to auto-bootstrap" instead of
        // Manager having to infer it from the difference between
        // template_matched_rows and rows_total.
        templateNoMatchRows += 1;
        perRowDiagnostic.push({
          row_index: rowIndex,
          sku: row.sku,
          base_currency: row.baseCurrency,
          base_price_decimal: row.basePriceDecimal,
          match_strategy: "none",
          entries_count: 0,
          vn_currency: null,
          vn_price_decimal: null,
        });
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
      // Hotfix 18 diagnostics: surface which template the orchestrator
      // actually queried + a compact per-row record of (strategy,
      // entries_count, VN price applied). Manager queries the audit log
      // alongside Q5's template SQL output and can spot at which step
      // the VN price diverges from the template entry.
      template_id_resolved: templateIdResolved,
      template_scope_used: templateScopeUsed,
      template_app_id_used: templateAppIdUsed,
      per_row_diagnostic: perRowDiagnostic,
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
