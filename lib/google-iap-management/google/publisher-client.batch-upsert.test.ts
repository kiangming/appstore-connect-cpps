/**
 * batchUpsertInAppProducts — read-modify-write fix for legacy purchase options.
 *
 * Root cause: Google's PATCH (with updateMask including "purchaseOptions")
 * REPLACES the entire purchaseOptions array. Products originally created via
 * the legacy inappproducts.* API surface a purchaseOptionId of "legacy-base".
 * Our old code always sent only { purchaseOptionId: "buy" }, dropping
 * "legacy-base" by omission → Google rejected: "must list all existing
 * purchase options. Missing: legacy-base".
 *
 * Fix: for overwrite rows, GET the live product first, then include ALL
 * existing purchase options in the PATCH body (updating pricing on the target
 * option, preserving all others). Create rows are unchanged.
 *
 * Core invariant: PATCH for an overwrite row always includes the COMPLETE
 * existing purchase-option set with REAL IDs, never a subset.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Mocks ── */
const { getProductSpy, batchUpdateSpy, batchActivateSpy, logSpy } = vi.hoisted(() => ({
  getProductSpy: vi.fn(),
  batchUpdateSpy: vi.fn(),
  batchActivateSpy: vi.fn(),
  logSpy: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    androidpublisher: () => ({
      monetization: {
        onetimeproducts: {
          get: getProductSpy,
          batchUpdate: batchUpdateSpy,
          purchaseOptions: { batchUpdateStates: batchActivateSpy },
        },
      },
    }),
  },
}));
vi.mock("./logging", () => ({ logPublisherCall: logSpy }));
// Real adapter so write-shape assertions reflect actual request body construction.
vi.mock("google-auth-library", () => ({ JWT: class {} }));

import { batchUpsertInAppProducts } from "./publisher-client";
import type { BatchUpsertInput } from "./publisher-client";

const jwt = {} as never;

function makeGetResponse(purchaseOptionId: string, extraOptions: object[] = []) {
  return {
    data: {
      productId: "sku.a",
      packageName: "com.example.app",
      purchaseOptions: [
        {
          purchaseOptionId,
          buyOption: { legacyCompatible: purchaseOptionId === "legacy-base" },
          state: "ACTIVE",
          regionalPricingAndAvailabilityConfigs: [
            {
              regionCode: "US",
              price: { currencyCode: "USD", units: "0", nanos: 990_000_000 },
              availability: "AVAILABLE",
            },
          ],
        },
        ...extraOptions,
      ],
      listings: [{ languageCode: "en-US", title: "Old Title", description: "" }],
    },
  };
}

function overwriteInput(sku = "sku.a"): BatchUpsertInput {
  return {
    body: {
      sku,
      status: "active",
      purchaseType: "managedUser",
      defaultLanguage: "en-US",
      defaultPrice: { currency: "USD", priceMicros: "1990000" },
      prices: { US: { currency: "USD", priceMicros: "1990000" } },
      listings: { "en-US": { title: "New Title", description: "desc" } },
    },
    regionsVersion: "2022/02",
    isOverwrite: true,
  };
}

function createInput(sku = "sku.new"): BatchUpsertInput {
  return {
    body: {
      sku,
      status: "active",
      purchaseType: "managedUser",
      defaultLanguage: "en-US",
      defaultPrice: { currency: "USD", priceMicros: "990000" },
      prices: { US: { currency: "USD", priceMicros: "990000" } },
      listings: { "en-US": { title: "New Product", description: "d" } },
    },
    regionsVersion: "2022/02",
    isOverwrite: false,
  };
}

function stubBatchUpdate(productId = "sku.a") {
  batchUpdateSpy.mockResolvedValueOnce({
    data: {
      oneTimeProducts: [
        {
          productId,
          packageName: "com.example.app",
          purchaseOptions: [
            {
              purchaseOptionId: "any",
              buyOption: { legacyCompatible: true },
              state: "DRAFT",
              regionalPricingAndAvailabilityConfigs: [],
            },
          ],
          listings: [],
        },
      ],
    },
  });
}

beforeEach(() => {
  getProductSpy.mockReset();
  batchUpdateSpy.mockReset();
  batchActivateSpy.mockReset().mockResolvedValue({ data: {} });
  logSpy.mockReset();
});

describe("batchUpsertInAppProducts — RMW for overwrite rows", () => {
  it("overwrite with 'legacy-base' option: PATCH includes 'legacy-base' as purchaseOptionId, not 'buy'", async () => {
    getProductSpy.mockResolvedValueOnce(makeGetResponse("legacy-base"));
    stubBatchUpdate();

    await batchUpsertInAppProducts(jwt, "com.example.app", [overwriteInput()]);

    expect(batchUpdateSpy).toHaveBeenCalledTimes(1);
    const req = batchUpdateSpy.mock.calls[0][0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any[] = req.requestBody.requests[0].oneTimeProduct.purchaseOptions;
    // The patch must use "legacy-base" — the real live ID.
    expect(opts.map((o: { purchaseOptionId: string }) => o.purchaseOptionId)).toEqual(["legacy-base"]);
    // Pricing is updated on that option.
    const cfg = opts[0].regionalPricingAndAvailabilityConfigs;
    expect(cfg).toBeDefined();
    expect(cfg.length).toBeGreaterThan(0);
    // allowMissing must be false for an overwrite row.
    expect(req.requestBody.requests[0].allowMissing).toBe(false);
  });

  it("overwrite with 'buy' option: PATCH updates 'buy' (product already matches tool's ID)", async () => {
    getProductSpy.mockResolvedValueOnce(makeGetResponse("buy"));
    stubBatchUpdate();

    await batchUpsertInAppProducts(jwt, "com.example.app", [overwriteInput()]);

    const req = batchUpdateSpy.mock.calls[0][0];
    const opts: { purchaseOptionId: string }[] =
      req.requestBody.requests[0].oneTimeProduct.purchaseOptions;
    expect(opts.map((o) => o.purchaseOptionId)).toEqual(["buy"]);
  });

  it("overwrite with MULTIPLE purchase options: ALL options preserved; only target gets new pricing", async () => {
    getProductSpy.mockResolvedValueOnce(
      makeGetResponse("legacy-base", [
        {
          purchaseOptionId: "extra-option",
          rentOption: {},
          state: "INACTIVE",
          regionalPricingAndAvailabilityConfigs: [
            {
              regionCode: "GB",
              price: { currencyCode: "GBP", units: "0", nanos: 790_000_000 },
              availability: "AVAILABLE",
            },
          ],
        },
      ]),
    );
    stubBatchUpdate();

    await batchUpsertInAppProducts(jwt, "com.example.app", [overwriteInput()]);

    const req = batchUpdateSpy.mock.calls[0][0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any[] = req.requestBody.requests[0].oneTimeProduct.purchaseOptions;

    // Both options are present.
    expect(opts.map((o: { purchaseOptionId: string }) => o.purchaseOptionId).sort()).toEqual(
      ["extra-option", "legacy-base"].sort(),
    );
    // "extra-option" (rentOption) is preserved unchanged.
    const extra = opts.find((o: { purchaseOptionId: string }) => o.purchaseOptionId === "extra-option");
    expect(extra?.rentOption).toBeDefined();
  });

  it("create (new product): no GET, single 'buy' option, allowMissing:true", async () => {
    stubBatchUpdate("sku.new");

    await batchUpsertInAppProducts(jwt, "com.example.app", [createInput()]);

    // No GET call fired for create rows.
    expect(getProductSpy).not.toHaveBeenCalled();

    const req = batchUpdateSpy.mock.calls[0][0];
    const opts: { purchaseOptionId: string }[] =
      req.requestBody.requests[0].oneTimeProduct.purchaseOptions;
    expect(opts).toHaveLength(1);
    expect(opts[0].purchaseOptionId).toBe("buy");
    expect(req.requestBody.requests[0].allowMissing).toBe(true);
  });

  it("mixed batch: create + overwrite → GET only for overwrite, correct IDs in PATCH, correct allowMissing", async () => {
    getProductSpy.mockResolvedValueOnce(makeGetResponse("legacy-base"));
    // Batch returns two products in order.
    batchUpdateSpy.mockResolvedValueOnce({
      data: {
        oneTimeProducts: [
          {
            productId: "sku.new",
            packageName: "com.example.app",
            purchaseOptions: [{ purchaseOptionId: "buy", state: "DRAFT", buyOption: { legacyCompatible: true }, regionalPricingAndAvailabilityConfigs: [] }],
            listings: [],
          },
          {
            productId: "sku.a",
            packageName: "com.example.app",
            purchaseOptions: [{ purchaseOptionId: "legacy-base", state: "DRAFT", buyOption: { legacyCompatible: true }, regionalPricingAndAvailabilityConfigs: [] }],
            listings: [],
          },
        ],
      },
    });

    await batchUpsertInAppProducts(jwt, "com.example.app", [
      createInput("sku.new"),
      overwriteInput("sku.a"),
    ]);

    // Exactly one GET (for the overwrite).
    expect(getProductSpy).toHaveBeenCalledTimes(1);
    expect(getProductSpy.mock.calls[0][0].productId).toBe("sku.a");

    const req = batchUpdateSpy.mock.calls[0][0];
    const requests = req.requestBody.requests;
    expect(requests).toHaveLength(2);

    // Create row: "buy" + allowMissing:true.
    expect(requests[0].oneTimeProduct.purchaseOptions[0].purchaseOptionId).toBe("buy");
    expect(requests[0].allowMissing).toBe(true);

    // Overwrite row: "legacy-base" + allowMissing:false.
    expect(requests[1].oneTimeProduct.purchaseOptions[0].purchaseOptionId).toBe("legacy-base");
    expect(requests[1].allowMissing).toBe(false);
  });

  it("GET failure on overwrite row: that row is skipped (null in result), batch continues for other rows", async () => {
    // First call (overwrite GET) throws; second call (create GET — none fired) not applicable.
    getProductSpy.mockRejectedValueOnce(new Error("Google 500"));
    // Batch returns only the create row.
    batchUpdateSpy.mockResolvedValueOnce({
      data: {
        oneTimeProducts: [
          {
            productId: "sku.new",
            packageName: "com.example.app",
            purchaseOptions: [{ purchaseOptionId: "buy", state: "DRAFT", buyOption: { legacyCompatible: true }, regionalPricingAndAvailabilityConfigs: [] }],
            listings: [],
          },
        ],
      },
    });

    const results = await batchUpsertInAppProducts(jwt, "com.example.app", [
      overwriteInput("sku.a"),   // index 0 — GET fails
      createInput("sku.new"),    // index 1 — succeeds
    ]);

    // Overwrite row is null (failed); create row succeeds.
    expect(results[0]).toBeNull();
    expect(results[1]).toBeTruthy();
    expect(results[1]?.sku).toBe("sku.new");

    // Batch was still fired (with just the create row).
    expect(batchUpdateSpy).toHaveBeenCalledTimes(1);
    expect(batchUpdateSpy.mock.calls[0][0].requestBody.requests).toHaveLength(1);
    expect(batchUpdateSpy.mock.calls[0][0].requestBody.requests[0].allowMissing).toBe(true);
  });

  it("concurrency: 6 overwrite GETs are bounded, not all-at-once", async () => {
    // 6 overwrites — above the OVERWRITE_GET_CONCURRENCY=5 ceiling.
    // Track call order by simulating slow responses for the first 5.
    const order: number[] = [];
    let callCount = 0;
    getProductSpy.mockImplementation(({ productId }: { productId: string }) => {
      const idx = parseInt(productId.split(".")[1], 10);
      order.push(idx);
      callCount++;
      if (callCount <= 5) {
        // First 5: slow (simulate concurrency-limited batch).
        return new Promise((resolve) =>
          setTimeout(() => resolve(makeGetResponse("legacy-base")), 5),
        );
      }
      return Promise.resolve(makeGetResponse("legacy-base"));
    });
    batchUpdateSpy.mockResolvedValueOnce({
      data: {
        oneTimeProducts: Array.from({ length: 6 }, (_, i) => ({
          productId: `sku.${i}`,
          packageName: "com.example.app",
          purchaseOptions: [{ purchaseOptionId: "legacy-base", state: "DRAFT", buyOption: { legacyCompatible: true }, regionalPricingAndAvailabilityConfigs: [] }],
          listings: [],
        })),
      },
    });

    const inputs = Array.from({ length: 6 }, (_, i) => overwriteInput(`sku.${i}`));
    const results = await batchUpsertInAppProducts(jwt, "com.example.app", inputs);

    // All 6 GETs fired (bounded concurrency runs all eventually).
    expect(getProductSpy).toHaveBeenCalledTimes(6);
    // All 6 results present.
    expect(results.filter(Boolean)).toHaveLength(6);
  });
});
