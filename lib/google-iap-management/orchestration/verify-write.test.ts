/**
 * SC1 — honest status. The verdict must be earned from Google's post-write
 * state, never assumed from the tool's own diff.
 */
// @vitest-environment node
import { describe, it, expect } from "vitest";

import { verifyPricingLanded, type PriceMap } from "./verify-write";

const usd = (m: string) => ({ currency: "USD", priceMicros: m });
const vnd = (m: string) => ({ currency: "VND", priceMicros: m });

describe("verifyPricingLanded", () => {
  it("THE BUG: base price asked to move, every region came back at its old value → noOp", () => {
    const before: PriceMap = { US: usd("1990000"), VN: vnd("49000000000") };
    const v = verifyPricingLanded({
      before,
      // What the form sends today: stale overrides, only the base moved.
      intended: { US: usd("1990000"), VN: vnd("49000000000") },
      applied: before,
      intendedBaseMicros: "2990000",
      appliedBaseMicros: "1990000",
      baseChangeRequested: true,
    });
    expect(v.checked).toBe(true);
    expect(v.basePriceApplied).toBe(false);
    expect(v.noOp).toBe(true);
  });

  it("healthy write: regions moved to the intended values → not a noOp", () => {
    const before: PriceMap = { US: usd("1990000"), VN: vnd("49000000000") };
    const intended: PriceMap = { US: usd("2990000"), VN: vnd("74000000000") };
    const v = verifyPricingLanded({
      before,
      intended,
      applied: intended,
      intendedBaseMicros: "2990000",
      appliedBaseMicros: "2990000",
      baseChangeRequested: true,
    });
    expect(v.noOp).toBe(false);
    expect(v.basePriceApplied).toBe(true);
    expect(v.unappliedRegions).toEqual([]);
    expect(v.intendedChangeCount).toBe(2);
  });

  it("partial write: one region landed, one did not → not a noOp, but named", () => {
    const before: PriceMap = { US: usd("1990000"), VN: vnd("49000000000") };
    const v = verifyPricingLanded({
      before,
      intended: { US: usd("2990000"), VN: vnd("74000000000") },
      applied: { US: usd("2990000"), VN: vnd("49000000000") },
      intendedBaseMicros: "2990000",
      appliedBaseMicros: "2990000",
      baseChangeRequested: true,
    });
    expect(v.noOp).toBe(false);
    expect(v.unappliedRegions).toEqual(["VN"]);
  });

  it("no verdict without evidence: empty response pricing → checked:false, never a false alarm", () => {
    const v = verifyPricingLanded({
      before: { US: usd("1990000") },
      intended: { US: usd("2990000") },
      applied: null,
      intendedBaseMicros: "2990000",
      appliedBaseMicros: null,
      baseChangeRequested: true,
    });
    expect(v.checked).toBe(false);
    expect(v.noOp).toBe(false);
    expect(v.basePriceApplied).toBeNull();
  });

  it("listing-only edit (no pricing change asked) is never reported as a noOp", () => {
    const same: PriceMap = { US: usd("1990000") };
    const v = verifyPricingLanded({
      before: same,
      intended: same,
      applied: same,
      intendedBaseMicros: "1990000",
      appliedBaseMicros: "1990000",
      baseChangeRequested: false,
    });
    expect(v.noOp).toBe(false);
    expect(v.basePriceApplied).toBeNull();
    expect(v.intendedChangeCount).toBe(0);
  });

  it("NO NORMALISATION: an odd-precision value from Google compares byte-exact", () => {
    // TWD 6.30 — a real value in the production cache. It must round-trip
    // through verification untouched: equal to itself, unequal to 6.
    const before: PriceMap = { TW: { currency: "TWD", priceMicros: "6300000" } };
    const unchanged = verifyPricingLanded({
      before,
      intended: before,
      applied: before,
      intendedBaseMicros: "490000",
      appliedBaseMicros: "490000",
      baseChangeRequested: false,
    });
    expect(unchanged.unappliedRegions).toEqual([]);

    const rounded = verifyPricingLanded({
      before,
      intended: { TW: { currency: "TWD", priceMicros: "6000000" } },
      applied: before,
      intendedBaseMicros: "490000",
      appliedBaseMicros: "490000",
      baseChangeRequested: false,
    });
    // 6.30 and 6 are different prices. Verification must say so.
    expect(rounded.unappliedRegions).toEqual(["TW"]);
  });

  it("currency case from Google is tolerated; the amount never is", () => {
    const v = verifyPricingLanded({
      before: { US: usd("1990000") },
      intended: { US: usd("2990000") },
      applied: { US: { currency: "usd", priceMicros: "2990000" } },
      intendedBaseMicros: "2990000",
      appliedBaseMicros: "2990000",
      baseChangeRequested: true,
    });
    expect(v.unappliedRegions).toEqual([]);
  });
});
