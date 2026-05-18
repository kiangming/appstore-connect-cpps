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
} from "@/lib/iap-management/apple/price-schedules";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import type {
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
  InAppPurchasePriceSchedule,
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
  /** Base territory (always present after Apple's POST). */
  baseTerritory: string;
  /** Every manual-price entry, oldest-startDate first. */
  entries: PriceScheduleEntry[];
}

/**
 * Unpack Apple's price schedule include[] block into a flat array the UI
 * can render. Exported for unit-testing the JSON:API plumbing without a
 * live Apple call.
 *
 * Resolves the manual-price → price-point → territory chain by looking up
 * resources in `included`. Manual-prices Apple didn't include (links-only
 * mode) are skipped — the UI surfaces what we know rather than failing.
 */
export function unpackPriceSchedule(
  res: AscApiResponse<InAppPurchasePriceSchedule>,
): PriceScheduleView {
  const included = res.included ?? [];

  // Index `included` by (type, id) for O(1) lookup. Two resources can
  // share an id across types (Apple's price point id is a base64 blob
  // that doesn't collide with the 3-letter territory codes in practice,
  // but a per-type map is cheap and bulletproof).
  const byType = new Map<string, Map<string, AscResource<string, Record<string, unknown>>>>();
  for (const item of included) {
    let bucket = byType.get(item.type);
    if (!bucket) {
      bucket = new Map();
      byType.set(item.type, bucket);
    }
    bucket.set(item.id, item);
  }

  const priceBucket = byType.get("inAppPurchasePrices");
  const pricePointBucket = byType.get("inAppPurchasePricePoints");

  // Base territory id sits on the schedule's relationships. Defensive
  // fallback to "USA" matches the bulk-import default — every Apple POST
  // we've ever sent uses USA as the base.
  const baseTerritoryRel = (res.data.relationships as
    | { baseTerritory?: { data?: { id?: string } } }
    | undefined)?.baseTerritory?.data?.id;
  const baseTerritory = baseTerritoryRel ?? "USA";

  // manualPrices.data is a JSON:API list of {type, id} pointers; resolve each
  // pointer through the typed buckets above.
  const manualRel = (res.data.relationships as
    | { manualPrices?: { data?: Array<{ id: string }> } }
    | undefined)?.manualPrices?.data ?? [];

  const entries: PriceScheduleEntry[] = [];
  for (const ref of manualRel) {
    const priceRes = priceBucket?.get(ref.id) as
      | InAppPurchasePrice
      | undefined;
    if (!priceRes) continue;
    const pricePointId = (priceRes.relationships as
      | { inAppPurchasePricePoint?: { data?: { id?: string } } }
      | undefined)?.inAppPurchasePricePoint?.data?.id;
    if (!pricePointId) continue;
    const pricePoint = pricePointBucket?.get(pricePointId) as
      | InAppPurchasePricePointResource
      | undefined;
    if (!pricePoint) continue;
    const territoryRel = (pricePoint.relationships as
      | { territory?: { data?: { id?: string } } }
      | undefined)?.territory?.data?.id;
    const territory = (territoryRel as Territory["id"] | undefined) ?? "";
    entries.push({
      priceId: priceRes.id,
      startDate: priceRes.attributes.startDate ?? null,
      endDate: priceRes.attributes.endDate ?? null,
      territory,
      customerPrice: pricePoint.attributes.customerPrice,
      currency: pricePoint.attributes.currency ?? null,
    });
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

  return { baseTerritory, entries };
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
      (res): { ok: true; res: AscApiResponse<InAppPurchasePriceSchedule> } => ({
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
