/**
 * Pricing-schedule orchestration shared by single-IAP /create-on-apple and
 * the bulk-import /execute route.
 *
 * IAP.p1.e — 3-source pricing model (Manager Q-A..Q-K):
 *
 *   APPLE             — single USA price-point POST; Apple auto-equalizes
 *                       the remaining territories (= behavior pinned by
 *                       IAP.o.11d, F8 nuance preserves backward compat).
 *   DEFAULT_TEMPLATE  — USA base + per-territory overrides from the global
 *                       price_tier_templates entry set for the IAP's tier.
 *   APP_TEMPLATE      — same shape, but entries scoped to the app's own
 *                       template (overrides Default for that app).
 *
 * Sparse templates (Manager Q-I/Q-K): territories absent from the template's
 * entries for this tier fall back to Apple's auto-equalization. Entries that
 * reference a customer_price not present in Apple's per-territory catalog
 * produce a `partial-template-fail` outcome — the POST still happens with
 * the resolved overrides (fail-soft per Q-K) and the missing entries are
 * surfaced in the audit log.
 *
 * IAP.o.11a refactor inheritance — instrumentation parity preserved:
 *   1. `[pricing]` console.log at every decision point.
 *   2. Audit-log writes live INSIDE the orchestrator (try/catch) so an
 *      INSERT failure can't silently lose the trace.
 *   3. The whole orchestration is wrapped in try/catch with
 *      `failed-exception` so an unexpected throw is captured.
 *
 * IAP.o.10a inheritance — match by USA/USD customerPrice (Apple's priceTier
 * numbering changed in 2024, dev forum 728081). customerPrice remains the
 * canonical join key.
 *
 * Failures are NEVER fatal — Manager workflow is "IAP created on Apple,
 * Manager fixes pricing later if needed." The orchestrator's job is to set
 * the price when possible, otherwise surface a precise reason.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  listPricePointsForIap,
  findPricePointByUsdPrice,
  type InAppPurchasePricePoint,
} from "./price-points";
import { setPriceSchedule } from "./price-schedules";
import { AppleApiError } from "./fetch";
import { iapDb } from "@/lib/iap-management/db";
import {
  getDefaultTemplate,
  getAppTemplate,
  type TemplateWithEntries,
} from "@/lib/iap-management/queries/templates";
import { createTerritoryPricePointsCache } from "./territory-price-points-cache";

export type PricingSource =
  | { kind: "APPLE" }
  | { kind: "DEFAULT_TEMPLATE" }
  | { kind: "APP_TEMPLATE"; app_id: string };

export interface MissingPricePoint {
  tier_id: string;
  territory_code: string;
  customer_price: number;
}

export type PricingOutcome =
  | {
      kind: "set";
      price_point_id: string;
      schedule_id: string;
      usd_price: number;
      attempts: number;
      source_kind: PricingSource["kind"];
      overridden_territory_count: number;
    }
  | {
      /** Q-K fail-soft: schedule POSTed with the entries we could resolve,
       *  but some template entries had no matching Apple price-point. */
      kind: "partial-template-fail";
      schedule_id: string;
      attempts: number;
      source_kind: PricingSource["kind"];
      overridden_territory_count: number;
      missing_price_points: MissingPricePoint[];
    }
  | { kind: "skipped-no-tier" }
  | { kind: "skipped-no-usd-price"; tier_id: string }
  | { kind: "skipped-no-match"; tier_id: string; usd_price: number; sample_apple_prices: string[] }
  | { kind: "skipped-not-ready"; reason: string; poll_attempts: number; poll_total_ms: number }
  | { kind: "failed-lookup"; error: string }
  | {
      kind: "failed-set";
      tier_id: string;
      price_point_id: string;
      usd_price: number;
      error: string;
      attempts: number;
    }
  | { kind: "failed-exception"; error: string };

export interface ApplyPricingArgs {
  creds: AscCredentials;
  appleIapId: string;
  /** Local tier id surfaced in audit log only — not the match key. */
  localTierId: string | null | undefined;
  /** USA/USD customer_price resolved by the caller. Canonical match key
   *  against Apple's customerPrice attribute. */
  usdPrice: number | null | undefined;
  baseTerritory?: string;
  /** Pricing source — defaults to APPLE for backward compat. */
  source?: PricingSource;
  /** Optional pre-flight poll result. */
  precheck?: { ready: boolean; reason?: string; attempts?: number; total_ms?: number };
  audit: {
    iapId?: string | null;
    actor: string;
    batchId?: string;
    productId?: string;
    internalAppId?: string;
  };
}

export async function applyPricingSchedule(
  args: ApplyPricingArgs,
): Promise<PricingOutcome> {
  const source: PricingSource = args.source ?? { kind: "APPLE" };
  console.log(
    `[pricing] start apple_iap_id=${args.appleIapId} tier_id=${args.localTierId ?? "<null>"} usd_price=${args.usdPrice ?? "<null>"} source=${source.kind}`,
  );

  let outcome: PricingOutcome;
  try {
    outcome = await runPricingFlow(args, source);
  } catch (err) {
    const errStr =
      err instanceof AppleApiError
        ? `${err.status}: ${err.body.slice(0, 500)}`
        : err instanceof Error
          ? `${err.message}${err.stack ? `\n${err.stack}` : ""}`
          : String(err);
    console.error(
      `[pricing] UNEXPECTED EXCEPTION apple_iap_id=${args.appleIapId}: ${errStr}`,
    );
    outcome = { kind: "failed-exception", error: errStr };
  }

  console.log(
    `[pricing] complete apple_iap_id=${args.appleIapId} outcome=${outcome.kind}`,
  );
  await writePricingAuditLog(args, source, outcome);
  return outcome;
}

async function runPricingFlow(
  args: ApplyPricingArgs,
  source: PricingSource,
): Promise<PricingOutcome> {
  if (args.precheck && args.precheck.ready === false) {
    const reason = args.precheck.reason ?? "precheck-not-ready";
    console.warn(
      `[pricing] skipped-not-ready apple_iap_id=${args.appleIapId} reason=${reason} poll_attempts=${args.precheck.attempts ?? 0} poll_total_ms=${args.precheck.total_ms ?? 0}`,
    );
    return {
      kind: "skipped-not-ready",
      reason,
      poll_attempts: args.precheck.attempts ?? 0,
      poll_total_ms: args.precheck.total_ms ?? 0,
    };
  }
  if (!args.localTierId) {
    console.log(`[pricing] skipped-no-tier apple_iap_id=${args.appleIapId}`);
    return { kind: "skipped-no-tier" };
  }
  if (args.usdPrice === null || args.usdPrice === undefined) {
    console.log(
      `[pricing] skipped-no-usd-price apple_iap_id=${args.appleIapId} tier_id=${args.localTierId}`,
    );
    return { kind: "skipped-no-usd-price", tier_id: args.localTierId };
  }

  const baseTerritory = args.baseTerritory ?? "USA";
  console.log(
    `[pricing] fetching price points apple_iap_id=${args.appleIapId} territory=${baseTerritory}`,
  );
  let pricePoints: InAppPurchasePricePoint[];
  try {
    pricePoints = await listPricePointsForIap(
      args.creds,
      args.appleIapId,
      baseTerritory,
    );
  } catch (err) {
    const errStr =
      err instanceof AppleApiError
        ? `${err.status}: ${err.body.slice(0, 500)}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(
      `[pricing] failed-lookup apple_iap_id=${args.appleIapId}: ${errStr}`,
    );
    return { kind: "failed-lookup", error: errStr };
  }
  console.log(
    `[pricing] price points fetched apple_iap_id=${args.appleIapId} count=${pricePoints.length}`,
  );

  const match = findPricePointByUsdPrice(pricePoints, args.usdPrice);
  if (!match) {
    const samplePrices = pricePoints
      .slice(0, 10)
      .map((p) => p.attributes.customerPrice);
    console.warn(
      `[pricing] skipped-no-match apple_iap_id=${args.appleIapId} tier_id=${args.localTierId} usd_price=${args.usdPrice} apple_count=${pricePoints.length} sample=${JSON.stringify(samplePrices)}`,
    );
    return {
      kind: "skipped-no-match",
      tier_id: args.localTierId,
      usd_price: args.usdPrice,
      sample_apple_prices: samplePrices,
    };
  }
  console.log(
    `[pricing] match found apple_iap_id=${args.appleIapId} price_point_id=${match.id} usd_price=${args.usdPrice}`,
  );

  // ── Template branch: resolve per-territory overrides ───────────────────
  const additionalPricePointIds: string[] = [];
  const missing: MissingPricePoint[] = [];

  if (source.kind !== "APPLE") {
    const template: TemplateWithEntries | null =
      source.kind === "DEFAULT_TEMPLATE"
        ? await getDefaultTemplate()
        : await getAppTemplate(source.app_id);

    if (!template) {
      // Manager selected a template source but no template exists for this
      // scope. Fall back to APPLE behavior — don't fail the create flow.
      console.warn(
        `[pricing] template missing source=${source.kind} apple_iap_id=${args.appleIapId} → falling back to APPLE`,
      );
    } else {
      const tierEntries = template.entries.filter(
        (e) => e.tier_id === args.localTierId && e.territory_code !== baseTerritory,
      );
      console.log(
        `[pricing] template entries source=${source.kind} tier=${args.localTierId} count=${tierEntries.length} apple_iap_id=${args.appleIapId}`,
      );
      const cache = createTerritoryPricePointsCache(args.creds, args.appleIapId);
      cache.prime(baseTerritory, pricePoints);
      for (const entry of tierEntries) {
        let pointsForTerritory: InAppPurchasePricePoint[];
        try {
          pointsForTerritory = await cache.get(entry.territory_code);
        } catch (err) {
          const errStr =
            err instanceof AppleApiError
              ? `${err.status}: ${err.body.slice(0, 200)}`
              : err instanceof Error
                ? err.message
                : String(err);
          console.warn(
            `[pricing] territory fetch failed apple_iap_id=${args.appleIapId} territory=${entry.territory_code}: ${errStr}`,
          );
          missing.push({
            tier_id: entry.tier_id,
            territory_code: entry.territory_code,
            customer_price: entry.customer_price,
          });
          continue;
        }
        const territoryMatch = findPricePointByUsdPrice(
          pointsForTerritory,
          entry.customer_price,
        );
        if (territoryMatch) {
          additionalPricePointIds.push(territoryMatch.id);
        } else {
          console.warn(
            `[pricing] no Apple catalog match apple_iap_id=${args.appleIapId} territory=${entry.territory_code} customer_price=${entry.customer_price}`,
          );
          missing.push({
            tier_id: entry.tier_id,
            territory_code: entry.territory_code,
            customer_price: entry.customer_price,
          });
        }
      }
      console.log(
        `[pricing] template overrides resolved apple_iap_id=${args.appleIapId} matched=${additionalPricePointIds.length} missing=${missing.length} cache_size=${cache.size()}`,
      );
    }
  }

  console.log(
    `[pricing] POST schedule starting apple_iap_id=${args.appleIapId} price_point_id=${match.id} additional=${additionalPricePointIds.length}`,
  );
  const setResult = await setPriceSchedule(args.creds, {
    appleIapId: args.appleIapId,
    applePricePointId: match.id,
    additionalPricePointIds,
    baseTerritory,
  });
  if (!setResult.ok) {
    console.error(
      `[pricing] failed-set apple_iap_id=${args.appleIapId} attempts=${setResult.attempts}: ${setResult.error}`,
    );
    return {
      kind: "failed-set",
      tier_id: args.localTierId,
      price_point_id: match.id,
      usd_price: args.usdPrice,
      error: setResult.error,
      attempts: setResult.attempts,
    };
  }
  console.log(
    `[pricing] POST schedule success apple_iap_id=${args.appleIapId} schedule_id=${setResult.schedule_id} attempts=${setResult.attempts}`,
  );

  if (missing.length > 0) {
    return {
      kind: "partial-template-fail",
      schedule_id: setResult.schedule_id,
      attempts: setResult.attempts,
      source_kind: source.kind,
      overridden_territory_count: additionalPricePointIds.length,
      missing_price_points: missing,
    };
  }

  return {
    kind: "set",
    price_point_id: match.id,
    schedule_id: setResult.schedule_id,
    usd_price: args.usdPrice,
    attempts: setResult.attempts,
    source_kind: source.kind,
    overridden_territory_count: additionalPricePointIds.length,
  };
}

/** Map outcome.kind → audit-log severity. */
function severityFor(kind: PricingOutcome["kind"]): "SUCCESS" | "INFO" | "ERROR" {
  switch (kind) {
    case "set":
      return "SUCCESS";
    case "partial-template-fail":
      // Q-K fail-soft: surface as ERROR so Manager queries can find rows
      // with missing Apple catalog matches without filtering on a sub-field.
      return "ERROR";
    case "skipped-no-tier":
      return "INFO";
    case "skipped-no-usd-price":
    case "skipped-no-match":
    case "skipped-not-ready":
    case "failed-lookup":
    case "failed-set":
    case "failed-exception":
      return "ERROR";
  }
}

async function writePricingAuditLog(
  args: ApplyPricingArgs,
  source: PricingSource,
  outcome: PricingOutcome,
): Promise<void> {
  const result = severityFor(outcome.kind);
  try {
    const { error } = await iapDb()
      .from("actions_log")
      .insert({
        ...(args.audit.iapId ? { iap_id: args.audit.iapId } : {}),
        actor: args.audit.actor,
        action_type: "SET_PRICE_SCHEDULE",
        ...(args.audit.batchId ? { batch_id: args.audit.batchId } : {}),
        payload: {
          apple_iap_id: args.appleIapId,
          tier_id: args.localTierId ?? null,
          usd_price: args.usdPrice ?? null,
          source: source.kind,
          source_app_id: source.kind === "APP_TEMPLATE" ? source.app_id : null,
          outcome: outcome.kind,
          result,
          price_point_id:
            outcome.kind === "set" || outcome.kind === "failed-set"
              ? outcome.price_point_id
              : null,
          schedule_id:
            outcome.kind === "set" || outcome.kind === "partial-template-fail"
              ? outcome.schedule_id
              : null,
          attempts:
            outcome.kind === "set" ||
            outcome.kind === "failed-set" ||
            outcome.kind === "partial-template-fail"
              ? outcome.attempts
              : null,
          overridden_territory_count:
            outcome.kind === "set" || outcome.kind === "partial-template-fail"
              ? outcome.overridden_territory_count
              : null,
          missing_price_points:
            outcome.kind === "partial-template-fail"
              ? outcome.missing_price_points
              : null,
          error:
            outcome.kind === "failed-lookup" ||
            outcome.kind === "failed-set" ||
            outcome.kind === "failed-exception"
              ? outcome.error
              : null,
          sample_apple_prices:
            outcome.kind === "skipped-no-match"
              ? outcome.sample_apple_prices
              : null,
          poll_attempts:
            outcome.kind === "skipped-not-ready" ? outcome.poll_attempts : null,
          poll_total_ms:
            outcome.kind === "skipped-not-ready" ? outcome.poll_total_ms : null,
          poll_reason:
            outcome.kind === "skipped-not-ready" ? outcome.reason : null,
          ...(args.audit.productId ? { product_id: args.audit.productId } : {}),
          ...(args.audit.internalAppId
            ? { app_id: args.audit.internalAppId }
            : {}),
        },
      });
    if (error) {
      console.error(
        `[pricing] audit-log INSERT returned error apple_iap_id=${args.appleIapId} outcome=${outcome.kind}: ${error.message}`,
      );
    }
  } catch (err) {
    const errStr = err instanceof Error ? err.message : String(err);
    console.error(
      `[pricing] audit-log INSERT threw apple_iap_id=${args.appleIapId} outcome=${outcome.kind}: ${errStr}`,
    );
  }
}
