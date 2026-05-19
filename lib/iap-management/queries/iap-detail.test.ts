/**
 * splitIncluded — partition Apple's `included` array into typed buckets.
 *
 * Pure helper extracted from the route layer so the JSON:API unpacking
 * can be exercised without mocking `getInAppPurchase`. Covers the empty,
 * locs-only, screenshot-only, and mixed cases plus the defensive null
 * fallback when Apple returns no `included` block.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Apple client modules so getIapViewData can be driven without
// hitting the network. Hoisted so the imports below see the mocked symbols.
const getInAppPurchase = vi.hoisted(() => vi.fn());
const getPriceScheduleForIap = vi.hoisted(() => vi.fn());

vi.mock("@/lib/iap-management/apple/client", () => ({
  getInAppPurchase,
}));
vi.mock("@/lib/iap-management/apple/price-schedules", () => ({
  getPriceScheduleForIap,
}));
vi.mock("@/lib/iap-management/apple/fetch", () => ({
  AppleApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, _m: string, _e: string, body: string) {
      super(body);
      this.status = status;
      this.body = body;
    }
  },
}));

import {
  splitIncluded,
  unpackPriceSchedule,
  getIapViewData,
} from "./iap-detail";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import type {
  AscApiResponse,
  InAppPurchase,
  InAppPurchasePriceSchedule,
} from "@/types/iap-management/apple";

function baseIap(): InAppPurchase {
  return {
    type: "inAppPurchases",
    id: "apple-1",
    attributes: {
      name: "Diamond Pack",
      productId: "com.x.diamond",
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_FOR_SALE",
    },
  };
}

describe("splitIncluded", () => {
  it("returns iap + empty localizations + null screenshot when no included", () => {
    const res: AscApiResponse<InAppPurchase> = { data: baseIap() };
    const out = splitIncluded(res);
    expect(out.iap.id).toBe("apple-1");
    expect(out.localizations).toEqual([]);
    expect(out.screenshot).toBeNull();
  });

  it("collects only inAppPurchaseLocalizations entries", () => {
    const res: AscApiResponse<InAppPurchase> = {
      data: baseIap(),
      included: [
        {
          type: "inAppPurchaseLocalizations",
          id: "loc-en",
          attributes: { locale: "en-US", name: "Diamonds" },
        },
        {
          type: "inAppPurchaseLocalizations",
          id: "loc-vi",
          attributes: { locale: "vi", name: "Kim cương" },
        },
      ],
    };
    const out = splitIncluded(res);
    expect(out.localizations).toHaveLength(2);
    expect(out.localizations.map((l) => l.id)).toEqual(["loc-en", "loc-vi"]);
    expect(out.screenshot).toBeNull();
  });

  it("captures the screenshot entry separately from localizations", () => {
    const res: AscApiResponse<InAppPurchase> = {
      data: baseIap(),
      included: [
        {
          type: "inAppPurchaseAppStoreReviewScreenshots",
          id: "scr-1",
          attributes: {
            fileName: "diamond.png",
            fileSize: 4096,
          },
        },
      ],
    };
    const out = splitIncluded(res);
    expect(out.screenshot?.id).toBe("scr-1");
    expect(out.localizations).toEqual([]);
  });

  it("partitions a mixed `included` array correctly", () => {
    const res: AscApiResponse<InAppPurchase> = {
      data: baseIap(),
      included: [
        {
          type: "inAppPurchaseLocalizations",
          id: "loc-en",
          attributes: { locale: "en-US", name: "Diamonds" },
        },
        {
          type: "inAppPurchaseAppStoreReviewScreenshots",
          id: "scr-1",
          attributes: { fileName: "x.png", fileSize: 100 },
        },
        {
          type: "inAppPurchaseLocalizations",
          id: "loc-vi",
          attributes: { locale: "vi", name: "Kim cương" },
        },
      ],
    };
    const out = splitIncluded(res);
    expect(out.localizations).toHaveLength(2);
    expect(out.screenshot?.id).toBe("scr-1");
  });

  it("ignores unknown resource types in `included`", () => {
    const res: AscApiResponse<InAppPurchase> = {
      data: baseIap(),
      included: [
        {
          type: "someOtherUnrelatedType",
          id: "other-1",
          attributes: {},
        },
      ],
    };
    const out = splitIncluded(res);
    expect(out.localizations).toEqual([]);
    expect(out.screenshot).toBeNull();
  });
});

// ─── IAP.p2.a — Price schedule unpack ────────────────────────────────────────

/**
 * Test-fixture builder mirroring Apple's actual JSON:API shape per
 * IAP.p2.k corrections:
 *   - InAppPurchasePrice has its OWN `relationships.territory` (Apple
 *     side-loads it via Stage 2/3 `?include=…,territory`).
 *   - Territory resources carry `attributes.currency` (per OpenAPI
 *     `fields[territories]: [currency]`).
 *   - InAppPurchasePricePoint has NO `currency` attribute and NO
 *     `relationships.territory.data` side-loaded (per OpenAPI
 *     `fields[inAppPurchasePricePoints]: [customerPrice, proceeds,
 *     territory, equalizations]` — `territory` here is a field selector
 *     not a side-load).
 */
/**
 * IAP.p2.l fixture: returns the bare AscApiResponse shape that
 * `getPriceScheduleForIap` now produces post-Stage-3 removal.
 *
 * Shape mirrors Apple's actual JSON:API (verified against the iris-API
 * ground truth Manager pulled from Apple Connect Web in MV30 UAT):
 *   - InAppPurchasePrice has its OWN `relationships.territory`
 *   - Territory resources carry `attributes.currency`
 *   - InAppPurchasePricePoint has NO `currency` (Apple stores it on
 *     Territory, not on the price point — IAP.p2.k FIX B)
 */
function priceScheduleResponse(opts: {
  baseTerritory?: string;
  manualPrices?: Array<{
    priceId: string;
    pricePointId: string;
    territory: string;
    customerPrice: string;
    currency?: string;
    startDate?: string | null;
    endDate?: string | null;
  }>;
}): AscApiResponse<InAppPurchasePriceSchedule> {
  const manuals = opts.manualPrices ?? [];
  const included: AscApiResponse<InAppPurchasePriceSchedule>["included"] = [];
  const seenTerritories = new Set<string>();
  for (const m of manuals) {
    included.push({
      type: "inAppPurchasePrices",
      id: m.priceId,
      attributes: {
        startDate: m.startDate ?? null,
        ...(m.endDate !== undefined ? { endDate: m.endDate } : {}),
      },
      relationships: {
        inAppPurchasePricePoint: {
          data: { type: "inAppPurchasePricePoints", id: m.pricePointId },
        },
        territory: { data: { type: "territories", id: m.territory } },
      },
    });
    included.push({
      type: "inAppPurchasePricePoints",
      id: m.pricePointId,
      attributes: {
        customerPrice: m.customerPrice,
        proceeds: "0.7",
      },
    });
    if (m.currency && !seenTerritories.has(m.territory)) {
      seenTerritories.add(m.territory);
      included.push({
        type: "territories",
        id: m.territory,
        attributes: { currency: m.currency },
      });
    }
  }
  return {
    data: {
      type: "inAppPurchasePriceSchedules",
      id: "sched-1",
      attributes: {},
      relationships: {
        baseTerritory: {
          data: { type: "territories", id: opts.baseTerritory ?? "USA" },
        },
        manualPrices: {
          data: manuals.map((m) => ({
            type: "inAppPurchasePrices",
            id: m.priceId,
          })),
        },
      },
    } as unknown as InAppPurchasePriceSchedule,
    included,
  };
}

describe("unpackPriceSchedule", () => {
  it("returns the base territory + empty entries when no manualPrices", () => {
    const out = unpackPriceSchedule(priceScheduleResponse({}));
    expect(out.baseTerritory).toBe("USA");
    expect(out.entries).toEqual([]);
  });

  it("resolves each manualPrice → price-point → territory chain", () => {
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        manualPrices: [
          {
            priceId: "p-1",
            pricePointId: "pp-usa-99",
            territory: "USA",
            customerPrice: "0.99",
            currency: "USD",
          },
        ],
      }),
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      priceId: "p-1",
      territory: "USA",
      customerPrice: "0.99",
      currency: "USD",
      startDate: null,
      endDate: null,
    });
  });

  it("sorts entries by startDate ASC with effective-now (null) first", () => {
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        manualPrices: [
          {
            priceId: "p-future",
            pricePointId: "pp-vnm-129",
            territory: "VNM",
            customerPrice: "29000",
            startDate: "2026-06-01",
          },
          {
            priceId: "p-now-jpn",
            pricePointId: "pp-jpn-150",
            territory: "JPN",
            customerPrice: "150",
            startDate: null,
          },
          {
            priceId: "p-now-usa",
            pricePointId: "pp-usa-99",
            territory: "USA",
            customerPrice: "0.99",
            startDate: null,
          },
        ],
      }),
    );
    // effective-now first, alphabetical territory within the null bucket
    expect(out.entries.map((e) => e.territory)).toEqual(["JPN", "USA", "VNM"]);
  });

  it("skips manualPrices whose price-point isn't in `included` (links-only)", () => {
    const res = priceScheduleResponse({
      manualPrices: [
        {
          priceId: "p-1",
          pricePointId: "pp-usa-99",
          territory: "USA",
          customerPrice: "0.99",
        },
      ],
    });
    // simulate Apple returning the price resource but not the price point
    res.included = res.included!.filter(
      (r) => r.type !== "inAppPurchasePricePoints",
    );
    const out = unpackPriceSchedule(res);
    expect(out.entries).toEqual([]);
  });

  it("falls back to USA when baseTerritory relationship is missing", () => {
    const res = priceScheduleResponse({});
    delete (res.data.relationships as { baseTerritory?: unknown }).baseTerritory;
    expect(unpackPriceSchedule(res).baseTerritory).toBe("USA");
  });

  it("renders all manualPrices from included even when Stage 1's manualRel is short (IAP.p2.m)", () => {
    // Manager UAT MV30 Railway logs: Apple's V2
    // `?include=manualPrices` returned 10 ids; Stage 2 returned 12. The
    // unpacker iterates Stage 2's data (priceBucket) — NOT Stage 1's
    // manualRel — so the missing 2 are not silently dropped.
    const res = priceScheduleResponse({
      manualPrices: [
        {
          priceId: "p-usa",
          pricePointId: "pp-usa",
          territory: "USA",
          customerPrice: "2.99",
          currency: "USD",
        },
        {
          priceId: "p-vn",
          pricePointId: "pp-vn",
          territory: "VNM",
          customerPrice: "89000",
          currency: "VND",
        },
        {
          priceId: "p-jp",
          pricePointId: "pp-jp",
          territory: "JPN",
          customerPrice: "300",
          currency: "JPY",
        },
      ],
    });
    // Simulate Apple's V2 truncation: only the first manualPrice id is
    // listed in the relationship enumeration. The other 2 are still in
    // `included[]` (Stage 2's merged data).
    (res.data.relationships as {
      manualPrices?: { data?: Array<{ id: string }> };
    }).manualPrices = {
      data: [{ id: "p-usa" }],
    };

    const out = unpackPriceSchedule(res);
    expect(out.entries).toHaveLength(3);
    expect(out.entries.map((e) => e.territory).sort()).toEqual([
      "JPN",
      "USA",
      "VNM",
    ]);
  });

  // ── IAP.p2.k regressions ─────────────────────────────────────────────────
  it("reads territory from InAppPurchasePrice.relationships.territory (FIX A)", () => {
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        manualPrices: [
          {
            priceId: "p-vn",
            pricePointId: "pp-vn",
            territory: "VNM",
            customerPrice: "89000",
            currency: "VND",
          },
        ],
      }),
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].territory).toBe("VNM");
  });

  it("reads currency from Territory.attributes.currency (FIX B)", () => {
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        manualPrices: [
          {
            priceId: "p-jp",
            pricePointId: "pp-jp",
            territory: "JPN",
            customerPrice: "150",
            currency: "JPY",
          },
        ],
      }),
    );
    expect(out.entries[0].currency).toBe("JPY");
  });

  it("returns currency=null when the Territory resource isn't side-loaded", () => {
    const res = priceScheduleResponse({
      manualPrices: [
        {
          priceId: "p-1",
          pricePointId: "pp-1",
          territory: "USA",
          customerPrice: "0.99",
          // currency intentionally omitted → no Territory resource included
        },
      ],
    });
    const out = unpackPriceSchedule(res);
    expect(out.entries[0].currency).toBeNull();
  });

  // ── IAP.p2.l basePrice (derived from entries) ───────────────────────────
  it("returns basePrice=null when no manualPrice matches the base territory", () => {
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        baseTerritory: "USA",
        manualPrices: [
          {
            priceId: "p-vn",
            pricePointId: "pp-vn",
            territory: "VNM",
            customerPrice: "89000",
            currency: "VND",
          },
        ],
      }),
    );
    expect(out.basePrice).toBeNull();
    expect(out.entries).toHaveLength(1);
  });

  it("derives basePrice from the manualPrices entry whose territory === baseTerritory (IAP.p2.l)", () => {
    // Per iris-API ground truth at MV30: Apple stores the base price in
    // manualPrices alongside the other overrides, NOT in a separate
    // automaticPrices bucket (p2.k Stage 3 assumption was disproved).
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        baseTerritory: "USA",
        manualPrices: [
          {
            priceId: "p-vn",
            pricePointId: "pp-vn",
            territory: "VNM",
            customerPrice: "89000",
            currency: "VND",
          },
          {
            priceId: "p-usa",
            pricePointId: "pp-usa",
            territory: "USA",
            customerPrice: "2.99",
            currency: "USD",
          },
        ],
      }),
    );
    expect(out.basePrice).toMatchObject({
      territory: "USA",
      customerPrice: "2.99",
      currency: "USD",
    });
    // The base IS still present in entries (Apple Connect's UI counts it
    // in the manual-prices total too — Manager's "11 Countries or Regions"
    // includes the base).
    expect(out.entries).toHaveLength(2);
    expect(out.entries.map((e) => e.territory).sort()).toEqual(["USA", "VNM"]);
  });

  it("derives basePrice only from effective-now entries (future-dated base goes to upcoming)", () => {
    // A future-dated base price belongs in the upcoming-changes table, not
    // in the header block. Defensive: matches the partition logic in
    // IapPriceScheduleSection.
    const out = unpackPriceSchedule(
      priceScheduleResponse({
        baseTerritory: "USA",
        manualPrices: [
          {
            priceId: "p-usa-future",
            pricePointId: "pp-usa-future",
            territory: "USA",
            customerPrice: "3.99",
            currency: "USD",
            startDate: "2026-08-01",
          },
        ],
      }),
    );
    expect(out.basePrice).toBeNull();
  });
});

// ─── IAP.p2.a — getIapViewData composer ──────────────────────────────────────

describe("getIapViewData", () => {
  const creds = {
    id: "test",
    name: "Test",
    keyId: "K",
    issuerId: "I",
    privateKey: "P",
  };

  beforeEach(() => {
    getInAppPurchase.mockReset();
    getPriceScheduleForIap.mockReset();
  });

  it("composes IAP + localizations + screenshot + priceSchedule in one call", async () => {
    getInAppPurchase.mockResolvedValueOnce({
      data: baseIap(),
      included: [
        {
          type: "inAppPurchaseLocalizations",
          id: "loc-en",
          attributes: { locale: "en-US", name: "Diamonds" },
        },
      ],
    });
    getPriceScheduleForIap.mockResolvedValueOnce(
      priceScheduleResponse({
        manualPrices: [
          {
            priceId: "p-1",
            pricePointId: "pp-usa-99",
            territory: "USA",
            customerPrice: "0.99",
          },
        ],
      }),
    );

    const out = await getIapViewData(creds, "apple-1");

    expect(out.iap.id).toBe("apple-1");
    expect(out.localizations).toHaveLength(1);
    expect(out.priceSchedule?.entries).toHaveLength(1);
    expect(out.priceScheduleError).toBeNull();
  });

  it("returns priceSchedule=null when Apple 404s (no schedule yet)", async () => {
    getInAppPurchase.mockResolvedValueOnce({ data: baseIap() });
    getPriceScheduleForIap.mockRejectedValueOnce(
      new AppleApiError(404, "GET", "/v2/.../inAppPurchasePriceSchedule", ""),
    );

    const out = await getIapViewData(creds, "apple-1");

    expect(out.iap.id).toBe("apple-1");
    expect(out.priceSchedule).toBeNull();
    expect(out.priceScheduleError).toBeNull();
  });

  it("surfaces priceScheduleError when the fetch fails for non-404", async () => {
    getInAppPurchase.mockResolvedValueOnce({ data: baseIap() });
    getPriceScheduleForIap.mockRejectedValueOnce(
      new AppleApiError(500, "GET", "/v2/.../inAppPurchasePriceSchedule", "boom"),
    );

    const out = await getIapViewData(creds, "apple-1");

    expect(out.iap.id).toBe("apple-1");
    expect(out.priceSchedule).toBeNull();
    expect(out.priceScheduleError).toContain("boom");
  });

  it("propagates the IAP fetch failure (critical path)", async () => {
    getInAppPurchase.mockRejectedValueOnce(new Error("auth failed"));
    getPriceScheduleForIap.mockResolvedValueOnce(priceScheduleResponse({}));

    await expect(getIapViewData(creds, "apple-1")).rejects.toThrow(
      "auth failed",
    );
  });
});
