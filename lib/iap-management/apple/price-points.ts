/**
 * Apple price-point lookup (IAP.o.9a).
 *
 * Apple scopes price points per-IAP — there is no per-app endpoint that lists
 * the full price catalog. So this module wraps:
 *
 *   GET /v2/inAppPurchases/{appleIapId}/pricePoints?filter[territory]=USA
 *
 * and exposes a helper that filters the response by `priceTier` to find the
 * Apple-side id corresponding to a local `tier_id` ("TIER_5", "TIER_10",
 * "FREE", "ALT_*").
 *
 * The price-point id is an opaque base64 string — never parse it. Apple
 * documents it as stable per IAP + territory, but generated fresh per IAP.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import { iapFetch, withRetry } from "./fetch";
import type { AscApiResponse } from "@/types/iap-management/apple";

export interface InAppPurchasePricePoint {
  type: "inAppPurchasePricePoints";
  id: string;
  attributes: {
    customerPrice: string;
    proceeds: string;
    priceTier?: string;
  };
}

/**
 * Fetch ALL price points for a given IAP + territory, following Apple's
 * `links.next` pagination until exhausted. USA is the documented base
 * territory; equivalents in other territories are auto-calculated server-side
 * when a price schedule is set.
 *
 * Returns the accumulated `data` array (links/meta are intentionally dropped
 * because they describe a single page).
 */
export async function listPricePointsForIap(
  creds: AscCredentials,
  appleIapId: string,
  territory = "USA",
): Promise<InAppPurchasePricePoint[]> {
  const accumulated: InAppPurchasePricePoint[] = [];
  // IAP.o.11a: bumped limit 200→1000. OpenAPI spec allows up to 8000
  // (docs/iap-management/openapi.oas.json:152835) and Apple's USA catalog
  // is ~600 price points, so 1000 should fit in one page with headroom.
  // links.next follow remains for future-proofing.
  let next: string | undefined =
    `/v2/inAppPurchases/${appleIapId}/pricePoints?filter[territory]=${territory}&limit=1000`;
  let pageCount = 0;
  while (next) {
    const path = next;
    pageCount += 1;
    const page = await withRetry(() =>
      iapFetch<AscApiResponse<InAppPurchasePricePoint[]>>(creds, "GET", path),
    );
    const rows = page.data?.length ?? 0;
    console.log(
      `[price-points] fetched page=${pageCount} apple_iap_id=${appleIapId} territory=${territory} rows=${rows}`,
    );
    if (page.data && page.data.length > 0) {
      accumulated.push(...(page.data as InAppPurchasePricePoint[]));
    }
    next = extractNextPagePath(page.links?.next);
  }
  console.log(
    `[price-points] total apple_iap_id=${appleIapId} territory=${territory} pages=${pageCount} count=${accumulated.length}`,
  );
  return accumulated;
}

function extractNextPagePath(nextUrl: string | undefined): string | undefined {
  if (!nextUrl) return undefined;
  try {
    const url = new URL(nextUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

/**
 * Map a USA/USD customer price (e.g. 0.99) to the Apple-side price-point id
 * by matching the `customerPrice` attribute (IAP.o.10a).
 *
 * This is the canonical matcher — Apple's `priceTier` attribute changed
 * numbering scheme in 2024 (developer forum thread 728081: tiers "1,2,3..."
 * → "10000,10001,..." silently rolled out, with legacy IAPs still on the
 * old numbering). `customerPrice` is stable across the rollover.
 *
 * Returns `null` when no price point matches — callers must surface this
 * loudly. Silent fallthrough means the IAP ships to Apple with no price,
 * which was the IAP.o.9 → IAP.o.10 root cause.
 *
 * Float comparison: Apple returns `customerPrice` as a string ("0.99",
 * "1.99"). Convert to Number and compare with a small epsilon to defeat
 * IEEE-754 rounding (0.1 + 0.2 ≠ 0.3 etc.) — Apple's prices are 2-decimal,
 * so 0.001 is safe.
 */
export function findPricePointByUsdPrice(
  pricePoints: InAppPurchasePricePoint[],
  usdPrice: number | null | undefined,
): InAppPurchasePricePoint | null {
  if (usdPrice === null || usdPrice === undefined || !Number.isFinite(usdPrice)) {
    return null;
  }
  for (const pp of pricePoints) {
    const candidate = Number(pp.attributes.customerPrice);
    if (Number.isFinite(candidate) && Math.abs(candidate - usdPrice) < 0.001) {
      return pp;
    }
  }
  return null;
}

/**
 * Legacy: map a local `tier_id` to the Apple-side price-point id by matching
 * the `priceTier` attribute. Kept for tests + fallback callers but the
 * canonical matcher is `findPricePointByUsdPrice` after IAP.o.10a — Apple
 * changed the priceTier numbering scheme in 2024 (forum thread 728081),
 * breaking the IAP.o.9a tier-id match strategy.
 */
export function findPricePointByTier(
  pricePoints: InAppPurchasePricePoint[],
  localTierId: string | null | undefined,
): InAppPurchasePricePoint | null {
  if (!localTierId) return null;
  const target = normalizeLocalTierId(localTierId);
  if (target === null) return null;
  for (const pp of pricePoints) {
    if (pp.attributes.priceTier === target) {
      return pp;
    }
  }
  return null;
}

/**
 * Strip the local-format prefix and return the integer-string Apple uses for
 * `priceTier`. Returns `null` when the local id is unparseable so the caller
 * can skip the lookup cleanly.
 */
function normalizeLocalTierId(localTierId: string): string | null {
  const upper = localTierId.toUpperCase().trim();
  if (upper === "FREE") return "0";
  if (upper.startsWith("TIER_")) return upper.slice("TIER_".length);
  if (upper.startsWith("ALT_")) return upper.slice("ALT_".length);
  // Bare integer string ("5", "10") — accept as-is.
  if (/^\d+$/.test(upper)) return upper;
  return null;
}
