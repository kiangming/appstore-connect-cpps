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
import { updateAppDefaults } from "./apps";

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
  /** NULL = present on Google. Set = flagged deleted-on-Google (soft-delete);
   *  value is the first-detected-missing timestamp. */
  deleted_on_google_at: string | null;
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

export interface IapDetail {
  iap: IapRow;
  listings: IapListingRow[];
  prices: IapPriceRow[];
}

export async function listIapsForApp(appId: string): Promise<IapRow[]> {
  const { data, error } = await googleIapDb()
    .from("iaps")
    .select(
      "id, app_id, sku, purchase_type, status, default_currency, default_price_micros, last_synced_at, deleted_on_google_at, created_at, updated_at",
    )
    .eq("app_id", appId)
    .order("sku", { ascending: true });

  if (error) {
    throw new Error(`Failed to list IAPs: ${error.message}`);
  }
  return (data ?? []) as IapRow[];
}

/**
 * ID-chunk size for `.in("iap_id", …)` filters. supabase-js does NOT chunk
 * `.in()`, so a large id set produces one oversized request whose query
 * string exceeds the Supabase gateway's ~8 KB URI limit → the request
 * errors. At ~200 UUIDs the `.in()` URL stays comfortably under the cap.
 * Shared by both the reads here and the write path's stale-delete so read
 * and write treat large id sets identically.
 */
const ID_IN_CHUNK = 200;

/** PostgREST caps a response at 1000 rows by default. Range-paginate reads
 *  in pages of this size so a large row set is never silently truncated. */
const ROW_PAGE = 1000;

/**
 * Fetch ALL iap_listings rows for the given iap_ids, resilient to scale:
 * id-chunked (so the `.in()` URL never overflows the gateway) AND
 * range-paginated within each chunk (so an id-chunk with >1000 listing
 * rows — many locales × many items — is never truncated at the 1000-row
 * default). Both caps are why the un-chunked read returned empty at ~293
 * items.
 */
async function fetchListingsForIaps(
  iapIds: string[],
): Promise<Array<{ iap_id: string; locale: string; title: string }>> {
  const db = googleIapDb();
  const out: Array<{ iap_id: string; locale: string; title: string }> = [];
  for (const idChunk of chunk(iapIds, ID_IN_CHUNK)) {
    let from = 0;
    for (;;) {
      const { data, error } = await db
        .from("iap_listings")
        .select("iap_id, locale, title")
        .in("iap_id", idChunk)
        .range(from, from + ROW_PAGE - 1);
      if (error) {
        throw new Error(`Failed to load IAP listings: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{
        iap_id: string;
        locale: string;
        title: string;
      }>;
      out.push(...rows);
      if (rows.length < ROW_PAGE) break;
      from += ROW_PAGE;
    }
  }
  return out;
}

/**
 * Load IAPs joined with their default-locale title (en-US first, falling
 * back to whatever the first available locale is). The listings enrichment
 * is id-chunked + row-paginated (see fetchListingsForIaps) so it holds up
 * past the ~200-item / 1000-row caps that previously made the list empty.
 */
export async function listIapsWithDefaultLocale(
  appId: string,
): Promise<IapWithDefaultLocale[]> {
  const iaps = await listIapsForApp(appId);
  if (iaps.length === 0) return [];

  const iapIds = iaps.map((i) => i.id);
  const listings = await fetchListingsForIaps(iapIds);

  const byIap = new Map<string, Array<{ locale: string; title: string }>>();
  for (const r of listings) {
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

/**
 * Load a single IAP joined with all listings + prices. Used by the Edit
 * page to render the form with current state and by the update
 * orchestrator to construct the "before" diff snapshot.
 */
export async function getIapDetail(
  appId: string,
  sku: string,
): Promise<IapDetail | null> {
  const db = googleIapDb();

  const { data: iapRow, error: iapErr } = await db
    .from("iaps")
    .select(
      "id, app_id, sku, purchase_type, status, default_currency, default_price_micros, last_synced_at, deleted_on_google_at, created_at, updated_at",
    )
    .eq("app_id", appId)
    .eq("sku", sku)
    .maybeSingle();

  if (iapErr) {
    throw new Error(`Failed to load IAP ${sku}: ${iapErr.message}`);
  }
  if (!iapRow) return null;
  const iap = iapRow as IapRow;

  const [{ data: listings, error: listErr }, { data: prices, error: priceErr }] =
    await Promise.all([
      db
        .from("iap_listings")
        .select("id, iap_id, locale, title, description")
        .eq("iap_id", iap.id)
        .order("locale", { ascending: true }),
      db
        .from("iap_prices")
        .select("id, iap_id, region_code, currency, price_micros")
        .eq("iap_id", iap.id)
        .order("region_code", { ascending: true }),
    ]);

  if (listErr) {
    throw new Error(`Failed to load listings for ${sku}: ${listErr.message}`);
  }
  if (priceErr) {
    throw new Error(`Failed to load prices for ${sku}: ${priceErr.message}`);
  }

  return {
    iap,
    listings: (listings ?? []) as IapListingRow[],
    prices: (prices ?? []) as IapPriceRow[],
  };
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
        // A single-item sync means we just pulled/pushed this item live on
        // Google — it exists there, so clear any stale deleted-on-Google flag
        // (self-corrects a re-created SKU without waiting for a full refresh).
        deleted_on_google_at: null,
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

/* ──────────────────────────────────────────────────────────────────────
 *  Bulk list-refresh (part 1 of the >1000-item "Failed to fetch" fix).
 *
 *  The old batch path ran syncIapFromGoogle sequentially per product —
 *  ~5 Supabase round-trips each (upsert iaps + delete/insert listings +
 *  delete/insert prices). At Google's 1000-IAP-per-app ceiling that is
 *  ~5,000 sequential round-trips (~2-5 min), exceeding the platform
 *  request timeout → the browser's ambiguous "Failed to fetch".
 *
 *  This path collapses that to a few dozen set-wide operations:
 *    1. Bulk-UPSERT all iaps (onConflict app_id,sku), chunked.
 *    2. For listings + prices, bulk-UPSERT the current rows FIRST
 *       (onConflict iap_id,locale / iap_id,region_code), THEN delete only
 *       the stale rows left behind. Upserting-before-deleting is the
 *       safety property: an item's current prices/listings are written and
 *       confirmed BEFORE anything is removed, so no failure path can leave
 *       an item with deleted-but-not-reinserted prices. A failed upsert
 *       chunk marks those items failed and EXCLUDES them from the delete
 *       pass, so their existing rows are never touched.
 *
 *  Stale detection is clock-safe: `syncFloor` is the minimum updated_at
 *  RETURNED by this run's upserts (a DB-generated value), and stale rows
 *  are those with updated_at strictly below it — a DB-value vs DB-value
 *  comparison, immune to app/DB clock skew. Every row upserted this run
 *  has updated_at >= syncFloor, so a current row is never deleted; only
 *  rows untouched this run (removed regions/locales, or an item that now
 *  has none) fall below the floor. Strict `<` errs toward keeping rows.
 * ──────────────────────────────────────────────────────────────────── */

const IAP_UPSERT_CHUNK = 500;
const CHILD_UPSERT_CHUNK = 1000;

function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface ChildRow {
  iap_id: string;
  [key: string]: string;
}

/**
 * Replace all child rows (listings or prices) for the given set of clean
 * iap_ids using upsert-then-delete-stale. `rows` is the full current set
 * across all items. Any iap_id whose upsert chunk fails is reported via
 * onFail and dropped from the delete pass (its existing rows stay intact).
 */
async function replaceChildRows(opts: {
  db: ReturnType<typeof googleIapDb>;
  table: "iap_listings" | "iap_prices";
  cleanIapIds: string[];
  rows: ChildRow[];
  conflict: string;
  onFail: (iapId: string) => void;
}): Promise<void> {
  const { db, table, cleanIapIds, rows, conflict, onFail } = opts;

  // 1. Upsert current rows first — confirmed before any delete.
  let syncFloor: string | null = null;
  const failedUpsert = new Set<string>();
  for (const rowChunk of chunk(rows, CHILD_UPSERT_CHUNK)) {
    const { data, error } = await db
      .from(table)
      .upsert(rowChunk, { onConflict: conflict })
      .select("iap_id, updated_at");
    if (error) {
      for (const r of rowChunk) {
        failedUpsert.add(r.iap_id);
        onFail(r.iap_id);
      }
      console.error(
        `[google-iap:iap-sync] ${table} upsert chunk failed: ${error.message.replace(/"/g, "'")}`,
      );
      continue;
    }
    for (const row of (data ?? []) as Array<{ updated_at: string }>) {
      const u = row.updated_at;
      if (syncFloor === null || u < syncFloor) syncFloor = u;
    }
  }

  // 2. Delete stale rows only for items whose upsert fully succeeded, so a
  //    failed item's existing rows are never removed.
  const deletableIds = cleanIapIds.filter((id) => !failedUpsert.has(id));
  if (deletableIds.length === 0) return;

  for (const idChunk of chunk(deletableIds, ID_IN_CHUNK)) {
    // syncFloor === null → nothing was upserted this run (every item's
    // current set is empty), so clear all their child rows.
    const query =
      syncFloor === null
        ? db.from(table).delete().in("iap_id", idChunk)
        : db.from(table).delete().in("iap_id", idChunk).lt("updated_at", syncFloor);
    const { error } = await query;
    if (error) {
      for (const id of idChunk) onFail(id);
      console.error(
        `[google-iap:iap-sync] ${table} stale-delete chunk failed: ${error.message.replace(/"/g, "'")}`,
      );
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────
 *  Soft-delete flagging: items in the cache but absent from Google.
 *
 *  Items deleted/renamed on the Play Console linger in the cache forever
 *  (the upsert never removes them). Instead of hard-deleting on sync — a
 *  degraded fetch could then wipe the live catalog — the reconcile FLAGS
 *  absent items (deleted_on_google_at = now) so they stay visible and are
 *  removed only by explicit Manager acknowledge-remove.
 *
 *  Self-correcting: a flagged SKU that reappears in Google's response is
 *  un-flagged; a still-missing flagged SKU keeps its ORIGINAL detection
 *  date (we never overwrite an existing timestamp).
 * ──────────────────────────────────────────────────────────────────── */

/** Existing cache flag state for one app, paginated (an app can exceed the
 *  1000-row default once orphans accumulate). */
async function listIapFlagState(
  appId: string,
): Promise<Array<{ id: string; sku: string; deleted_on_google_at: string | null }>> {
  const db = googleIapDb();
  const out: Array<{ id: string; sku: string; deleted_on_google_at: string | null }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("iaps")
      .select("id, sku, deleted_on_google_at")
      .eq("app_id", appId)
      .range(from, from + ROW_PAGE - 1);
    if (error) throw new Error(`Failed to load IAP flag state: ${error.message}`);
    const rows = (data ?? []) as Array<{
      id: string;
      sku: string;
      deleted_on_google_at: string | null;
    }>;
    out.push(...rows);
    if (rows.length < ROW_PAGE) break;
    from += ROW_PAGE;
  }
  return out;
}

export interface FlagReconcileResult {
  flagged: number;
  unflagged: number;
  flaggedSkus: string[];
  unflaggedSkus: string[];
  /** Set when the anomaly guard skipped reconcile — no flag changes made. */
  skippedReason: string | null;
}

/** Fraction of the cached count below which an incoming set is treated as a
 *  degraded fetch and flag-reconcile is skipped (protects the warning's
 *  credibility — a partial fetch must not flag the whole catalog). */
const FLAG_MIN_INCOMING_FRACTION = 0.5;

/**
 * Reconcile the deleted-on-Google flag for one app against the SKUs Google
 * returned this sync. ANOMALY-GUARDED: skips all flag changes (and says why)
 * on any degraded-fetch signal, so a bad fetch never spuriously flags live
 * items. Upserts have already run; only the flag reconcile is gated here.
 */
export async function reconcileDeletedOnGoogle(args: {
  appId: string;
  incomingSkus: string[];
  /** True if EVERY product in the fetch carried a SKU (no missing-SKU rows). */
  allProductsHadSku: boolean;
  /** True if the list fetch completed (not partial/errored). */
  fetchComplete: boolean;
  now: string;
}): Promise<FlagReconcileResult> {
  const { appId, incomingSkus, allProductsHadSku, fetchComplete, now } = args;
  const empty: FlagReconcileResult = {
    flagged: 0,
    unflagged: 0,
    flaggedSkus: [],
    unflaggedSkus: [],
    skippedReason: null,
  };

  const cached = await listIapFlagState(appId);
  const cachedCount = cached.length;
  const incomingSet = new Set(incomingSkus);

  // ── Anomaly guard — skip flag-reconcile on any degraded-fetch signal ──
  let skip: string | null = null;
  if (!fetchComplete) skip = "fetch_incomplete";
  else if (incomingSkus.length === 0) skip = "empty_response";
  else if (!allProductsHadSku) skip = "product_missing_sku";
  else if (
    cachedCount > 0 &&
    incomingSkus.length < cachedCount * FLAG_MIN_INCOMING_FRACTION
  ) {
    skip = `incoming_below_${Math.round(FLAG_MIN_INCOMING_FRACTION * 100)}pct_of_cached`;
  }
  if (skip) {
    console.warn(
      `[google-iap:flag-reconcile] SKIPPED appId=${appId} reason=${skip} incoming=${incomingSkus.length} cached=${cachedCount} — no items flagged`,
    );
    return { ...empty, skippedReason: skip };
  }

  // Absent from Google + not already flagged → flag (preserve any existing
  // detection date by only touching rows where the flag is currently NULL).
  const toFlag = cached.filter(
    (c) => !incomingSet.has(c.sku) && c.deleted_on_google_at === null,
  );
  // Reappeared on Google while flagged → clear (self-correcting un-delete).
  const toUnflag = cached.filter(
    (c) => incomingSet.has(c.sku) && c.deleted_on_google_at !== null,
  );

  const db = googleIapDb();
  for (const idChunk of chunk(toFlag.map((c) => c.id), ID_IN_CHUNK)) {
    const { error } = await db
      .from("iaps")
      .update({ deleted_on_google_at: now })
      .in("id", idChunk);
    if (error) {
      console.error(
        `[google-iap:flag-reconcile] flag chunk failed appId=${appId}: ${error.message.replace(/"/g, "'")}`,
      );
    }
  }
  for (const idChunk of chunk(toUnflag.map((c) => c.id), ID_IN_CHUNK)) {
    const { error } = await db
      .from("iaps")
      .update({ deleted_on_google_at: null })
      .in("id", idChunk);
    if (error) {
      console.error(
        `[google-iap:flag-reconcile] unflag chunk failed appId=${appId}: ${error.message.replace(/"/g, "'")}`,
      );
    }
  }

  return {
    flagged: toFlag.length,
    unflagged: toUnflag.length,
    flaggedSkus: toFlag.map((c) => c.sku),
    unflaggedSkus: toUnflag.map((c) => c.sku),
    skippedReason: null,
  };
}

/**
 * Of the given SKUs for one app, return the subset that is currently flagged
 * deleted-on-Google. Used to EXCLUDE flagged items from push operations
 * (activate/deactivate) — acting on an item gone from Google would error.
 */
export async function listFlaggedSkusAmong(
  appId: string,
  skus: readonly string[],
): Promise<Set<string>> {
  const flagged = new Set<string>();
  if (skus.length === 0) return flagged;
  const db = googleIapDb();
  for (const skuChunk of chunk(skus as string[], ID_IN_CHUNK)) {
    const { data, error } = await db
      .from("iaps")
      .select("sku")
      .eq("app_id", appId)
      .not("deleted_on_google_at", "is", null)
      .in("sku", skuChunk);
    if (error) throw new Error(`Failed to check flagged SKUs: ${error.message}`);
    for (const row of (data ?? []) as Array<{ sku: string }>) flagged.add(row.sku);
  }
  return flagged;
}

/**
 * Acknowledge + hard-remove flagged (deleted-on-Google) items from the
 * cache. Guarded: deletes ONLY rows that are actually flagged
 * (deleted_on_google_at IS NOT NULL) for this app — a present-on-Google
 * item can never be acknowledge-removed. Children cascade via FK. Returns
 * the SKUs actually removed (for the audit entry).
 */
export async function acknowledgeRemoveIaps(
  appId: string,
  skus: string[],
): Promise<{ removed: string[] }> {
  if (skus.length === 0) return { removed: [] };
  const db = googleIapDb();
  const removed: string[] = [];
  for (const skuChunk of chunk(skus, ID_IN_CHUNK)) {
    const { data, error } = await db
      .from("iaps")
      .delete()
      .eq("app_id", appId)
      .not("deleted_on_google_at", "is", null) // only flagged rows
      .in("sku", skuChunk)
      .select("sku");
    if (error) {
      throw new Error(`Failed to remove flagged IAPs: ${error.message}`);
    }
    for (const row of (data ?? []) as Array<{ sku: string }>) removed.push(row.sku);
  }
  return { removed };
}

/**
 * Bulk-sync a batch of IAPs from a Publisher API list response. Returns
 * per-item { synced, failed } counts plus flag-reconcile counts (all for
 * the audit log). A failed chunk taints only the items in it; siblings
 * still sync. The final DB state is equivalent to the old per-item
 * delete-then-insert loop, produced with a few dozen round-trips.
 *
 * Safety: current listings/prices are upserted (and confirmed) before any
 * stale row is deleted, so no failure path strips an item's prices.
 *
 * Soft-delete: after child replace, reconcileDeletedOnGoogle flags items
 * absent from Google (anomaly-guarded — a degraded fetch flags nothing).
 * Pass fetchComplete=false to suppress flagging when the caller knows the
 * list fetch was partial.
 *
 * Hotfix 4: opportunistically write the app's default_currency +
 * default_language from the first product that carries both. Google
 * enforces app-wide defaults, so every IAP under an app shares the
 * same pair — sampling the first one is sufficient and gives ground
 * truth that overrides any inference made during apps refresh.
 */
export async function batchSyncIapsFromGoogle(
  appId: string,
  products: InAppProduct[],
  options: { fetchComplete?: boolean } = {},
): Promise<{
  synced: number;
  failed: number;
  flagReconcile: FlagReconcileResult;
}> {
  const db = googleIapDb();
  const now = new Date().toISOString();
  const fetchComplete = options.fetchComplete ?? true;

  // Products without a sku can't be synced — count as failed up front.
  const withSku = products.filter(
    (p): p is InAppProduct & { sku: string } => Boolean(p.sku),
  );
  let noSkuFailures = 0;
  for (const p of products) {
    if (!p.sku) {
      noSkuFailures += 1;
      console.error(`[google-iap:iap-sync] skipped product without sku`);
    }
  }

  const failedSkus = new Set<string>();
  const iapIdToSku = new Map<string, string>();
  const failByIapId = (iapId: string) => {
    const sku = iapIdToSku.get(iapId);
    if (sku) failedSkus.add(sku);
  };

  // ── Phase 1: bulk upsert iaps, resolve sku → id ──
  const iapRows = withSku.map((product) => ({
    app_id: appId,
    sku: product.sku,
    purchase_type: mapPurchaseType(product.purchaseType),
    status: mapStatus(product.status),
    default_currency: product.defaultPrice?.currency ?? null,
    default_price_micros: product.defaultPrice?.priceMicros ?? null,
    last_synced_at: now,
  }));

  const skuToIapId = new Map<string, string>();
  for (const rowChunk of chunk(iapRows, IAP_UPSERT_CHUNK)) {
    const { data, error } = await db
      .from("iaps")
      .upsert(rowChunk, { onConflict: "app_id,sku" })
      .select("id, sku");
    if (error) {
      for (const r of rowChunk) failedSkus.add(r.sku);
      console.error(
        `[google-iap:iap-sync] iaps upsert chunk failed: ${error.message.replace(/"/g, "'")}`,
      );
      continue;
    }
    for (const row of (data ?? []) as Array<{ id: string; sku: string }>) {
      skuToIapId.set(row.sku, row.id);
      iapIdToSku.set(row.id, row.sku);
    }
  }

  // Items whose iap row resolved and haven't already failed are "clean".
  const cleanIapIds: string[] = [];
  const listingRows: ChildRow[] = [];
  const priceRows: ChildRow[] = [];
  for (const product of withSku) {
    const iapId = skuToIapId.get(product.sku);
    if (!iapId || failedSkus.has(product.sku)) continue;
    cleanIapIds.push(iapId);

    if (product.listings) {
      for (const [locale, l] of Object.entries(product.listings)) {
        listingRows.push({
          iap_id: iapId,
          locale,
          title: l.title ?? "",
          description: l.description ?? "",
        });
      }
    }
    if (product.prices) {
      for (const [region, p] of Object.entries(product.prices)) {
        if (p?.priceMicros && p?.currency) {
          priceRows.push({
            iap_id: iapId,
            region_code: region,
            currency: p.currency,
            price_micros: p.priceMicros,
          });
        }
      }
    }
  }

  // ── Phase 2: replace listings + prices (upsert-then-delete-stale) ──
  await replaceChildRows({
    db,
    table: "iap_listings",
    cleanIapIds,
    rows: listingRows,
    conflict: "iap_id,locale",
    onFail: failByIapId,
  });
  await replaceChildRows({
    db,
    table: "iap_prices",
    cleanIapIds,
    rows: priceRows,
    conflict: "iap_id,region_code",
    onFail: failByIapId,
  });

  // ── Accounting: per-item synced/failed (audit-log fidelity) ──
  let failed = noSkuFailures;
  for (const product of withSku) {
    if (!skuToIapId.has(product.sku) || failedSkus.has(product.sku)) failed += 1;
  }
  const synced = products.length - failed;

  // ── Soft-delete reconcile: flag items absent from Google (anomaly-guarded).
  //    Runs after child replace so the current catalog is fully written first.
  const flagReconcile = await reconcileDeletedOnGoogle({
    appId,
    incomingSkus: withSku.map((p) => p.sku),
    allProductsHadSku: noSkuFailures === 0,
    fetchComplete,
    now,
  });

  // Capture app-level defaults from the first IAP that carries them.
  const sample = products.find(
    (p) => p.defaultPrice?.currency || p.defaultLanguage,
  );
  if (sample) {
    try {
      await updateAppDefaults(appId, {
        currency: sample.defaultPrice?.currency ?? null,
        language: sample.defaultLanguage ?? null,
      });
    } catch (err) {
      // Non-fatal — the cache row still has the IAPs synced, just
      // without updated app defaults. Log for visibility.
      console.error(
        `[google-iap:iap-sync] app_defaults_capture_failed appId=${appId} err="${err instanceof Error ? err.message.replace(/"/g, "'") : String(err)}"`,
      );
    }
  }

  return { synced, failed, flagReconcile };
}
