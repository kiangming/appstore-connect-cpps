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
  let next: string | undefined =
    `/v2/inAppPurchases/${appleIapId}/pricePoints?filter[territory]=${territory}&limit=200`;
  while (next) {
    const path = next;
    const page = await withRetry(() =>
      iapFetch<AscApiResponse<InAppPurchasePricePoint[]>>(creds, "GET", path),
    );
    if (page.data && page.data.length > 0) {
      accumulated.push(...(page.data as InAppPurchasePricePoint[]));
    }
    next = extractNextPagePath(page.links?.next);
  }
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
 * Map a local `tier_id` (`"TIER_5"`, `"TIER_10"`, `"FREE"`, `"ALT_1"`) to the
 * Apple-side price-point id by matching the `priceTier` attribute Apple
 * surfaces on each price point.
 *
 * Returns `null` when no price point matches — callers should surface this as
 * a non-fatal warning ("price not set; check Apple Connect"), NOT fail the
 * whole orchestration. Apple's defaults will leave the IAP in
 * MISSING_METADATA until the price is set manually.
 *
 * Edge cases:
 * - `FREE` → matches `priceTier === "0"` (Apple's free tier).
 * - `ALT_*` (alternate tier set) → behavior depends on whether Apple returns
 *   the alt tier in the same priceTier integer space. Strip the `ALT_` prefix
 *   and match against the integer string; if Apple uses a different format
 *   the lookup will simply miss and surface as "price not set" — Manager can
 *   then set it manually via Apple Connect for that single row.
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
