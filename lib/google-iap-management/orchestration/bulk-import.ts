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
import type { ParsedPricingEntry } from "../parsers/pricing-template-parser";
import {
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice,
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
  let templateScopeUsed: "GLOBAL" | "APP" | null = null;
  let templateAppIdUsed: string | null = null;
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
  }> = [];

  if (input.pricingSource !== "google_default") {
    const scope = input.pricingSource === "app_template" ? "APP" : "GLOBAL";
    const appIdForScope = scope === "APP" ? input.appId : null;
    templateScopeUsed = scope;
    templateAppIdUsed = appIdForScope;

    // Hotfix 17 pre-flight (preserved): refuse to silently auto-bootstrap
    // when the selected template scope has no rows.
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

    templateIdResolved = await findTemplateId({ scope, appId: appIdForScope });
    console.info(
      `[google-iap:bulk-import] template_resolved scope=${scope} app_id=${appIdForScope ?? "-"} template_id=${templateIdResolved ?? "?"}`,
    );

    for (let rowIndex = 0; rowIndex < actionableRows.length; rowIndex += 1) {
      const row = actionableRows[rowIndex];
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
          scope,
          appId: appIdForScope,
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
          scope,
          appId: appIdForScope,
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
              scope,
              appId: appIdForScope,
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
              scope,
              appId: appIdForScope,
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
