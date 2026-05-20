/**
 * IAPs repository — Google Play in-app products cache.
 *
 * On list refresh, we replace listings + prices for each IAP (delete +
 * insert) rather than UPSERT, since Manager may remove a locale or
 * region between syncs. The top-level iaps row itself is UPSERTed.
 *
 * For v1 we only handle managed products (Q-GIAP.A); subscriptions are
 * a separate resource (monetization.subscriptions) deferred to v2.
 */
import { googleIapDb } from "../db";
import type { InAppProduct } from "../google/publisher-client";

export type PurchaseType = "managed" | "consumable" | "subscription";
export type IapStatus = "active" | "inactive";

export interface IapRow {
  id: string;
  app_id: string;
  sku: string;
  purchase_type: PurchaseType;
  status: IapStatus;
  default_currency: string | null;
  default_price_micros: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IapListingRow {
  id: string;
  iap_id: string;
  locale: string;
  title: string;
  description: string;
}

export interface IapPriceRow {
  id: string;
  iap_id: string;
  region_code: string;
  currency: string;
  price_micros: string;
}

export interface IapWithDefaultLocale extends IapRow {
  default_title: string | null;
}

export async function listIapsForApp(appId: string): Promise<IapRow[]> {
  const { data, error } = await googleIapDb()
    .from("iaps")
    .select(
      "id, app_id, sku, purchase_type, status, default_currency, default_price_micros, last_synced_at, created_at, updated_at",
    )
    .eq("app_id", appId)
    .order("sku", { ascending: true });

  if (error) {
    throw new Error(`Failed to list IAPs: ${error.message}`);
  }
  return (data ?? []) as IapRow[];
}

/**
 * Load IAPs joined with their default-locale title (en-US first, falling
 * back to whatever the first available locale is). One round-trip per page.
 */
export async function listIapsWithDefaultLocale(
  appId: string,
): Promise<IapWithDefaultLocale[]> {
  const iaps = await listIapsForApp(appId);
  if (iaps.length === 0) return [];

  const iapIds = iaps.map((i) => i.id);
  const { data: listings, error } = await googleIapDb()
    .from("iap_listings")
    .select("iap_id, locale, title")
    .in("iap_id", iapIds);

  if (error) {
    throw new Error(`Failed to load IAP listings: ${error.message}`);
  }

  const byIap = new Map<string, Array<{ locale: string; title: string }>>();
  for (const row of listings ?? []) {
    const r = row as { iap_id: string; locale: string; title: string };
    const list = byIap.get(r.iap_id) ?? [];
    list.push({ locale: r.locale, title: r.title });
    byIap.set(r.iap_id, list);
  }

  return iaps.map((iap) => {
    const list = byIap.get(iap.id) ?? [];
    const enUs = list.find((l) => l.locale === "en-US");
    const fallback = list[0];
    return {
      ...iap,
      default_title: enUs?.title ?? fallback?.title ?? null,
    };
  });
}

function mapPurchaseType(googlePurchaseType: string | null | undefined): PurchaseType {
  // Google's API enum: 'managedUser' for managed products, 'subscription'
  // for subs. Manager UI v1 treats all managedUser as 'managed' — consumable
  // is a client-side behavior, not API-distinguishable. Subscriptions land
  // in Phase 2 (Q-GIAP.A defers).
  if (googlePurchaseType === "subscription") return "subscription";
  return "managed";
}

function mapStatus(googleStatus: string | null | undefined): IapStatus {
  return googleStatus === "active" ? "active" : "inactive";
}

/**
 * Replace cached state for one IAP — top-level UPSERT + listings/prices
 * delete-then-insert. Used by the IAPs list refresh handler.
 *
 * Not transactional (supabase-js doesn't expose transactions cleanly).
 * Partial-failure recovery = the next refresh re-runs the same logic.
 */
export async function syncIapFromGoogle(
  appId: string,
  product: InAppProduct,
): Promise<void> {
  if (!product.sku) {
    throw new Error("Cannot sync IAP without sku.");
  }
  const db = googleIapDb();

  const { data: upserted, error: upsertErr } = await db
    .from("iaps")
    .upsert(
      {
        app_id: appId,
        sku: product.sku,
        purchase_type: mapPurchaseType(product.purchaseType),
        status: mapStatus(product.status),
        default_currency: product.defaultPrice?.currency ?? null,
        default_price_micros: product.defaultPrice?.priceMicros ?? null,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "app_id,sku" },
    )
    .select("id")
    .single();

  if (upsertErr) {
    throw new Error(`Failed to upsert IAP ${product.sku}: ${upsertErr.message}`);
  }
  const iapId = (upserted as { id: string }).id;

  // Listings — replace all.
  await db.from("iap_listings").delete().eq("iap_id", iapId);
  if (product.listings && Object.keys(product.listings).length > 0) {
    const listingRows = Object.entries(product.listings).map(([locale, l]) => ({
      iap_id: iapId,
      locale,
      title: l.title ?? "",
      description: l.description ?? "",
    }));
    const { error: listErr } = await db.from("iap_listings").insert(listingRows);
    if (listErr) {
      throw new Error(`Failed to insert listings for ${product.sku}: ${listErr.message}`);
    }
  }

  // Prices — replace all.
  await db.from("iap_prices").delete().eq("iap_id", iapId);
  if (product.prices && Object.keys(product.prices).length > 0) {
    const priceRows = Object.entries(product.prices)
      .filter(([, p]) => p?.priceMicros && p?.currency)
      .map(([region, p]) => ({
        iap_id: iapId,
        region_code: region,
        currency: p.currency!,
        price_micros: p.priceMicros!,
      }));
    if (priceRows.length > 0) {
      const { error: priceErr } = await db.from("iap_prices").insert(priceRows);
      if (priceErr) {
        throw new Error(`Failed to insert prices for ${product.sku}: ${priceErr.message}`);
      }
    }
  }
}

/**
 * Sequentially sync a batch of IAPs from a Publisher API list response.
 * Returns { synced, failed } counts; failed IAPs surface their errors
 * in the per-sku log line but don't abort the batch.
 */
export async function batchSyncIapsFromGoogle(
  appId: string,
  products: InAppProduct[],
): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  for (const product of products) {
    try {
      await syncIapFromGoogle(appId, product);
      synced += 1;
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[google-iap:iap-sync] sku=${product.sku ?? "?"} err="${msg.replace(/"/g, "'")}"`,
      );
    }
  }
  return { synced, failed };
}
