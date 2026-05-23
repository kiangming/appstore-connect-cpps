/**
 * Cycle 37 Phase 1 — Apple In-App Purchase Availabilities client.
 *
 * Unblocks IAP-MANAGEMENT-KNOWLEDGE-BASE §10.4 deferred item:
 * `availableInAllTerritories` is NOT a field on InAppPurchaseV2 — Apple
 * exposes territory selection through a separate resource type. The
 * Manager's "All countries or regions" radio in Apple Connect web maps
 * to:
 *
 *   POST /v1/inAppPurchaseAvailabilities
 *     attributes: { availableInNewTerritories: true }
 *     relationships:
 *       inAppPurchase:        { data: { type: inAppPurchases, id } }
 *       availableTerritories: { data: [ { type: territories, id: USA }, ... ] }
 *
 * The `availableInNewTerritories: true` flag tells Apple to auto-include
 * future Apple-launched markets — when paired with the full current
 * territory list it expresses the "All" semantic Manager picked in Q1.A.
 *
 * Read path: GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability returns
 * the linked availability resource. The full territory list arrives via
 * the relationship; use `include=availableTerritories` to inline it.
 *
 * Per Q5.A there is no migration — existing IAPs surface their actual
 * Apple-side state (likely "no availability resource" for pre-Cycle-37
 * IAPs, which we render as "Removed from Sale").
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { iapFetch } from "./fetch";
import type {
  AscApiResponse,
  AscResource,
  Territory,
} from "@/types/iap-management/apple";

/** Apple's availability resource shape. */
export interface InAppPurchaseAvailabilityAttributes {
  availableInNewTerritories: boolean;
}
export type InAppPurchaseAvailability = AscResource<
  "inAppPurchaseAvailabilities",
  InAppPurchaseAvailabilityAttributes
>;

/**
 * GET /v1/territories — lists every territory Apple sells IAPs to (~175).
 * The result feeds both the POST-availabilities body ("All territories"
 * needs the full list) and the View Detail count denominator.
 *
 * Page size 200 covers Apple's current territory count with room to grow;
 * if Apple ever exceeds 200 we'll iterate `links.next` (same pattern as
 * `listAllInAppPurchases`).
 */
export async function listTerritories(
  creds: AscCredentials,
): Promise<AscApiResponse<Territory[]>> {
  return iapFetch<AscApiResponse<Territory[]>>(
    creds,
    "GET",
    "/v1/territories?limit=200",
  );
}

/**
 * Per-process territory-list cache. The list changes at human cadence
 * (Apple-launched markets are a quarterly-at-most event) and a single
 * orchestration may call this from 2-3 distinct code paths (create →
 * availability → bulk-import per row). Mirrors the spirit of
 * `territory-price-points-cache.ts` — in-memory, lazy, no eviction
 * (process restart = fresh fetch).
 */
let cachedTerritoryIds: { ids: string[]; fetchedAt: number } | null = null;
const TERRITORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getAllTerritoryIds(
  creds: AscCredentials,
): Promise<string[]> {
  const now = Date.now();
  if (
    cachedTerritoryIds &&
    now - cachedTerritoryIds.fetchedAt < TERRITORY_CACHE_TTL_MS
  ) {
    return cachedTerritoryIds.ids;
  }
  const res = await listTerritories(creds);
  const ids = res.data.map((t) => t.id);
  cachedTerritoryIds = { ids, fetchedAt: now };
  return ids;
}

/** Test-only escape hatch — reset the in-memory cache between specs. */
export function __resetTerritoryCacheForTests(): void {
  cachedTerritoryIds = null;
}

/**
 * POST /v1/inAppPurchaseAvailabilities — assign the IAP to every
 * Apple-supported territory + flag it to auto-include any new ones.
 * Apple's API has no `availableInAllTerritories` boolean; "All
 * territories" is expressed as (full list) + (new-territories flag).
 *
 * NB: Apple's API does not expose a PATCH on this resource — re-POST is
 * the standard "replace" path. For Phase 1 we only ever call this when
 * Manager wants "All" so the no-PATCH limitation doesn't bind us.
 */
export async function setAvailabilityToAllTerritories(
  creds: AscCredentials,
  appleIapId: string,
): Promise<AscApiResponse<InAppPurchaseAvailability>> {
  const territoryIds = await getAllTerritoryIds(creds);
  return iapFetch<AscApiResponse<InAppPurchaseAvailability>>(
    creds,
    "POST",
    "/v1/inAppPurchaseAvailabilities",
    {
      data: {
        type: "inAppPurchaseAvailabilities",
        attributes: {
          availableInNewTerritories: true,
        },
        relationships: {
          inAppPurchase: {
            data: { type: "inAppPurchases", id: appleIapId },
          },
          availableTerritories: {
            data: territoryIds.map((id) => ({ type: "territories", id })),
          },
        },
      },
    },
  );
}

/**
 * GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability — the linked
 * availability resource, with the territory list inlined via `include`.
 * Returns null when Apple responds 404 (no availability resource exists
 * — the empty / "Removed from Sale" case the View Detail surfaces).
 */
export interface AvailabilityForIap {
  availableInNewTerritories: boolean;
  territoryCount: number;
  territoryIds: string[];
}

export async function getAvailabilityForIap(
  creds: AscCredentials,
  appleIapId: string,
): Promise<AvailabilityForIap | null> {
  let res: AscApiResponse<InAppPurchaseAvailability>;
  try {
    res = await iapFetch<AscApiResponse<InAppPurchaseAvailability>>(
      creds,
      "GET",
      `/v2/inAppPurchases/${appleIapId}/inAppPurchaseAvailability?include=availableTerritories&limit[availableTerritories]=200`,
    );
  } catch (err) {
    // AppleApiError with status 404 → no availability resource. Other
    // errors propagate so the caller can decide whether to render an
    // error card or swallow per-section.
    if (isApple404(err)) return null;
    throw err;
  }
  const attrs = res.data.attributes ?? { availableInNewTerritories: false };
  const territoryIds = collectIncludedTerritoryIds(res);
  return {
    availableInNewTerritories: attrs.availableInNewTerritories === true,
    territoryCount: territoryIds.length,
    territoryIds,
  };
}

function isApple404(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 404;
}

/** Pure helper exported for unit-testing. Pulls the territory ids out of
 *  the JSON:API `included` array. Apple's response carries one Territory
 *  resource per available market when the include query is set. */
export function collectIncludedTerritoryIds(
  res: AscApiResponse<InAppPurchaseAvailability>,
): string[] {
  const included = (res as unknown as { included?: Array<{ type?: string; id?: string }> })
    .included;
  if (!Array.isArray(included)) return [];
  return included
    .filter((r) => r && r.type === "territories" && typeof r.id === "string")
    .map((r) => r.id as string);
}
