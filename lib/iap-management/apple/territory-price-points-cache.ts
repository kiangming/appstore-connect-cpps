/**
 * Per-orchestration cache for Apple's per-territory price-point catalog
 * (IAP.p1.e).
 *
 * Apple's `/v2/inAppPurchases/{appleIapId}/pricePoints?filter[territory]=X`
 * endpoint scopes results to a single IAP. Different IAPs return different
 * opaque `price_point_id` values for the same (territory, customerPrice)
 * pair — so this cache is intentionally per-IAP per-orchestration scope.
 * No sharing across IAPs is possible.
 *
 * Bulk-import processes IAPs in a loop where each row constructs its own
 * cache via `createTerritoryPricePointsCache()`. Within a single
 * orchestration, the cache amortises repeated territory lookups when the
 * template references the same territory across multiple tiers (rare for
 * single-IAP, but the cache is cheap so we keep it).
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  listPricePointsForIap,
  type InAppPurchasePricePoint,
} from "./price-points";

export interface TerritoryPricePointsCache {
  /**
   * Look up — and lazily fetch — the price-point list for `territory` on the
   * given Apple IAP. Subsequent calls for the same territory hit the cache.
   */
  get(territory: string): Promise<InAppPurchasePricePoint[]>;
  /**
   * Inject pre-fetched price points (e.g. USA fetched earlier in the
   * orchestration) so the template path doesn't re-fetch them.
   */
  prime(territory: string, points: InAppPurchasePricePoint[]): void;
  /**
   * Snapshot of how many territories have been fetched — surfaced in audit
   * logs so Manager can see the orchestration cost.
   */
  size(): number;
}

export function createTerritoryPricePointsCache(
  creds: AscCredentials,
  appleIapId: string,
): TerritoryPricePointsCache {
  const cache = new Map<string, InAppPurchasePricePoint[]>();
  const inflight = new Map<string, Promise<InAppPurchasePricePoint[]>>();

  return {
    async get(territory) {
      const cached = cache.get(territory);
      if (cached) return cached;
      const pending = inflight.get(territory);
      if (pending) return pending;
      const fetchPromise = listPricePointsForIap(creds, appleIapId, territory)
        .then((points) => {
          cache.set(territory, points);
          inflight.delete(territory);
          return points;
        })
        .catch((err) => {
          inflight.delete(territory);
          throw err;
        });
      inflight.set(territory, fetchPromise);
      return fetchPromise;
    },
    prime(territory, points) {
      cache.set(territory, points);
    },
    size() {
      return cache.size;
    },
  };
}
