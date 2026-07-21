/**
 * patchInAppProduct — Hotfix 30 RMW fix for the single-item edit path.
 *
 * Root cause: patchInAppProduct built its write shape via
 * inAppProductToOneTimeProduct WITHOUT ever passing existingPurchaseOptions,
 * so it always took the CREATE-path branch and used
 * DEFAULT_PURCHASE_OPTION_ID="buy" for both the PATCH body and the
 * subsequent batchUpdateStates call — 404ing on products whose real
 * purchase-option id differs (e.g. "legacy-base" for legacy-migrated
 * products, same class of bug as the bulk-import fix in commit 4fbcdd5).
 *
 * Fix: patchInAppProduct now calls resolveLivePurchaseOptions first (GET
 * live product), passes the real purchaseOptions through to the adapter,
 * and uses the resolved id for the state-update call too.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getProductSpy, patchSpy, batchActivateSpy, logSpy } = vi.hoisted(() => ({
  getProductSpy: vi.fn(),
  patchSpy: vi.fn(),
  batchActivateSpy: vi.fn(),
  logSpy: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    androidpublisher: () => ({
      monetization: {
        onetimeproducts: {
          get: getProductSpy,
          patch: patchSpy,
          purchaseOptions: { batchUpdateStates: batchActivateSpy },
        },
      },
    }),
  },
}));
vi.mock("./logging", () => ({ logPublisherCall: logSpy }));
vi.mock("google-auth-library", () => ({ JWT: class {} }));

import { patchInAppProduct } from "./publisher-client";
import type { InAppProduct } from "./publisher-client";

const jwt = {} as never;

function makeGetResponse(purchaseOptionId: string, state = "ACTIVE") {
  return {
    data: {
      productId: "sku.a",
      packageName: "com.example.app",
      purchaseOptions: [
        {
          purchaseOptionId,
          buyOption: { legacyCompatible: purchaseOptionId === "legacy-base" },
          state,
          regionalPricingAndAvailabilityConfigs: [
            {
              regionCode: "US",
              price: { currencyCode: "USD", units: "0", nanos: 990_000_000 },
              availability: "AVAILABLE",
            },
          ],
        },
      ],
      listings: [{ languageCode: "en-US", title: "Old Title", description: "" }],
    },
  };
}

function editBody(): InAppProduct {
  return {
    sku: "sku.a",
    status: "active",
    purchaseType: "managedUser",
    defaultLanguage: "en-US",
    defaultPrice: { currency: "USD", priceMicros: "1990000" },
    prices: { US: { currency: "USD", priceMicros: "1990000" } },
    listings: { "en-US": { title: "New Title", description: "desc" } },
  };
}

function stubPatchAndState(purchaseOptionId: string) {
  patchSpy.mockResolvedValueOnce({
    data: {
      productId: "sku.a",
      packageName: "com.example.app",
      purchaseOptions: [
        {
          purchaseOptionId,
          buyOption: { legacyCompatible: purchaseOptionId === "legacy-base" },
          state: "ACTIVE",
          regionalPricingAndAvailabilityConfigs: [],
        },
      ],
      listings: [{ languageCode: "en-US", title: "New Title", description: "desc" }],
    },
  });
  batchActivateSpy.mockResolvedValue({ data: {} });
  // Re-fetch after state apply (refetchWithStateOverlay).
  getProductSpy.mockResolvedValueOnce(makeGetResponse(purchaseOptionId));
}

beforeEach(() => {
  getProductSpy.mockReset();
  patchSpy.mockReset();
  batchActivateSpy.mockReset();
  logSpy.mockReset();
});

describe("patchInAppProduct — RMW resolves real live purchase-option id", () => {
  it("legacy-migrated product: PATCH + state call use 'legacy-base', not the hardcoded 'buy' default", async () => {
    getProductSpy.mockResolvedValueOnce(makeGetResponse("legacy-base"));
    stubPatchAndState("legacy-base");

    await patchInAppProduct(jwt, "com.example.app", "sku.a", editBody());

    // PATCH body carries the real id.
    const patchReq = patchSpy.mock.calls[0][0];
    const opts = patchReq.requestBody.purchaseOptions as { purchaseOptionId: string }[];
    expect(opts.map((o) => o.purchaseOptionId)).toEqual(["legacy-base"]);

    // The state-update (batchUpdateStates) call also targets "legacy-base".
    expect(batchActivateSpy).toHaveBeenCalledTimes(1);
    const stateReq = batchActivateSpy.mock.calls[0][0];
    const stateRequest = stateReq.requestBody.requests[0];
    const purchaseOptionId =
      stateRequest.activatePurchaseOptionRequest?.purchaseOptionId ??
      stateRequest.deactivatePurchaseOptionRequest?.purchaseOptionId;
    expect(purchaseOptionId).toBe("legacy-base");
  });

  it("tool-created product ('buy' option already): still resolves correctly via live GET", async () => {
    getProductSpy.mockResolvedValueOnce(makeGetResponse("buy"));
    stubPatchAndState("buy");

    await patchInAppProduct(jwt, "com.example.app", "sku.a", editBody());

    const patchReq = patchSpy.mock.calls[0][0];
    const opts = patchReq.requestBody.purchaseOptions as { purchaseOptionId: string }[];
    expect(opts.map((o) => o.purchaseOptionId)).toEqual(["buy"]);
  });

  it("multi-active-option product: only the resolved target is patched; PATCH still preserves the full set", async () => {
    getProductSpy.mockResolvedValueOnce({
      data: {
        productId: "sku.a",
        packageName: "com.example.app",
        purchaseOptions: [
          {
            purchaseOptionId: "legacy-base",
            buyOption: { legacyCompatible: true },
            state: "ACTIVE",
            regionalPricingAndAvailabilityConfigs: [],
          },
          {
            purchaseOptionId: "extra-buy",
            buyOption: {},
            state: "ACTIVE",
            regionalPricingAndAvailabilityConfigs: [],
          },
        ],
        listings: [{ languageCode: "en-US", title: "Old Title", description: "" }],
      },
    });
    stubPatchAndState("legacy-base");

    await patchInAppProduct(jwt, "com.example.app", "sku.a", editBody());

    const patchReq = patchSpy.mock.calls[0][0];
    const opts = patchReq.requestBody.purchaseOptions as { purchaseOptionId: string }[];
    // Both options preserved in the PATCH body (Google requires the full set).
    expect(opts.map((o) => o.purchaseOptionId).sort()).toEqual(["extra-buy", "legacy-base"]);
    // The state call still only targets the resolved (legacyCompatible) option —
    // full multi-option state batching is out of scope (surfaced via a
    // console.warn, not silently expanded).
    const stateReq = batchActivateSpy.mock.calls[0][0];
    const stateRequest = stateReq.requestBody.requests[0];
    const purchaseOptionId =
      stateRequest.activatePurchaseOptionRequest?.purchaseOptionId ??
      stateRequest.deactivatePurchaseOptionRequest?.purchaseOptionId;
    expect(purchaseOptionId).toBe("legacy-base");
  });

  it("live GET failure: falls back to the legacy patch path rather than guessing 'buy'", async () => {
    getProductSpy.mockRejectedValueOnce(new Error("Google 500"));
    // legacyPatchInAppProduct isn't mocked here — it will throw (no
    // legacy client mocked), so this call should reject overall rather
    // than silently succeed with a guessed purchase-option id.
    await expect(
      patchInAppProduct(jwt, "com.example.app", "sku.a", editBody()),
    ).rejects.toThrow();

    // No PATCH with a guessed purchase option was ever sent.
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
