/**
 * Donor-IAP resolution for the custom-price picker (design gate G2, J-1).
 *
 * Apple has NO non-IAP-scoped price-point list endpoint — verified against both
 * OpenAPI specs (v4.3.1 and v4.4.1): every read of the IAP price catalog needs
 * either an existing IAP id or an existing price-point id, and
 * `/v1/apps/{id}/appPricePoints` is a different resource type (a paid app's own
 * price) whose ids `inAppPurchasePriceSchedules` will not accept.
 *
 * But the catalog itself is GLOBAL. `(territory, customerPrice) → tier` is
 * identical across every IAP; only the opaque per-IAP id differs, and that id is
 * a deterministic function of (iapId, territory, tier) — price-point-id.ts:1-27,
 * batch-price-point-catalog.ts:1-32, KB §10.13.I. So the LIST OF PRICES Apple
 * offers in a territory can be read through ANY synced IAP, and the picker only
 * ever needs prices: ids are resolved server-side at submit from the price.
 *
 * ⚠ J-1 — WHAT WE DO NOT DO. With no synced IAP anywhere in the app, the picker
 * is disabled with the reason shown. We do NOT fall back to
 * `price_tier_territories`: that table is a Manager-uploaded CSV
 * (price-tiers.ts:295-421), superseded as the pricing source of truth
 * (templates.ts:11-13), carries ~96 prices per territory against Apple's ~600,
 * and can name prices Apple has no point for — which is exactly the existing
 * `missing_price_points` / `partial-template-fail` outcome. A picker built on it
 * would offer the Manager choices guaranteed to fail at submit. An honest
 * dead-end beats a working-looking control that silently drops the value.
 */
import { iapDb } from "@/lib/iap-management/db";
import type { InAppPurchaseType } from "@/types/iap-management/apple";

export interface PricePointDonor {
  /** The Apple IAP id to read the catalog through. */
  appleIapId: string;
  /** Our internal row id, for logging. */
  iapId: string;
  /** Whether the donor's type matches the requesting IAP's. */
  sameType: boolean;
}

/**
 * Find an IAP in `appId` (internal `iap_mgmt.apps.id`) that is already on Apple
 * and can lend its price-point catalog.
 *
 * Prefers a donor of the same `type`. That preference is defensive rather than
 * proven: `batch-price-point-catalog.ts:29-31` keys its cache by IAP type
 * because "We cannot prove the catalogs are identical across types". If they
 * are identical the preference costs nothing; if they are not, we avoid showing
 * a subscription's ladder for a consumable.
 *
 * Returns null when the app has no synced IAP at all — the J-1 disabled state.
 *
 * `excludeIapId` skips the IAP being edited when it is itself unsynced; when it
 * IS synced the caller uses it directly and never gets here.
 */
export async function findPricePointDonor(args: {
  appId: string;
  type?: InAppPurchaseType | string | null;
  excludeIapId?: string;
}): Promise<PricePointDonor | null> {
  const res = await iapDb()
    .from("iaps")
    .select("id, apple_iap_id, type")
    .eq("app_id", args.appId)
    .not("apple_iap_id", "is", null)
    .order("synced_at", { ascending: false });
  if (res.error) {
    throw new Error(`Donor IAP lookup failed for app ${args.appId}: ${res.error.message}`);
  }

  const rows = ((res.data ?? []) as Array<{
    id: string;
    apple_iap_id: string | null;
    type: string | null;
  }>).filter((r) => r.apple_iap_id && r.id !== args.excludeIapId);

  if (rows.length === 0) return null;

  const sameType = args.type ? rows.find((r) => r.type === args.type) : undefined;
  const chosen = sameType ?? rows[0];
  return {
    appleIapId: chosen.apple_iap_id!,
    iapId: chosen.id,
    sameType: Boolean(args.type) && chosen.type === args.type,
  };
}

/**
 * The catalog source for one IAP: itself when synced, else a donor.
 * `null` means the picker must be disabled (J-1).
 */
export async function resolvePricePointSource(args: {
  iapId: string;
  appId: string;
  appleIapId: string | null;
  type?: InAppPurchaseType | string | null;
}): Promise<PricePointDonor | null> {
  if (args.appleIapId) {
    return { appleIapId: args.appleIapId, iapId: args.iapId, sameType: true };
  }
  return findPricePointDonor({
    appId: args.appId,
    type: args.type,
    excludeIapId: args.iapId,
  });
}
