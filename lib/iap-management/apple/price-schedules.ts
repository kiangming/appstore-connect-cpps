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
import { iapFetch } from "./fetch";

export interface SetPriceScheduleArgs {
  appleIapId: string;
  applePricePointId: string;
  baseTerritory?: string;
}

export interface SetPriceScheduleSuccess {
  ok: true;
  schedule_id: string;
}

export interface SetPriceScheduleFailure {
  ok: false;
  error: string;
}

export type SetPriceScheduleResult =
  | SetPriceScheduleSuccess
  | SetPriceScheduleFailure;

/**
 * Set a single manual price effective immediately. Returns a typed result so
 * callers can surface "price not set" without aborting the orchestration —
 * Apple's defaults will leave the IAP at the same MISSING_METADATA state
 * until the price is set later via Apple Connect.
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

  try {
    const res = await iapFetch<{
      data: { id: string; type: string };
    }>(creds, "POST", "/v1/inAppPurchasePriceSchedules", body);
    return { ok: true, schedule_id: res.data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
