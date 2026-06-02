/**
 * Batch-level Apple price-point catalog (Cycle 44).
 *
 * Problem: a 500-item bulk import previously re-fetched the per-territory
 * price-point catalog for EVERY item (~175 territory GETs/item ⇒ ~87,500
 * calls, far over Apple's ~3,600/hr limit). The catalog's
 * (territory, customerPrice) → tier mapping is Apple's GLOBAL catalog —
 * identical across every IAP in the batch; only the per-IAP `price_point_id`
 * differs, and that id is a deterministic function of (iapId, territory,
 * tier) (see price-point-id.ts).
 *
 * This catalog fetches each (iapType, territory) pair ONCE for the whole
 * batch, then serves every subsequent item from cache, deriving each item's
 * own price-point id with zero extra fetches.
 *
 * SCOPE-PRESERVING: this module changes only HOW/WHEN price-point DATA is
 * fetched. Price SELECTION (customerPrice matching) stays in the orchestrator
 * and is byte-for-byte unchanged — the catalog returns the same point objects
 * (identical customerPrice values); only the matched id is derived per item.
 *
 * SAFETY: on the first fetch of each (type, territory) the catalog verifies
 * Apple's id encoding round-trips (`pricePointIdRoundTrips`). If ANY point
 * fails the guard (Apple changed the encoding), derivation is disabled for the
 * rest of the batch and every territory request falls back to a fresh per-IAP
 * fetch — i.e. the exact pre-optimization behavior. A derived id is never
 * shipped unverified.
 *
 * KEYED BY IAP TYPE: the catalog could in principle differ by IAP type
 * (CONSUMABLE / NON_CONSUMABLE / NON_RENEWING_SUBSCRIPTION). We cannot prove
 * the catalogs are identical across types, so the cache is keyed by
 * `${iapType}::${territory}` and warmed (and guard-verified) per type.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  listPricePointsForIap,
  type InAppPurchasePricePoint,
} from "./price-points";
import { pricePointIdRoundTrips, derivePricePointId } from "./price-point-id";

export interface TerritoryPoints {
  /** Apple price points for the requested territory. customerPrice values are
   *  catalog-global; ids belong to whichever IAP first warmed this territory
   *  (irrelevant to matching, which is by customerPrice). */
  points: InAppPurchasePricePoint[];
  /** Map a price point's (warm-IAP) id to the requesting IAP's id. When
   *  derivation is disabled (guard failed → fresh per-IAP fetch), this is the
   *  identity function because `points` already carry the requester's ids. */
  deriveId: (warmId: string) => string;
}

export interface BatchPricePointCatalog {
  /**
   * Return the price points for (iapType, territory) plus an id-mapper for
   * `appleIapId`. Fetches Apple once per (iapType, territory) for the whole
   * batch; subsequent calls reuse the cached catalog. May throw if the
   * underlying Apple fetch throws (caller handles, same as a direct fetch).
   */
  territory(
    appleIapId: string,
    iapType: string,
    territory: string,
  ): Promise<TerritoryPoints>;
  /** Observability for the audit log / Railway tail. */
  stats(): {
    territoriesWarmed: number;
    fetches: number;
    derivationEnabled: boolean;
  };
}

export function createBatchPricePointCatalog(
  creds: AscCredentials,
): BatchPricePointCatalog {
  const warm = new Map<string, InAppPurchasePricePoint[]>();
  const inflight = new Map<string, Promise<InAppPurchasePricePoint[] | null>>();
  let derivationEnabled = true;
  let fetches = 0;

  function fetchTerritory(
    iap: string,
    territory: string,
  ): Promise<InAppPurchasePricePoint[]> {
    fetches += 1;
    return listPricePointsForIap(creds, iap, territory);
  }

  const identity = (id: string) => id;
  const deriverFor = (appleIapId: string) => (id: string) =>
    derivePricePointId(id, appleIapId) ?? id;

  return {
    async territory(appleIapId, iapType, territory) {
      const key = `${iapType}::${territory}`;

      // Fallback mode: behave exactly like the pre-optimization per-item path
      // — fresh fetch for THIS IAP, ids already correct, no cross-item reuse.
      if (!derivationEnabled) {
        const points = await fetchTerritory(appleIapId, territory);
        return { points, deriveId: identity };
      }

      const cached = warm.get(key);
      if (cached) {
        return { points: cached, deriveId: deriverFor(appleIapId) };
      }

      // First requester for this key warms the cache (deduping concurrent
      // first-fetches so two parallel workers don't double-fetch).
      let pending = inflight.get(key);
      if (!pending) {
        pending = (async () => {
          const points = await fetchTerritory(appleIapId, territory);
          // GUARD: verify Apple's id encoding is the {s,t,p} form we
          // reproduce, on real Apple data, before trusting any derivation.
          const guardOk = points.every((pp) => pricePointIdRoundTrips(pp.id));
          if (!guardOk) {
            derivationEnabled = false;
            console.warn(
              `[batch-price-points] id-derivation guard FAILED on ${key} ` +
                `(Apple id encoding not {s,t,p}) — falling back to per-item ` +
                `fetch for the rest of the batch`,
            );
            return null; // signal: do not cache, do not derive
          }
          warm.set(key, points);
          console.log(
            `[batch-price-points] warmed ${key} count=${points.length} ` +
              `(fetched once for the batch)`,
          );
          return points;
        })();
        inflight.set(key, pending);
        void pending.finally(() => inflight.delete(key));
      }

      const result = await pending;
      if (result === null) {
        // Guard failed during warm: serve the requester a fresh per-IAP fetch
        // (its own ids), and from now on every call takes the fallback branch.
        const points = await fetchTerritory(appleIapId, territory);
        return { points, deriveId: identity };
      }
      return { points: result, deriveId: deriverFor(appleIapId) };
    },
    stats() {
      return {
        territoriesWarmed: warm.size,
        fetches,
        derivationEnabled,
      };
    },
  };
}
