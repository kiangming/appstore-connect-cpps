/**
 * Pure IAP state diff utility for g1.h Edit workflow.
 *
 * Used by:
 *   - UpdateChangesPreviewModal (client) — visualise the pending diff before
 *     the Manager confirms a Google Play patch.
 *   - update-iap orchestrator (server) — record before/after in the
 *     IAP_UPDATE audit payload.
 *
 * Design constraints:
 *   - Pure: no React, no DB, no I/O. Importable from both client and server.
 *   - Symmetric: snapshots are constructed from the same shape on both sides.
 *     The "before" snapshot is built from cache rows; "after" comes from the
 *     form (decimal → micros conversion happens BEFORE snapshot construction
 *     to keep comparison apples-to-apples).
 *   - Currency comparisons are case-insensitive and the diff normalises to
 *     uppercase before comparing (Google sometimes lowercases inbound).
 */

export interface IapAttributesSnapshot {
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string;
  baseCurrency: string;
  basePriceMicros: string;
}

export interface IapListingSnapshot {
  title: string;
  description: string;
}

export interface IapPriceSnapshot {
  currency: string;
  priceMicros: string;
}

export interface IapStateSnapshot {
  attributes: IapAttributesSnapshot;
  listings: Record<string, IapListingSnapshot>;
  prices: Record<string, IapPriceSnapshot>;
}

export interface ScalarChange<T = string> {
  before: T;
  after: T;
}

export interface AttributeChanges {
  purchaseType?: ScalarChange;
  status?: ScalarChange;
  defaultLanguage?: ScalarChange;
  baseCurrency?: ScalarChange;
  basePriceMicros?: ScalarChange;
}

export interface ListingDiffEntry {
  locale: string;
  title?: ScalarChange;
  description?: ScalarChange;
}

export interface ListingsDiff {
  added: Array<{ locale: string; title: string; description: string }>;
  removed: Array<{ locale: string; title: string; description: string }>;
  modified: ListingDiffEntry[];
}

export interface PriceDiffEntry {
  region: string;
  currency?: ScalarChange;
  priceMicros?: ScalarChange;
}

export interface PricesDiff {
  added: Array<{ region: string; currency: string; priceMicros: string }>;
  removed: Array<{ region: string; currency: string; priceMicros: string }>;
  modified: PriceDiffEntry[];
}

export interface IapDiff {
  hasChanges: boolean;
  attributes: AttributeChanges;
  listings: ListingsDiff;
  prices: PricesDiff;
}

function normCurrency(c: string): string {
  return c.trim().toUpperCase();
}

function attrDiff(
  before: IapAttributesSnapshot,
  after: IapAttributesSnapshot,
): AttributeChanges {
  const changes: AttributeChanges = {};
  if (before.purchaseType !== after.purchaseType) {
    changes.purchaseType = {
      before: before.purchaseType,
      after: after.purchaseType,
    };
  }
  if (before.status !== after.status) {
    changes.status = { before: before.status, after: after.status };
  }
  if (before.defaultLanguage !== after.defaultLanguage) {
    changes.defaultLanguage = {
      before: before.defaultLanguage,
      after: after.defaultLanguage,
    };
  }
  if (normCurrency(before.baseCurrency) !== normCurrency(after.baseCurrency)) {
    changes.baseCurrency = {
      before: before.baseCurrency,
      after: after.baseCurrency,
    };
  }
  if (before.basePriceMicros !== after.basePriceMicros) {
    changes.basePriceMicros = {
      before: before.basePriceMicros,
      after: after.basePriceMicros,
    };
  }
  return changes;
}

function listingsDiff(
  before: Record<string, IapListingSnapshot>,
  after: Record<string, IapListingSnapshot>,
): ListingsDiff {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  const added: ListingsDiff["added"] = [];
  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) {
      const v = after[k];
      added.push({ locale: k, title: v.title, description: v.description });
    }
  }

  const removed: ListingsDiff["removed"] = [];
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) {
      const v = before[k];
      removed.push({ locale: k, title: v.title, description: v.description });
    }
  }

  const modified: ListingDiffEntry[] = [];
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) continue;
    const b = before[k];
    const a = after[k];
    const entry: ListingDiffEntry = { locale: k };
    if (b.title !== a.title) entry.title = { before: b.title, after: a.title };
    if (b.description !== a.description) {
      entry.description = { before: b.description, after: a.description };
    }
    if (entry.title || entry.description) modified.push(entry);
  }

  // Stable order by locale for deterministic UI + audit payloads.
  added.sort((x, y) => x.locale.localeCompare(y.locale));
  removed.sort((x, y) => x.locale.localeCompare(y.locale));
  modified.sort((x, y) => x.locale.localeCompare(y.locale));

  return { added, removed, modified };
}

function pricesDiff(
  before: Record<string, IapPriceSnapshot>,
  after: Record<string, IapPriceSnapshot>,
): PricesDiff {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  const added: PricesDiff["added"] = [];
  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) {
      const v = after[k];
      added.push({
        region: k,
        currency: v.currency,
        priceMicros: v.priceMicros,
      });
    }
  }

  const removed: PricesDiff["removed"] = [];
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) {
      const v = before[k];
      removed.push({
        region: k,
        currency: v.currency,
        priceMicros: v.priceMicros,
      });
    }
  }

  const modified: PriceDiffEntry[] = [];
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) continue;
    const b = before[k];
    const a = after[k];
    const entry: PriceDiffEntry = { region: k };
    if (normCurrency(b.currency) !== normCurrency(a.currency)) {
      entry.currency = { before: b.currency, after: a.currency };
    }
    if (b.priceMicros !== a.priceMicros) {
      entry.priceMicros = { before: b.priceMicros, after: a.priceMicros };
    }
    if (entry.currency || entry.priceMicros) modified.push(entry);
  }

  added.sort((x, y) => x.region.localeCompare(y.region));
  removed.sort((x, y) => x.region.localeCompare(y.region));
  modified.sort((x, y) => x.region.localeCompare(y.region));

  return { added, removed, modified };
}

export function computeIapDiff(
  before: IapStateSnapshot,
  after: IapStateSnapshot,
): IapDiff {
  const attributes = attrDiff(before.attributes, after.attributes);
  const listings = listingsDiff(before.listings, after.listings);
  const prices = pricesDiff(before.prices, after.prices);

  const hasChanges =
    Object.keys(attributes).length > 0 ||
    listings.added.length > 0 ||
    listings.removed.length > 0 ||
    listings.modified.length > 0 ||
    prices.added.length > 0 ||
    prices.removed.length > 0 ||
    prices.modified.length > 0;

  return { hasChanges, attributes, listings, prices };
}

/** Summary counts useful for audit payloads + Manager-facing toasts. */
export function diffSummary(diff: IapDiff): {
  attributeCount: number;
  listingsAdded: number;
  listingsRemoved: number;
  listingsModified: number;
  pricesAdded: number;
  pricesRemoved: number;
  pricesModified: number;
} {
  return {
    attributeCount: Object.keys(diff.attributes).length,
    listingsAdded: diff.listings.added.length,
    listingsRemoved: diff.listings.removed.length,
    listingsModified: diff.listings.modified.length,
    pricesAdded: diff.prices.added.length,
    pricesRemoved: diff.prices.removed.length,
    pricesModified: diff.prices.modified.length,
  };
}
