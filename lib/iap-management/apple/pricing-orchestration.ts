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
import {
  createTerritoryPricePointsCache,
  type TerritoryPricePointsCache,
} from "./territory-price-points-cache";
import type { BatchPricePointCatalog } from "./batch-price-point-catalog";

export type PricingSource =
  | { kind: "APPLE" }
  | { kind: "DEFAULT_TEMPLATE" }
  | { kind: "APP_TEMPLATE"; app_id: string };

export interface MissingPricePoint {
  /** Null for a custom — a custom has no tier by construction. */
  tier_id: string | null;
  territory_code: string;
  customer_price: number;
  /**
   * Which instruction failed to resolve.
   *
   * ⚠ The two are NOT equivalent in severity (Manager decision J-5). A template
   * entry that Apple has no price point for falls back to auto-equalisation and
   * is reported amber — partial is the expected shape of a bulk template. A
   * CUSTOM is an explicit per-territory instruction from the Manager; one that
   * cannot be applied is that instruction FAILING, and is reported red with the
   * territory named. Customs must never inherit the template path's silence.
   */
  source: "template" | "custom";
  /** Why it could not be applied — surfaced per territory, never aggregated
   *  into a bare count. */
  reason: "no-apple-price-point" | "territory-fetch-failed";
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
      /** Per-territory resolution breakdown, for the audit trail (§H). */
      resolution?: ResolutionBreakdown;
    }
  | {
      /** Q-K fail-soft: schedule POSTed with the entries we could resolve,
       *  but some TEMPLATE entries had no matching Apple price-point. Amber:
       *  those territories fall back to Apple's auto-equalisation, which is the
       *  documented behaviour of a sparse template. */
      kind: "partial-template-fail";
      schedule_id: string;
      attempts: number;
      source_kind: PricingSource["kind"];
      overridden_territory_count: number;
      missing_price_points: MissingPricePoint[];
      resolution?: ResolutionBreakdown;
    }
  | {
      /**
       * J-5 — at least one CUSTOM price could not be applied. RED, not amber,
       * and never folded into a success: each custom is an explicit
       * per-territory instruction, so one that cannot be applied is that
       * instruction failing. The schedule POST still happened (the other
       * territories are priced), but the outcome names which customs were lost
       * and why.
       */
      kind: "partial-custom-fail";
      schedule_id: string;
      attempts: number;
      source_kind: PricingSource["kind"];
      overridden_territory_count: number;
      missing_price_points: MissingPricePoint[];
      /** The subset with source === "custom" — the red ones. */
      failed_custom_territories: MissingPricePoint[];
      resolution?: ResolutionBreakdown;
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

/** How each non-base territory in the POSTed schedule got its price (§H). */
export interface ResolutionBreakdown {
  custom: number;
  template: number;
  /** Customs that displaced a template entry for the same territory — the
   *  number the G1 merge is responsible for. */
  custom_over_template: number;
}

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
  /**
   * Per-territory custom prices (SC1's `iap_custom_prices`), stored as
   * (territory_code, customer_price, currency_code) — the SAME shape as a
   * template entry, so they resolve to Apple price-point ids down the SAME path.
   * There are no stored ids: the id is per-IAP and cannot exist before the IAP
   * does (gate G2).
   *
   * ⚠ Applies under ALL THREE pricing sources including APPLE (rule CP-2). The
   * Google sibling shipped custom-under-template-only and had to be re-scoped a
   * cycle later; the resolution loop below therefore sits OUTSIDE the
   * `source.kind !== "APPLE"` branch by construction, not by convention.
   */
  customPrices?: readonly {
    territory_code: string;
    customer_price: number;
    currency_code: string;
  }[];
  /** Cycle 44: batch-level price-point catalog. When provided (bulk-import
   *  path), per-territory price points are fetched ONCE for the whole batch
   *  and each item's price-point id is derived locally. When absent (single
   *  create-on-apple path), the per-item fetch behavior is unchanged. */
  catalog?: BatchPricePointCatalog;
  /** Cycle 44: IAP type — cache key for the batch catalog (catalogs may vary
   *  by type). Only consulted when `catalog` is provided. */
  iapType?: string;
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
  const catalog = args.catalog;
  const iapType = args.iapType ?? "UNKNOWN";
  console.log(
    `[pricing] fetching price points apple_iap_id=${args.appleIapId} territory=${baseTerritory} source_data=${catalog ? "batch-catalog" : "per-item"}`,
  );

  // Cycle 44: resolve the USA base price points + an id-mapper. Bulk path
  // pulls from the batch catalog (fetched once across all items, ids derived
  // per IAP); single create-on-apple path fetches per-IAP and primes a
  // per-item cache exactly as before. Matching below is byte-for-byte the
  // same regardless of source — only WHERE the data came from changes.
  let pricePoints: InAppPurchasePricePoint[];
  let baseDeriveId: (id: string) => string;
  let perItemCache: TerritoryPricePointsCache | null = null;
  try {
    if (catalog) {
      const base = await catalog.territory(args.appleIapId, iapType, baseTerritory);
      pricePoints = base.points;
      baseDeriveId = base.deriveId;
    } else {
      pricePoints = await listPricePointsForIap(
        args.creds,
        args.appleIapId,
        baseTerritory,
      );
      baseDeriveId = (id) => id;
      perItemCache = createTerritoryPricePointsCache(args.creds, args.appleIapId);
      perItemCache.prime(baseTerritory, pricePoints);
    }
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
  // Derived = byte-identical to what a per-item fetch would return for this
  // IAP (guard-verified in the catalog); identity in the per-item path.
  const applePricePointId = baseDeriveId(match.id);
  console.log(
    `[pricing] match found apple_iap_id=${args.appleIapId} price_point_id=${applePricePointId} usd_price=${args.usdPrice}`,
  );

  // ── Per-territory override resolution ──────────────────────────────────
  //
  // ⚠ THE G1 MERGE. Keyed by territory, NOT a flat array.
  //
  // `setPriceSchedule`'s `additionalPricePointIds` is territory-ANONYMOUS — the
  // territory exists only inside the opaque `{s,t,p}` id, and nothing
  // downstream dedupes. Pushing template and custom entries into one array
  // would put TWO `manualPrices` entries for the same territory into a single
  // replace-all POST: that corrupts the REQUEST SHAPE (Apple's response to it
  // is unverified), it does not merely pick the wrong value. The Map makes
  // one-price-per-territory structurally true in the payload, mirroring what
  // `PRIMARY KEY (iap_id, territory_code)` already enforces in the database.
  //
  // Order is load-bearing: templates first, then customs. The custom loop's
  // `set()` is UNCONDITIONAL — that single line is where "custom wins" lives,
  // and it is the behaviour the mutation-check breaks the code to prove.
  const overridesByTerritory = new Map<
    string,
    { pricePointId: string; provenance: "template" | "custom" }
  >();
  const missing: MissingPricePoint[] = [];

  /** Shared per-territory point lookup — one code path for template and custom
   *  so the two can never resolve against different data. */
  async function pointsFor(
    territoryCode: string,
  ): Promise<{ points: InAppPurchasePricePoint[]; deriveId: (id: string) => string }> {
    if (catalog) {
      const tp = await catalog.territory(args.appleIapId, iapType, territoryCode);
      return { points: tp.points, deriveId: tp.deriveId };
    }
    return {
      points: await perItemCache!.get(territoryCode),
      deriveId: (id) => id,
    };
  }

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
      // Per-territory point source. Bulk path → batch catalog (fetched once
      // across items, id derived per IAP). Single path → per-item cache
      // primed with the USA base above; identity id-mapper. Either way the
      // customerPrice match below is unchanged.
      for (const entry of tierEntries) {
        let pointsForTerritory: InAppPurchasePricePoint[];
        let deriveId: (id: string) => string;
        try {
          const resolved = await pointsFor(entry.territory_code);
          pointsForTerritory = resolved.points;
          deriveId = resolved.deriveId;
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
            source: "template",
            reason: "territory-fetch-failed",
          });
          continue;
        }
        const territoryMatch = findPricePointByUsdPrice(
          pointsForTerritory,
          entry.customer_price,
        );
        if (territoryMatch) {
          overridesByTerritory.set(entry.territory_code, {
            pricePointId: deriveId(territoryMatch.id),
            provenance: "template",
          });
        } else {
          console.warn(
            `[pricing] no Apple catalog match apple_iap_id=${args.appleIapId} territory=${entry.territory_code} customer_price=${entry.customer_price}`,
          );
          missing.push({
            tier_id: entry.tier_id,
            territory_code: entry.territory_code,
            customer_price: entry.customer_price,
            source: "template",
            reason: "no-apple-price-point",
          });
        }
      }
      console.log(
        `[pricing] template overrides resolved apple_iap_id=${args.appleIapId} matched=${overridesByTerritory.size} missing=${missing.length}`,
      );
    }
  }

  // ── Custom branch — OUTSIDE the source check (rule CP-2) ────────────────
  //
  // Customs apply under APPLE, DEFAULT_TEMPLATE and APP_TEMPLATE alike. Under
  // APPLE they are the only overrides in the payload.
  const customEntries = (args.customPrices ?? []).filter(
    (c) => c.territory_code !== baseTerritory,
  );
  let customOverTemplate = 0;
  const failedCustoms: MissingPricePoint[] = [];
  if (customEntries.length > 0) {
    console.log(
      `[pricing] resolving customs apple_iap_id=${args.appleIapId} count=${customEntries.length} source=${source.kind}`,
    );
    for (const entry of customEntries) {
      let pointsForTerritory: InAppPurchasePricePoint[];
      let deriveId: (id: string) => string;
      try {
        const resolved = await pointsFor(entry.territory_code);
        pointsForTerritory = resolved.points;
        deriveId = resolved.deriveId;
      } catch (err) {
        const errStr =
          err instanceof AppleApiError
            ? `${err.status}: ${err.body.slice(0, 200)}`
            : err instanceof Error
              ? err.message
              : String(err);
        console.error(
          `[pricing] CUSTOM territory fetch failed apple_iap_id=${args.appleIapId} territory=${entry.territory_code}: ${errStr}`,
        );
        const fail: MissingPricePoint = {
          tier_id: null,
          territory_code: entry.territory_code,
          customer_price: entry.customer_price,
          source: "custom",
          reason: "territory-fetch-failed",
        };
        missing.push(fail);
        failedCustoms.push(fail);
        continue;
      }
      const match = findPricePointByUsdPrice(
        pointsForTerritory,
        entry.customer_price,
      );
      if (match) {
        // ⚠⚠ THE GUARD POINT. Unconditional — a template entry for the same
        // territory is discarded here, by construction rather than by an
        // ordering convention a future reader could invert.
        if (overridesByTerritory.get(entry.territory_code)?.provenance === "template") {
          customOverTemplate += 1;
        }
        overridesByTerritory.set(entry.territory_code, {
          pricePointId: deriveId(match.id),
          provenance: "custom",
        });
      } else {
        // J-5: RED. Not a silent auto fallback — that is the template path's
        // documented behaviour, and a custom must not inherit it.
        console.error(
          `[pricing] CUSTOM has no Apple price point apple_iap_id=${args.appleIapId} territory=${entry.territory_code} customer_price=${entry.customer_price}`,
        );
        const fail: MissingPricePoint = {
          tier_id: null,
          territory_code: entry.territory_code,
          customer_price: entry.customer_price,
          source: "custom",
          reason: "no-apple-price-point",
        };
        missing.push(fail);
        failedCustoms.push(fail);
      }
    }
    console.log(
      `[pricing] customs resolved apple_iap_id=${args.appleIapId} applied=${customEntries.length - failedCustoms.length} failed=${failedCustoms.length} over_template=${customOverTemplate}`,
    );
  }

  // Flatten LAST — one id per territory, guaranteed by the Map's key.
  const additionalPricePointIds = [...overridesByTerritory.values()].map(
    (v) => v.pricePointId,
  );
  const resolution: ResolutionBreakdown = {
    custom: [...overridesByTerritory.values()].filter(
      (v) => v.provenance === "custom",
    ).length,
    template: [...overridesByTerritory.values()].filter(
      (v) => v.provenance === "template",
    ).length,
    custom_over_template: customOverTemplate,
  };

  console.log(
    `[pricing] POST schedule starting apple_iap_id=${args.appleIapId} price_point_id=${applePricePointId} additional=${additionalPricePointIds.length}`,
  );
  const setResult = await setPriceSchedule(args.creds, {
    appleIapId: args.appleIapId,
    applePricePointId,
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
      price_point_id: applePricePointId,
      usd_price: args.usdPrice,
      error: setResult.error,
      attempts: setResult.attempts,
    };
  }
  console.log(
    `[pricing] POST schedule success apple_iap_id=${args.appleIapId} schedule_id=${setResult.schedule_id} attempts=${setResult.attempts}`,
  );

  // J-5 outcome precedence: a failed CUSTOM outranks a failed template entry.
  // The two are different severities, so they get different kinds rather than
  // one kind the UI has to inspect arrays to colour. A custom failure must never
  // be reported as `set`, and must never be flattened into the amber
  // template-partial that the Manager has learned to read as "expected".
  if (failedCustoms.length > 0) {
    return {
      kind: "partial-custom-fail",
      schedule_id: setResult.schedule_id,
      attempts: setResult.attempts,
      source_kind: source.kind,
      overridden_territory_count: additionalPricePointIds.length,
      missing_price_points: missing,
      failed_custom_territories: failedCustoms,
      resolution,
    };
  }

  if (missing.length > 0) {
    return {
      kind: "partial-template-fail",
      schedule_id: setResult.schedule_id,
      attempts: setResult.attempts,
      source_kind: source.kind,
      overridden_territory_count: additionalPricePointIds.length,
      missing_price_points: missing,
      resolution,
    };
  }

  return {
    kind: "set",
    price_point_id: applePricePointId,
    schedule_id: setResult.schedule_id,
    usd_price: args.usdPrice,
    attempts: setResult.attempts,
    source_kind: source.kind,
    overridden_territory_count: additionalPricePointIds.length,
    resolution,
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
    case "partial-custom-fail":
      // J-5: an explicit per-territory instruction did not apply.
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
            outcome.kind === "set" ||
            outcome.kind === "partial-template-fail" ||
            outcome.kind === "partial-custom-fail"
              ? outcome.schedule_id
              : null,
          attempts:
            outcome.kind === "set" ||
            outcome.kind === "failed-set" ||
            outcome.kind === "partial-template-fail" ||
            outcome.kind === "partial-custom-fail"
              ? outcome.attempts
              : null,
          overridden_territory_count:
            outcome.kind === "set" ||
            outcome.kind === "partial-template-fail" ||
            outcome.kind === "partial-custom-fail"
              ? outcome.overridden_territory_count
              : null,
          missing_price_points:
            outcome.kind === "partial-template-fail" ||
            outcome.kind === "partial-custom-fail"
              ? outcome.missing_price_points
              : null,
          // §H provenance — enough for a future reader to reconstruct WHY a
          // territory got its price: which mechanism won per territory, how many
          // customs displaced a template entry, and which customs never applied.
          custom_territory_count: (args.customPrices ?? []).length,
          custom_territories: (args.customPrices ?? []).map((c) => ({
            territory_code: c.territory_code,
            customer_price: c.customer_price,
            currency_code: c.currency_code,
            resolved: !(
              outcome.kind === "partial-custom-fail" &&
              outcome.failed_custom_territories.some(
                (f) => f.territory_code === c.territory_code,
              )
            ),
          })),
          resolution_by_territory:
            outcome.kind === "set" ||
            outcome.kind === "partial-template-fail" ||
            outcome.kind === "partial-custom-fail"
              ? (outcome.resolution ?? null)
              : null,
          failed_custom_territories:
            outcome.kind === "partial-custom-fail"
              ? outcome.failed_custom_territories
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
