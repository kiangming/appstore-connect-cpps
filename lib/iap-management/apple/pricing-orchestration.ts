/**
 * Pricing-schedule orchestration shared by single-IAP /create-on-apple and
 * the bulk-import /execute route.
 *
 * IAP.o.11a refactor — Manager MV30 v4 surfaced "pricing always failed but no
 * log or error in Railway console". Section 2 audit confirmed payload schema
 * is correct against OpenAPI public-spec; the silent failure must be in a
 * code path that doesn't log. This refactor:
 *
 *   1. Adds `[pricing]` console.log at every decision point so Railway captures
 *      the exact branch taken.
 *   2. Moves audit-log writes INTO the orchestrator with try/catch so an
 *      audit-log INSERT failure (RLS, schema, etc.) surfaces explicitly to
 *      Railway console instead of silently dropping the trace.
 *   3. Wraps the whole orchestration in try/catch with a `failed-exception`
 *      outcome so an unexpected throw cannot silently exit the function.
 *
 * IAP.o.10a inheritance: match by USA/USD `customerPrice` (Apple priceTier
 * numbering changed in 2024, dev forum 728081 — `customerPrice` is the only
 * stable join key). `priceTier` is not in the OpenAPI public spec's field
 * enum for `/v2/inAppPurchases/{id}/pricePoints`, confirming customerPrice as
 * canonical.
 *
 * Failures are NEVER fatal — Manager workflow is "IAP created on Apple,
 * Manager fixes pricing later if needed." The orchestrator's job is to set
 * the price when possible, otherwise surface a precise reason so audit logs
 * + UI can show why.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  listPricePointsForIap,
  findPricePointByUsdPrice,
} from "./price-points";
import { setPriceSchedule } from "./price-schedules";
import { AppleApiError } from "./fetch";
import { iapDb } from "@/lib/iap-management/db";

export type PricingOutcome =
  | {
      kind: "set";
      price_point_id: string;
      schedule_id: string;
      usd_price: number;
      attempts: number;
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
  /** USA/USD customer_price resolved by the caller from
   *  iap_mgmt.price_tier_territories. Canonical match key against Apple's
   *  customerPrice attribute. Null when the tier isn't in the local cache. */
  usdPrice: number | null | undefined;
  baseTerritory?: string;
  /** Optional pre-flight poll result. If supplied AND `ready === false`, the
   *  orchestrator short-circuits to `skipped-not-ready` without calling
   *  Apple. Keeps poll-failure audit writes consolidated with the pricing
   *  audit log writes so Manager queries hit a single action_type. */
  precheck?: { ready: boolean; reason?: string; attempts?: number; total_ms?: number };
  /** Audit log context — required so the orchestrator can write a
   *  SET_PRICE_SCHEDULE row at every outcome path. Threading this through the
   *  args (vs the route handler writing) means a silent return-early cannot
   *  leave the audit log empty. */
  audit: {
    /** Local iap_mgmt.iaps.id. Optional for bulk-import CREATE path where the
     *  local row may not exist yet at the time of pricing — orchestrator
     *  falls back to batch_id + apple_iap_id correlation in that case. */
    iapId?: string | null;
    actor: string;
    /** Optional bulk-import batch correlation. */
    batchId?: string;
    /** Optional product_id correlation (bulk-import). */
    productId?: string;
    /** Optional internal app_id correlation (bulk-import). */
    internalAppId?: string;
  };
}

/**
 * Apply the resolved USD price as Apple's manual price for the IAP. The
 * result `kind` discriminates the outcome — callers map it to a UI badge and
 * the audit log row is written here unconditionally.
 *
 * Instrumentation: every branch hits a `[pricing]` console.log so Railway log
 * tail shows which path was taken. The audit-log write is try/catch wrapped
 * so a write failure does not silently lose the trace.
 */
export async function applyPricingSchedule(
  args: ApplyPricingArgs,
): Promise<PricingOutcome> {
  console.log(
    `[pricing] start apple_iap_id=${args.appleIapId} tier_id=${args.localTierId ?? "<null>"} usd_price=${args.usdPrice ?? "<null>"}`,
  );

  let outcome: PricingOutcome;
  try {
    outcome = await runPricingFlow(args);
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
  await writePricingAuditLog(args, outcome);
  return outcome;
}

async function runPricingFlow(args: ApplyPricingArgs): Promise<PricingOutcome> {
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
  let pricePoints;
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

  console.log(
    `[pricing] POST schedule starting apple_iap_id=${args.appleIapId} price_point_id=${match.id}`,
  );
  const setResult = await setPriceSchedule(args.creds, {
    appleIapId: args.appleIapId,
    applePricePointId: match.id,
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
  return {
    kind: "set",
    price_point_id: match.id,
    schedule_id: setResult.schedule_id,
    usd_price: args.usdPrice,
    attempts: setResult.attempts,
  };
}

/**
 * Map outcome.kind → audit-log severity. Per Manager IAP.o.11 Q-F: pricing
 * failures escalate to ERROR (was previously implicit WARN). Intentional
 * skip (no tier configured) stays INFO; data-integrity skips and Apple
 * failures all carry ERROR so Manager surfaces them in diagnostic queries.
 */
function severityFor(kind: PricingOutcome["kind"]): "SUCCESS" | "INFO" | "ERROR" {
  switch (kind) {
    case "set":
      return "SUCCESS";
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

/**
 * Write the SET_PRICE_SCHEDULE audit row. Wrapped in try/catch because per
 * IAP.o.11 H4 hypothesis an INSERT failure (RLS, schema, supabase outage)
 * could silently drop the only persistent trace of the pricing attempt. If
 * the write fails, the failure surfaces to Railway console so it can never
 * disappear without leaving a footprint somewhere.
 */
async function writePricingAuditLog(
  args: ApplyPricingArgs,
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
          outcome: outcome.kind,
          result,
          price_point_id:
            outcome.kind === "set" || outcome.kind === "failed-set"
              ? outcome.price_point_id
              : null,
          schedule_id: outcome.kind === "set" ? outcome.schedule_id : null,
          attempts:
            outcome.kind === "set" || outcome.kind === "failed-set"
              ? outcome.attempts
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
