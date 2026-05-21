import { describe, it, expect } from "vitest";

import {
  computeIapDiff,
  diffSummary,
  type IapStateSnapshot,
} from "./iap-diff";

function snap(
  overrides: Partial<IapStateSnapshot> = {},
): IapStateSnapshot {
  return {
    attributes: {
      purchaseType: "managed",
      status: "active",
      defaultLanguage: "en-US",
      baseCurrency: "USD",
      basePriceMicros: "1990000",
      ...(overrides.attributes ?? {}),
    },
    listings: overrides.listings ?? {
      "en-US": { title: "Small Pack", description: "200 gems" },
    },
    prices: overrides.prices ?? {},
  };
}

describe("computeIapDiff", () => {
  it("returns hasChanges=false when snapshots are identical", () => {
    const before = snap();
    const after = snap();
    const d = computeIapDiff(before, after);
    expect(d.hasChanges).toBe(false);
    expect(d.attributes).toEqual({});
    expect(d.listings.added).toEqual([]);
    expect(d.listings.modified).toEqual([]);
    expect(d.prices.added).toEqual([]);
  });

  it("detects attribute changes (status active → inactive)", () => {
    const before = snap();
    const after = snap({
      attributes: {
        ...before.attributes,
        status: "inactive",
      },
    });
    const d = computeIapDiff(before, after);
    expect(d.hasChanges).toBe(true);
    expect(d.attributes.status).toEqual({
      before: "active",
      after: "inactive",
    });
    expect(d.attributes.purchaseType).toBeUndefined();
  });

  it("normalises currency case so 'usd' vs 'USD' is not a diff", () => {
    const before = snap({
      attributes: {
        purchaseType: "managed",
        status: "active",
        defaultLanguage: "en-US",
        baseCurrency: "usd",
        basePriceMicros: "1990000",
      },
    });
    const after = snap({
      attributes: {
        purchaseType: "managed",
        status: "active",
        defaultLanguage: "en-US",
        baseCurrency: "USD",
        basePriceMicros: "1990000",
      },
    });
    const d = computeIapDiff(before, after);
    expect(d.hasChanges).toBe(false);
  });

  it("detects added + removed + modified listings together", () => {
    const before = snap({
      listings: {
        "en-US": { title: "Pack", description: "Desc" },
        "vi": { title: "Goi", description: "Mo ta" },
      },
    });
    const after = snap({
      listings: {
        "en-US": { title: "Pack Renamed", description: "Desc" },
        "ja": { title: "パック", description: "" },
      },
    });
    const d = computeIapDiff(before, after);
    expect(d.hasChanges).toBe(true);
    expect(d.listings.added).toEqual([
      { locale: "ja", title: "パック", description: "" },
    ]);
    expect(d.listings.removed).toEqual([
      { locale: "vi", title: "Goi", description: "Mo ta" },
    ]);
    expect(d.listings.modified).toHaveLength(1);
    expect(d.listings.modified[0]).toEqual({
      locale: "en-US",
      title: { before: "Pack", after: "Pack Renamed" },
    });
  });

  it("detects added + removed + modified prices together", () => {
    const before = snap({
      prices: {
        US: { currency: "USD", priceMicros: "1990000" },
        JP: { currency: "JPY", priceMicros: "300000000" },
      },
    });
    const after = snap({
      prices: {
        US: { currency: "USD", priceMicros: "2490000" },
        VN: { currency: "VND", priceMicros: "49000000000" },
      },
    });
    const d = computeIapDiff(before, after);
    expect(d.prices.added).toEqual([
      { region: "VN", currency: "VND", priceMicros: "49000000000" },
    ]);
    expect(d.prices.removed).toEqual([
      { region: "JP", currency: "JPY", priceMicros: "300000000" },
    ]);
    expect(d.prices.modified).toEqual([
      {
        region: "US",
        priceMicros: { before: "1990000", after: "2490000" },
      },
    ]);
  });

  it("sorts added/removed/modified lists by key for determinism", () => {
    const before = snap({
      listings: {
        zh: { title: "Z", description: "" },
        ja: { title: "J", description: "" },
      },
    });
    const after = snap({
      listings: {
        ko: { title: "K", description: "" },
        ar: { title: "A", description: "" },
      },
    });
    const d = computeIapDiff(before, after);
    expect(d.listings.added.map((x) => x.locale)).toEqual(["ar", "ko"]);
    expect(d.listings.removed.map((x) => x.locale)).toEqual(["ja", "zh"]);
  });

  it("diffSummary counts every diff bucket", () => {
    const before = snap({
      listings: {
        "en-US": { title: "A", description: "" },
        "vi": { title: "B", description: "" },
      },
      prices: {
        US: { currency: "USD", priceMicros: "1990000" },
      },
    });
    const after = snap({
      attributes: {
        purchaseType: "managed",
        status: "inactive",
        defaultLanguage: "en-US",
        baseCurrency: "USD",
        basePriceMicros: "2490000",
      },
      listings: {
        "en-US": { title: "A1", description: "" },
        "ja": { title: "J", description: "" },
      },
      prices: {
        US: { currency: "USD", priceMicros: "1990000" },
        VN: { currency: "VND", priceMicros: "49000000000" },
      },
    });
    const d = computeIapDiff(before, after);
    const sum = diffSummary(d);
    expect(sum.attributeCount).toBe(2); // status + basePriceMicros
    expect(sum.listingsAdded).toBe(1);
    expect(sum.listingsRemoved).toBe(1);
    expect(sum.listingsModified).toBe(1);
    expect(sum.pricesAdded).toBe(1);
    expect(sum.pricesRemoved).toBe(0);
    expect(sum.pricesModified).toBe(0);
  });
});
