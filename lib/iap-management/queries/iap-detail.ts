/**
 * Apple real-time detail composer (IAP.o.8c → IAP.p2.a).
 *
 * Used by the /view detail route — Manager wants the canonical Apple state
 * (not the local cache) when inspecting an IAP. `getIapDetailFromApple`
 * remains the slim wrapper that drove IAP.o.8c. `getIapViewData` is the
 * IAP.p2 composer that also pulls the price schedule and assembles the
 * full view-model in one resilient pass.
 *
 * Per-stage try/catch: the IAP fetch is the critical path (no IAP → 404),
 * but the price schedule is best-effort. A 404 (no schedule yet, e.g. an
 * IAP created locally then pushed without pricing) or a transient error on
 * pricing should NOT prevent the rest of the page from rendering — the view
 * surfaces a placeholder section.
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { getInAppPurchase } from "@/lib/iap-management/apple/client";
import {
  getPriceScheduleForIap,
  type PriceScheduleFetchResult,
} from "@/lib/iap-management/apple/price-schedules";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import type {
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
  InAppPurchasePrice,
  InAppPurchasePricePointResource,
  Territory,
  AscApiResponse,
  AscResource,
} from "@/types/iap-management/apple";

export interface IapDetailFromApple {
  iap: InAppPurchase;
  localizations: InAppPurchaseLocalization[];
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
}

export async function getIapDetailFromApple(
  creds: AscCredentials,
  appleIapId: string,
): Promise<IapDetailFromApple> {
  const res = await getInAppPurchase(creds, appleIapId);
  return splitIncluded(res);
}

/**
 * Pure helper exported for unit-testing — partitions `included` by type
 * with a defensive fallback when Apple returns the relationship object
 * without the matching `included` entry (links-only mode).
 */
export function splitIncluded(
  res: AscApiResponse<InAppPurchase>,
): IapDetailFromApple {
  const localizations: InAppPurchaseLocalization[] = [];
  let screenshot: InAppPurchaseAppStoreReviewScreenshot | null = null;

  for (const item of res.included ?? []) {
    if (item.type === "inAppPurchaseLocalizations") {
      localizations.push(item as unknown as InAppPurchaseLocalization);
    } else if (item.type === "inAppPurchaseAppStoreReviewScreenshots") {
      screenshot = item as unknown as InAppPurchaseAppStoreReviewScreenshot;
    }
  }

  return { iap: res.data, localizations, screenshot };
}

// ─── IAP.p2.a — Price Schedule view-model ────────────────────────────────────

/**
 * One row in the unpacked price schedule — combines an `inAppPurchasePrices`
 * resource with its referenced price point + that point's territory. This
 * is what the UI tables render directly.
 */
export interface PriceScheduleEntry {
  /** The price-resource id (Apple opaque) — used as a stable row key. */
  priceId: string;
  /** ISO date or `null` (effective immediately). */
  startDate: string | null;
  /** ISO date or `null` (no end). */
  endDate: string | null;
  /** Territory code (3-letter ISO, e.g. "USA", "VNM"). */
  territory: string;
  /** Customer-facing price string as Apple returns it ("0.99"). */
  customerPrice: string;
  /** Currency code ("USD", "VND") when Apple provides it. */
  currency: string | null;
}

export interface PriceScheduleView {
  /** Base territory ID (always present after Apple's POST). */
  baseTerritory: string;
  /**
   * Apple stores the base price in `automaticPrices`, NOT `manualPrices`.
   * `basePrice` is resolved separately via Stage 3 of `getPriceScheduleForIap`
   * and lives outside the `entries` array (`entries` only enumerates manual
   * overrides). `null` when Apple has no base price or the Stage 3 fetch
   * failed — the section renders the territory name without a price.
   */
  basePrice: PriceScheduleEntry | null;
  /** Every manual-price entry, oldest-startDate first. */
  entries: PriceScheduleEntry[];
}

/**
 * Build a per-type index over a JSON:API `included[]` block. O(1) lookup
 * by (type, id) — reused by `unpackPriceSchedule` for both Stage 1+2's
 * merged schedule and Stage 3's standalone base-price response.
 */
function indexIncluded(
  included: readonly AscResource<string, Record<string, unknown>>[],
): Map<string, Map<string, AscResource<string, Record<string, unknown>>>> {
  const byType = new Map<
    string,
    Map<string, AscResource<string, Record<string, unknown>>>
  >();
  for (const item of included) {
    let bucket = byType.get(item.type);
    if (!bucket) {
      bucket = new Map();
      byType.set(item.type, bucket);
    }
    bucket.set(item.id, item);
  }
  return byType;
}

/**
 * Resolve a single InAppPurchasePrice resource into the flat
 * PriceScheduleEntry shape the UI renders.
 *
 * IAP.p2.k bug fixes:
 *   - territory: read from `priceRes.relationships.territory.data.id`
 *     (the InAppPurchasePrice's OWN relationship, side-loaded by both
 *     Stage 2 and Stage 3 `?include=…,territory`). Pre-p2.k read it from
 *     `pricePoint.relationships.territory.data.id` — that relationship
 *     is NOT side-loaded by our include chain, so every entry's territory
 *     came back blank → no country column AND no base-price match.
 *   - currency: read from the Territory resource's `attributes.currency`
 *     (per Apple OpenAPI `fields[territories]: [currency]`). Pre-p2.k read
 *     it from `pricePoint.attributes.currency` — `currency` is NOT a
 *     price-point attribute (price-point attributes per Apple OpenAPI:
 *     `[customerPrice, proceeds, territory, equalizations]`), so every
 *     entry's currency came back null → no currency symbol in the UI.
 *
 * Returns null when essential links are missing (no price-point relationship,
 * no price-point in `included`). The caller's loop then `continue`s.
 */
function unpackPriceEntry(
  priceRes: InAppPurchasePrice,
  buckets: Map<
    string,
    Map<string, AscResource<string, Record<string, unknown>>>
  >,
): PriceScheduleEntry | null {
  const pricePointId = (priceRes.relationships as
    | { inAppPurchasePricePoint?: { data?: { id?: string } } }
    | undefined)?.inAppPurchasePricePoint?.data?.id;
  if (!pricePointId) return null;

  const pricePoint = buckets.get("inAppPurchasePricePoints")?.get(
    pricePointId,
  ) as InAppPurchasePricePointResource | undefined;
  if (!pricePoint) return null;

  // FIX A: territory from the price entry's own relationship.
  const territoryId =
    ((priceRes.relationships as
      | { territory?: { data?: { id?: string } } }
      | undefined)?.territory?.data?.id as Territory["id"] | undefined) ?? "";

  // FIX B: currency from the Territory resource's attributes.
  const territoryRes = buckets.get("territories")?.get(territoryId);
  const currency =
    (territoryRes?.attributes?.currency as string | undefined) ?? null;

  return {
    priceId: priceRes.id,
    startDate: priceRes.attributes.startDate ?? null,
    endDate: priceRes.attributes.endDate ?? null,
    territory: territoryId,
    customerPrice: pricePoint.attributes.customerPrice,
    currency,
  };
}

/**
 * Unpack Apple's price-schedule fetch result into a flat view-model the UI
 * can render. Exported for unit-testing the JSON:API plumbing without a
 * live Apple call.
 *
 * Walks Stage 1+2's merged `included[]` for the manualPrice entries and
 * Stage 3's standalone response for the base price (Apple stores base in
 * `automaticPrices`, NOT in `manualPrices`).
 */
export function unpackPriceSchedule(
  fetchResult: PriceScheduleFetchResult,
): PriceScheduleView {
  const { schedule: res, basePrice: basePriceRes } = fetchResult;
  const scheduleBuckets = indexIncluded(res.included ?? []);

  // Base territory id sits on the schedule's relationships. Defensive
  // fallback to "USA" matches the bulk-import default — every Apple POST
  // we've ever sent uses USA as the base.
  const baseTerritory =
    ((res.data.relationships as
      | { baseTerritory?: { data?: { id?: string } } }
      | undefined)?.baseTerritory?.data?.id as string | undefined) ?? "USA";

  // manualPrices.data is a JSON:API list of {type, id} pointers; resolve each
  // pointer through the typed buckets above.
  const manualRel = (res.data.relationships as
    | { manualPrices?: { data?: Array<{ id: string }> } }
    | undefined)?.manualPrices?.data ?? [];

  const priceBucket = scheduleBuckets.get("inAppPurchasePrices");
  const entries: PriceScheduleEntry[] = [];
  for (const ref of manualRel) {
    const priceRes = priceBucket?.get(ref.id) as
      | InAppPurchasePrice
      | undefined;
    if (!priceRes) continue;
    const entry = unpackPriceEntry(priceRes, scheduleBuckets);
    if (entry) entries.push(entry);
  }

  // Stable order: startDate ASC with nulls (effective-now) first, then by
  // territory for deterministic UI rendering.
  entries.sort((a, b) => {
    if (a.startDate === null && b.startDate === null) {
      return a.territory.localeCompare(b.territory);
    }
    if (a.startDate === null) return -1;
    if (b.startDate === null) return 1;
    if (a.startDate !== b.startDate) {
      return a.startDate < b.startDate ? -1 : 1;
    }
    return a.territory.localeCompare(b.territory);
  });

  // Stage 3 — unpack the base price (single-row response from
  // automaticPrices?filter[territory]=<base>&limit=1).
  let basePrice: PriceScheduleEntry | null = null;
  if (basePriceRes && Array.isArray(basePriceRes.data) && basePriceRes.data.length > 0) {
    const baseBuckets = indexIncluded(basePriceRes.included ?? []);
    basePrice = unpackPriceEntry(basePriceRes.data[0], baseBuckets);
  }

  return { baseTerritory, basePrice, entries };
}

export interface IapViewData {
  iap: InAppPurchase;
  localizations: InAppPurchaseLocalization[];
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
  /** `null` when Apple has no schedule yet (404) or the fetch failed. */
  priceSchedule: PriceScheduleView | null;
  /** Populated when the price-schedule fetch failed for a non-404 reason. */
  priceScheduleError: string | null;
}

/**
 * IAP.p2.a entry point — fetch + unpack the full Apple-side view in
 * parallel with resilient per-stage error handling.
 *
 * The IAP fetch is critical: if it throws, the page surfaces the existing
 * red error card via the route's outer try/catch. The price-schedule fetch
 * is best-effort: 404 → `priceSchedule: null` (Manager sees the empty
 * state), anything else → `priceScheduleError` populated so the section
 * can render a friendly "couldn't load pricing" note next to whatever
 * succeeded.
 */
export async function getIapViewData(
  creds: AscCredentials,
  appleIapId: string,
): Promise<IapViewData> {
  const [iapRes, scheduleSettled] = await Promise.all([
    getInAppPurchase(creds, appleIapId),
    getPriceScheduleForIap(creds, appleIapId).then(
      (res): { ok: true; res: PriceScheduleFetchResult } => ({
        ok: true,
        res,
      }),
      (err: unknown): { ok: false; err: unknown } => ({ ok: false, err }),
    ),
  ]);

  const { iap, localizations, screenshot } = splitIncluded(iapRes);

  let priceSchedule: PriceScheduleView | null = null;
  let priceScheduleError: string | null = null;
  if (scheduleSettled.ok) {
    try {
      priceSchedule = unpackPriceSchedule(scheduleSettled.res);
    } catch (err) {
      priceScheduleError =
        err instanceof Error ? err.message : "Failed to parse price schedule";
    }
  } else {
    const err = scheduleSettled.err;
    if (err instanceof AppleApiError && err.status === 404) {
      // Manager-created IAP that's been pushed but has no schedule yet —
      // the view renders the "no pricing set" placeholder.
      priceSchedule = null;
    } else {
      priceScheduleError =
        err instanceof Error ? err.message : "Failed to fetch price schedule";
    }
  }

  return {
    iap,
    localizations,
    screenshot,
    priceSchedule,
    priceScheduleError,
  };
}
