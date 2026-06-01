import { describe, it, expect } from "vitest";

import {
  ANCHOR_CURRENCY,
  fileDecimalToAnchorMicros,
  isCrossCurrencyRow,
  pickAppCurrencyEntry,
  REFUSAL_REASONS,
} from "./cross-currency";
import type { ParsedPricingEntry } from "../parsers/pricing-template-parser";

describe("isCrossCurrencyRow", () => {
  it("returns false when value passes precision validation for currency", () => {
    expect(isCrossCurrencyRow("4.99", "USD")).toBe(false);
    expect(isCrossCurrencyRow("25000", "VND")).toBe(false);
    expect(isCrossCurrencyRow("150", "JPY")).toBe(false);
    expect(isCrossCurrencyRow("25000.00", "VND")).toBe(false);
  });

  it("returns true when value has more fractional digits than currency allows", () => {
    // VND requires whole numbers (exponent 0).
    expect(isCrossCurrencyRow("4.99", "VND")).toBe(true);
    expect(isCrossCurrencyRow("21.99", "VND")).toBe(true);
    expect(isCrossCurrencyRow("0.99", "JPY")).toBe(true);
    // USD allows 2 decimals; 4.999 has 3.
    expect(isCrossCurrencyRow("4.999", "USD")).toBe(true);
  });

  it("returns false for empty inputs (caller's responsibility to validate first)", () => {
    expect(isCrossCurrencyRow("", "VND")).toBe(false);
    expect(isCrossCurrencyRow("4.99", "")).toBe(false);
    expect(isCrossCurrencyRow("   ", "VND")).toBe(false);
  });

  it("is case-insensitive on currency code", () => {
    expect(isCrossCurrencyRow("4.99", "vnd")).toBe(true);
    expect(isCrossCurrencyRow("4.99", "Vnd")).toBe(true);
  });
});

describe("fileDecimalToAnchorMicros", () => {
  it("converts standard USD anchor prices to micros", () => {
    expect(fileDecimalToAnchorMicros("4.99")).toBe("4990000");
    expect(fileDecimalToAnchorMicros("9.99")).toBe("9990000");
    expect(fileDecimalToAnchorMicros("21.99")).toBe("21990000");
    expect(fileDecimalToAnchorMicros("35.99")).toBe("35990000");
    expect(fileDecimalToAnchorMicros("0.99")).toBe("990000");
  });

  it("returns null when value has more than 2 fractional digits (invalid USD precision)", () => {
    expect(fileDecimalToAnchorMicros("4.999")).toBeNull();
    expect(fileDecimalToAnchorMicros("4.9999")).toBeNull();
  });

  it("returns null on garbage input", () => {
    expect(fileDecimalToAnchorMicros("not-a-number")).toBeNull();
    expect(fileDecimalToAnchorMicros("")).toBeNull();
    expect(fileDecimalToAnchorMicros("-1.99")).toBeNull();
  });

  it("uses USD as the anchor currency (constant exported)", () => {
    expect(ANCHOR_CURRENCY).toBe("USD");
  });
});

describe("pickAppCurrencyEntry", () => {
  const sample: ParsedPricingEntry[] = [
    { identifier: "Tier 5", regionCode: "US", currency: "USD", priceMicros: "4990000" },
    { identifier: "Tier 5", regionCode: "VN", currency: "VND", priceMicros: "120000000000" },
    { identifier: "Tier 5", regionCode: "JP", currency: "JPY", priceMicros: "750000000" },
    { identifier: "Tier 5", regionCode: "DE", currency: "EUR", priceMicros: "4990000" },
  ];

  it("returns the entry matching the app's default currency", () => {
    expect(pickAppCurrencyEntry(sample, "VND")).toEqual(sample[1]);
    expect(pickAppCurrencyEntry(sample, "JPY")).toEqual(sample[2]);
    expect(pickAppCurrencyEntry(sample, "EUR")).toEqual(sample[3]);
    expect(pickAppCurrencyEntry(sample, "USD")).toEqual(sample[0]);
  });

  it("is case-insensitive and whitespace-tolerant on currency code", () => {
    expect(pickAppCurrencyEntry(sample, "vnd")).toEqual(sample[1]);
    expect(pickAppCurrencyEntry(sample, " VND ")).toEqual(sample[1]);
  });

  it("returns null when the tier has no entry for the requested currency", () => {
    expect(pickAppCurrencyEntry(sample, "KRW")).toBeNull();
    expect(pickAppCurrencyEntry(sample, "BRL")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(pickAppCurrencyEntry([], "VND")).toBeNull();
    expect(pickAppCurrencyEntry(sample, "")).toBeNull();
    expect(pickAppCurrencyEntry(sample, "   ")).toBeNull();
  });
});

describe("REFUSAL_REASONS", () => {
  it("googleDefault message names the app currency, price, and remediation", () => {
    const msg = REFUSAL_REASONS.googleDefault("VND", "4.99");
    expect(msg).toContain("VND");
    expect(msg).toContain("4.99");
    expect(msg).toContain("Google Default");
    expect(msg).toContain("template");
  });

  it("templateMiss message names the missed USD price and the app currency", () => {
    const msg = REFUSAL_REASONS.templateMiss("VND", "4.99");
    expect(msg).toContain("4.99");
    expect(msg).toContain("VND");
    expect(msg).toContain("No template tier");
  });

  it("multiMatchUnresolved counts candidates", () => {
    const msg = REFUSAL_REASONS.multiMatchUnresolved("VND", "0.99", 4);
    expect(msg).toContain("4 template tiers");
    expect(msg).toContain("0.99");
  });

  it("missingEntries and noAppCurrencyEntry name the offending tier", () => {
    expect(REFUSAL_REASONS.missingEntries("Tier 5")).toContain("Tier 5");
    expect(REFUSAL_REASONS.noAppCurrencyEntry("Tier 5", "VND")).toContain("Tier 5");
    expect(REFUSAL_REASONS.noAppCurrencyEntry("Tier 5", "VND")).toContain("VND");
  });
});
