/**
 * Unit tests for the bulk-import result-classification helpers (IAP.o.7c).
 * The wizard component itself isn't unit-tested in this project; these
 * helpers carry the failure-detection + tab-hint logic so regressions land
 * here, not in jsdom.
 */

import { describe, it, expect } from "vitest";
import {
  bulkImportToastSeverity,
  hasNonRenewingSub,
} from "./result-hints";
import type { ParsedIapItem } from "../parsers/iap-items";

function makeItem(
  type: ParsedIapItem["type"],
  productId = "p.test",
): ParsedIapItem {
  return {
    row_index: 1,
    product_id: productId,
    reference_name: "Test",
    type,
    type_source: "COLUMN",
    price_usd: 0.99,
    base_price: 0.99,
    base_currency: "USD",
    localizations: [],
    warnings: [],
  };
}

describe("bulkImportToastSeverity", () => {
  it("returns success when all rows succeeded", () => {
    expect(bulkImportToastSeverity({ succeeded: 10, skipped: 0, failed: 0 }))
      .toBe("success");
  });

  it("returns success when some skipped but none failed", () => {
    expect(bulkImportToastSeverity({ succeeded: 5, skipped: 5, failed: 0 }))
      .toBe("success");
  });

  it("returns error when any row failed (Manager IAP.o.7c directive)", () => {
    expect(bulkImportToastSeverity({ succeeded: 9, skipped: 0, failed: 1 }))
      .toBe("error");
  });

  it("returns error when all rows failed", () => {
    expect(bulkImportToastSeverity({ succeeded: 0, skipped: 0, failed: 10 }))
      .toBe("error");
  });
});

describe("hasNonRenewingSub", () => {
  it("returns false for empty batch", () => {
    expect(hasNonRenewingSub([])).toBe(false);
  });

  it("returns false when no NRS rows present", () => {
    expect(
      hasNonRenewingSub([
        makeItem("CONSUMABLE"),
        makeItem("NON_CONSUMABLE"),
      ]),
    ).toBe(false);
  });

  it("returns true when at least one NRS row present", () => {
    expect(
      hasNonRenewingSub([
        makeItem("CONSUMABLE"),
        makeItem("NON_RENEWING_SUBSCRIPTION"),
      ]),
    ).toBe(true);
  });

  it("returns true even when NRS is the only row type", () => {
    expect(
      hasNonRenewingSub([makeItem("NON_RENEWING_SUBSCRIPTION")]),
    ).toBe(true);
  });
});
