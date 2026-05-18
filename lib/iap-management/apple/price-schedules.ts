/**
 * Apple price-schedule POST wrapper (IAP.o.9a → IAP.o.11d).
 *
 * Apple's price-schedule endpoint is "replace-all" — every POST replaces the
 * entire current schedule, there is no PATCH. We only ever set a single
 * manual price entry at startDate=null (effective immediately), which covers
 * the Manager's bulk-import + create-on-apple flows. Scheduled pricing
 * (future startDate) is out of scope for IAP.o.9.
 *
 * The payload requires a "local id" reference that links the
 * `manualPrices.data[].id` array entry to the matching `included[].id`.
 * IAP.o.11d (Apple instrumentation log): Apple rejects plain UUIDs with
 * `ENTITY_ERROR.INCLUDED.INVALID_ID` — "the id must be a local id with the
 * format '${local-id}'". The literal `${...}` syntax is required (JSON:API
 * compound-document "lid" convention). We use `${price-1}` since we only
 * ever send one price entry per request.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import { iapFetch, AppleApiError } from "./fetch";

export interface SetPriceScheduleArgs {
  appleIapId: string;
  /** Base territory price-point (USA in practice). Apple equalizes the
   *  remaining territories from this one unless overridden by
   *  `additionalPricePointIds`. */
  applePricePointId: string;
  baseTerritory?: string;
  /**
   * IAP.p1.e — additional per-territory price-point overrides included in
   * the same POST. Each id is an opaque Apple identifier resolved by the
   * orchestrator from a per-territory pricePoints fetch. Empty array (the
   * default) preserves the single-price behavior of IAP.o.11d.
   */
  additionalPricePointIds?: readonly string[];
  /** Test seam: deterministic sleep + override delays + jitter. Defaults to
   *  IAP.o.11a budget (500 → 1500 → 4000 → 10000 → 30000 ms + ±20% jitter). */
  retryConfig?: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** 0 disables jitter (deterministic tests). Default 0.2 → ±20% per attempt. */
    jitterRatio?: number;
    /** Deterministic random source for tests. Returns [0, 1). */
    rng?: () => number;
  };
}

export interface SetPriceScheduleSuccess {
  ok: true;
  schedule_id: string;
  attempts: number;
}

export interface SetPriceScheduleFailure {
  ok: false;
  error: string;
  attempts: number;
}

export type SetPriceScheduleResult =
  | SetPriceScheduleSuccess
  | SetPriceScheduleFailure;

/** IAP.o.11a Q-H extended budget for Apple's intermittent 500 UNEXPECTED_ERROR
 *  (developer forum thread 728081). Heavy-load days may exhaust the previous
 *  3-attempt budget; 5 attempts with the new tail (10s + 30s) covers Apple's
 *  observed peak recovery window. ±20% jitter de-thunders concurrent retries
 *  in the bulk-import path (5 parallel rows could land identical backoff). */
const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 4000, 10000, 30000] as const;
const DEFAULT_JITTER_RATIO = 0.2;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Apply ±jitterRatio jitter around `base`. Returns a non-negative integer ms. */
function jittered(base: number, jitterRatio: number, rng: () => number): number {
  if (jitterRatio <= 0) return base;
  const offset = (rng() * 2 - 1) * jitterRatio * base;
  return Math.max(0, Math.round(base + offset));
}

/**
 * Set a single manual price effective immediately. Returns a typed result so
 * callers can surface "price not set" without aborting the orchestration —
 * Apple's defaults will leave the IAP at the same MISSING_METADATA state
 * until the price is set later via Apple Connect.
 *
 * Retry semantics (IAP.o.11a, was IAP.o.10a): Apple's
 * `/v1/inAppPurchasePriceSchedules` is known to return 500 UNEXPECTED_ERROR
 * intermittently (developer forum thread 728081). We retry up to 5 times
 * (was 3) with exponential backoff (500 → 1500 → 4000 → 10000 → 30000 ms)
 * plus ±20% jitter to de-thunder concurrent bulk-import retries. 5xx errors
 * retry; 4xx (409, 422 — wrong payload) propagate on first throw since retry
 * can't fix a payload mismatch.
 */
export async function setPriceSchedule(
  creds: AscCredentials,
  args: SetPriceScheduleArgs,
): Promise<SetPriceScheduleResult> {
  const baseTerritory = args.baseTerritory ?? "USA";
  // IAP.o.11d: literal "${...}" lid syntax required by Apple per
  // ENTITY_ERROR.INCLUDED.INVALID_ID surfaced by IAP.o.11a instrumentation.
  // IAP.p1.e: when additionalPricePointIds is non-empty, each price-point
  // gets its own lid (`${price-1}`, `${price-2}`, …) referenced from
  // manualPrices.data so Apple knows the manual schedule for those
  // territories. Apple auto-equalizes the territories not in the array.
  const allPricePointIds: string[] = [
    args.applePricePointId,
    ...(args.additionalPricePointIds ?? []),
  ];
  const refIds = allPricePointIds.map((_, i) => `\${price-${i + 1}}`);
  const body = {
    data: {
      type: "inAppPurchasePriceSchedules",
      relationships: {
        inAppPurchase: {
          data: { type: "inAppPurchases", id: args.appleIapId },
        },
        baseTerritory: {
          data: { type: "territories", id: baseTerritory },
        },
        manualPrices: {
          data: refIds.map((id) => ({ type: "inAppPurchasePrices", id })),
        },
      },
    },
    included: allPricePointIds.map((pricePointId, idx) => ({
      type: "inAppPurchasePrices",
      id: refIds[idx],
      attributes: { startDate: null },
      relationships: {
        inAppPurchasePricePoint: {
          data: {
            type: "inAppPurchasePricePoints",
            id: pricePointId,
          },
        },
        inAppPurchaseV2: {
          data: { type: "inAppPurchases", id: args.appleIapId },
        },
      },
    })),
  };

  const delays = args.retryConfig?.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = args.retryConfig?.sleep ?? defaultSleep;
  const jitterRatio = args.retryConfig?.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const rng = args.retryConfig?.rng ?? Math.random;
  let attempts = 0;
  let lastError = "Apple price schedule POST failed";

  console.log(
    `[set-price-schedule] start apple_iap_id=${args.appleIapId} price_point_id=${args.applePricePointId} max_attempts=${delays.length + 1}`,
  );
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    attempts = attempt + 1;
    try {
      console.log(
        `[set-price-schedule] attempt=${attempts} apple_iap_id=${args.appleIapId}`,
      );
      const res = await iapFetch<{
        data: { id: string; type: string };
      }>(creds, "POST", "/v1/inAppPurchasePriceSchedules", body);
      console.log(
        `[set-price-schedule] success apple_iap_id=${args.appleIapId} schedule_id=${res.data.id} attempts=${attempts}`,
      );
      return { ok: true, schedule_id: res.data.id, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isRetriable = err instanceof AppleApiError && err.status >= 500;
      if (!isRetriable || attempt === delays.length) {
        console.error(
          `[set-price-schedule] giving up apple_iap_id=${args.appleIapId} attempts=${attempts} retriable=${isRetriable}: ${lastError}`,
        );
        return { ok: false, error: lastError, attempts };
      }
      const delay = jittered(delays[attempt], jitterRatio, rng);
      console.warn(
        `[set-price-schedule] retry apple_iap_id=${args.appleIapId} attempt=${attempts} backoff=${delay}ms: ${lastError}`,
      );
      await sleep(delay);
    }
  }

  return { ok: false, error: lastError, attempts };
}
