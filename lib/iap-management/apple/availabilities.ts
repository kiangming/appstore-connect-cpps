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
 * Cycle 39 Phase 1 — "Remove from Sales" via re-POST with empty territory
 * list. Apple's API has no DELETE or PATCH on the availability resource
 * (verified against `/v1/inAppPurchaseAvailabilities` + `/{id}` operations
 * in openapi.oas.json — only POST + GET exist), so the only path to
 * "available in zero territories" is a fresh POST that replaces the prior
 * availability snapshot.
 *
 * Payload shape mirrors `setAvailabilityToAllTerritories` exactly except
 * `availableInNewTerritories: false` + `availableTerritories.data: []`.
 * The OpenAPI schema (InAppPurchaseAvailabilityCreateRequest) requires the
 * relationship object + `data` array, but imposes no `minItems`, so an
 * empty array satisfies the contract.
 *
 * Apple Connect web UI's "Remove from Sale" action surfaces the same
 * semantic — once submitted, the IAP isn't sold in any territory.
 */
export async function setAvailabilityRemoveFromSales(
  creds: AscCredentials,
  appleIapId: string,
): Promise<AscApiResponse<InAppPurchaseAvailability>> {
  return iapFetch<AscApiResponse<InAppPurchaseAvailability>>(
    creds,
    "POST",
    "/v1/inAppPurchaseAvailabilities",
    {
      data: {
        type: "inAppPurchaseAvailabilities",
        attributes: {
          availableInNewTerritories: false,
        },
        relationships: {
          inAppPurchase: {
            data: { type: "inAppPurchases", id: appleIapId },
          },
          availableTerritories: {
            data: [],
          },
        },
      },
    },
  );
}

/**
 * Read the IAP's availability — Hotfix 22: V1 sub-resource pattern.
 *
 * Apple's V2 `?include=availableTerritories` path that Cycle 37 Phase 1
 * shipped failed in production with `400 PARAMETER_ERROR.INVALID: The
 * maximum allowable limit is '50'` against `limit[availableTerritories]`.
 * V2 endpoints cap the per-relationship include pagination at 50; the
 * tool requested 200 (the main-resource limit) which Apple rejects
 * outright instead of clamping. The V2 include path also suffers from
 * the documented 10-ID relationship-truncation trap
 * (IAP-MANAGEMENT-KNOWLEDGE-BASE §4.1 LANDMARK Trap class 1) — even at
 * `limit=50` Apple may return a truncated list.
 *
 * Fix: split into the canonical "metadata then sub-resource" pattern:
 *   Step A: GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability
 *     → availability id + availableInNewTerritories
 *   Step B: GET /v1/inAppPurchaseAvailabilities/{availabilityId}/availableTerritories?limit=200
 *     → full territory list, cursor-paginated via `links.next` (Hotfix 20
 *       pattern reuse).
 *
 * Two HTTP calls per detail-view render is acceptable (Server Component;
 * Manager-tolerable latency); the V1 sub-resource endpoint honours the
 * 200 page size + supports `links.next` so even a hypothetical future
 * 250-territory Apple inventory paginates cleanly.
 *
 * Returns null when Step A responds 404 (no availability resource yet —
 * the "Removed from Sale" surface). Step B is best-effort: if it fails
 * the function still returns the metadata with an empty territory list
 * so the caller renders "0 of M" instead of a hard error.
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
  // ── Step A — metadata only.
  let metaRes: AscApiResponse<InAppPurchaseAvailability>;
  try {
    metaRes = await iapFetch<AscApiResponse<InAppPurchaseAvailability>>(
      creds,
      "GET",
      `/v2/inAppPurchases/${appleIapId}/inAppPurchaseAvailability`,
    );
  } catch (err) {
    if (isApple404(err)) return null;
    throw err;
  }
  const availabilityId = metaRes.data.id;
  const availableInNewTerritories =
    metaRes.data.attributes?.availableInNewTerritories === true;

  // ── Step B — paginate the territory list via the V1 sub-resource.
  const territoryIds: string[] = [];
  let cursor: string | null =
    `/v1/inAppPurchaseAvailabilities/${availabilityId}/availableTerritories?limit=200`;
  try {
    while (cursor) {
      const page = await iapFetch<TerritoryListResponse>(creds, "GET", cursor);
      for (const t of page.data ?? []) {
        if (t && t.type === "territories" && typeof t.id === "string") {
          territoryIds.push(t.id);
        }
      }
      cursor = nextCursorFrom(page);
    }
  } catch {
    // Step A succeeded so the metadata is real; surface what we have
    // (the count will read as 0 in the section, which the caller already
    // handles as a degenerate "subset" state).
  }

  return {
    availableInNewTerritories,
    territoryCount: territoryIds.length,
    territoryIds,
  };
}

interface TerritoryListResponse {
  data: Array<{ type?: string; id?: string }>;
  links?: { next?: string | null };
}

/** Convert Apple's absolute `links.next` URL into a relative path
 *  `iapFetch` accepts (we strip the host so the fetch wrapper can stay
 *  base-URL-agnostic). Mirrors the Hotfix 20 pagination cursor pattern. */
export function nextCursorFrom(page: TerritoryListResponse): string | null {
  const next = page.links?.next;
  if (!next) return null;
  // `next` arrives absolute; strip scheme + host so iapFetch can prepend
  // the base URL itself (its endpoint param expects a leading slash).
  const match = /^https?:\/\/[^/]+(\/.*)$/.exec(next);
  return match ? match[1] : next;
}

function isApple404(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 404;
}
