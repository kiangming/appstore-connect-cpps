/**
 * Apple price-schedule POST wrapper (IAP.o.9a).
 *
 * Apple's price-schedule endpoint is "replace-all" — every POST replaces the
 * entire current schedule, there is no PATCH. We only ever set a single
 * manual price entry at startDate=null (effective immediately), which covers
 * the Manager's bulk-import + create-on-apple flows. Scheduled pricing
 * (future startDate) is out of scope for IAP.o.9.
 *
 * The payload requires an arbitrary local reference id that links the
 * `manualPrices.data[].id` array entry to the matching `included[].id`. We
 * use `randomUUID()` to generate it.
 */
import { randomUUID } from "crypto";
import type { AscCredentials } from "@/lib/asc-jwt";
import { iapFetch, AppleApiError } from "./fetch";

export interface SetPriceScheduleArgs {
  appleIapId: string;
  applePricePointId: string;
  baseTerritory?: string;
  /** Test seam: deterministic sleep + override delays. Defaults to setTimeout. */
  retryConfig?: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
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

/** Default exponential backoff for Apple's intermittent 500 UNEXPECTED_ERROR
 *  (developer forum confirms this as a known Apple bug — retry works). */
const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 4000] as const;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Set a single manual price effective immediately. Returns a typed result so
 * callers can surface "price not set" without aborting the orchestration —
 * Apple's defaults will leave the IAP at the same MISSING_METADATA state
 * until the price is set later via Apple Connect.
 *
 * Retry semantics (IAP.o.10a): Apple's `/v1/inAppPurchasePriceSchedules` is
 * known to return 500 UNEXPECTED_ERROR intermittently (developer forum
 * thread 728081). We retry up to 3 times with exponential backoff
 * (500ms → 1500ms → 4000ms) on 500 specifically. Other 4xx errors (409,
 * 422 — wrong payload) propagate on first throw since retrying can't fix
 * a payload mismatch.
 */
export async function setPriceSchedule(
  creds: AscCredentials,
  args: SetPriceScheduleArgs,
): Promise<SetPriceScheduleResult> {
  const baseTerritory = args.baseTerritory ?? "USA";
  const priceRefId = randomUUID();
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
          data: [{ type: "inAppPurchasePrices", id: priceRefId }],
        },
      },
    },
    included: [
      {
        type: "inAppPurchasePrices",
        id: priceRefId,
        attributes: { startDate: null },
        relationships: {
          inAppPurchasePricePoint: {
            data: {
              type: "inAppPurchasePricePoints",
              id: args.applePricePointId,
            },
          },
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: args.appleIapId },
          },
        },
      },
    ],
  };

  const delays = args.retryConfig?.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = args.retryConfig?.sleep ?? defaultSleep;
  let attempts = 0;
  let lastError = "Apple price schedule POST failed";

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    attempts = attempt + 1;
    try {
      const res = await iapFetch<{
        data: { id: string; type: string };
      }>(creds, "POST", "/v1/inAppPurchasePriceSchedules", body);
      return { ok: true, schedule_id: res.data.id, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isRetriable = err instanceof AppleApiError && err.status >= 500;
      if (!isRetriable || attempt === delays.length) {
        return { ok: false, error: lastError, attempts };
      }
      await sleep(delays[attempt]);
    }
  }

  return { ok: false, error: lastError, attempts };
}
