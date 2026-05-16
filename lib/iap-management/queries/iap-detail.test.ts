/**
 * splitIncluded — partition Apple's `included` array into typed buckets.
 *
 * Pure helper extracted from the route layer so the JSON:API unpacking
 * can be exercised without mocking `getInAppPurchase`. Covers the empty,
 * locs-only, screenshot-only, and mixed cases plus the defensive null
 * fallback when Apple returns no `included` block.
 */

import { describe, it, expect } from "vitest";
import { splitIncluded } from "./iap-detail";
import type {
  AscApiResponse,
  InAppPurchase,
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
