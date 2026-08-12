/**
 * `decideCustomPriceWrite` — which of SC1's three operations a save actually is.
 *
 * SC1 justified three audit action types; they only carry their meaning if the
 * writer picks the right one. In particular a re-baseline must NOT log as an
 * ordinary save: it changes what will ship to a live store while changing
 * nothing visible, and that is the whole reason it has its own row.
 */
import { describe, it, expect } from "vitest";
import { decideCustomPriceWrite, type CustomPriceBaseline } from "./model";

const T10: CustomPriceBaseline = {
  tier_id: "TIER_10",
  pricing_source: "APP_TEMPLATE",
  base_territory: "USA",
};
const T15: CustomPriceBaseline = { ...T10, tier_id: "TIER_15" };

const VNM = { territory_code: "VNM", customer_price: 25000, currency_code: "VND" };
const JPN = { territory_code: "JPN", customer_price: 1200, currency_code: "JPY" };

describe("decideCustomPriceWrite", () => {
  it("empty incoming set → clear (the one destructive operation)", () => {
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM],
        storedBaseline: T10,
        incomingEntries: [],
        incomingBaseline: T10,
      }),
    ).toBe("clear");
  });

  it("⚠ same prices + moved fingerprint → rebaseline, not a save", () => {
    // "Keep them (reviewed)". Logging this as CUSTOM_PRICES_SAVED would leave a
    // future reader seeing prices set against one tier attached to another with
    // no explanation.
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM, JPN],
        storedBaseline: T10,
        incomingEntries: [JPN, VNM], // order must not matter — both normalize
        incomingBaseline: T15,
      }),
    ).toBe("rebaseline");
  });

  it("changed prices → replace, even when the fingerprint also moved", () => {
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM],
        storedBaseline: T10,
        incomingEntries: [{ ...VNM, customer_price: 39000 }],
        incomingBaseline: T15,
      }),
    ).toBe("replace");
  });

  it("added territory → replace", () => {
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM],
        storedBaseline: T10,
        incomingEntries: [VNM, JPN],
        incomingBaseline: T10,
      }),
    ).toBe("replace");
  });

  it("removed territory (but not all) → replace", () => {
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM, JPN],
        storedBaseline: T10,
        incomingEntries: [VNM],
        incomingBaseline: T10,
      }),
    ).toBe("replace");
  });

  it("identical prices AND identical fingerprint → replace (a harmless no-op save)", () => {
    // Deliberately not "rebaseline": nothing moved, so there is nothing to
    // acknowledge, and a REBASELINE row would claim a review that never happened.
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM],
        storedBaseline: T10,
        incomingEntries: [VNM],
        incomingBaseline: T10,
      }),
    ).toBe("replace");
  });

  it("first-ever save (nothing stored) → replace", () => {
    expect(
      decideCustomPriceWrite({
        storedEntries: [],
        storedBaseline: null,
        incomingEntries: [VNM],
        incomingBaseline: T10,
      }),
    ).toBe("replace");
  });

  it("a currency change alone is a real change → replace", () => {
    expect(
      decideCustomPriceWrite({
        storedEntries: [VNM],
        storedBaseline: T10,
        incomingEntries: [{ ...VNM, currency_code: "USD" }],
        incomingBaseline: T15,
      }),
    ).toBe("replace");
  });
});
