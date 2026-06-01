import { describe, it, expect } from "vitest";

import {
  ANCHOR_CURRENCY,
  DEFAULT_ANCHOR_CURRENCY,
  detectCrossCurrencyTrigger,
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
  it("converts standard USD anchor prices to micros (default anchor)", () => {
    expect(fileDecimalToAnchorMicros("4.99")).toBe("4990000");
    expect(fileDecimalToAnchorMicros("9.99")).toBe("9990000");
    expect(fileDecimalToAnchorMicros("21.99")).toBe("21990000");
    expect(fileDecimalToAnchorMicros("35.99")).toBe("35990000");
    expect(fileDecimalToAnchorMicros("0.99")).toBe("990000");
  });

  it("accepts an explicit anchor currency parameter (Cycle 43 generalisation)", () => {
    // EUR also exponent 2 — same precision rules as USD.
    expect(fileDecimalToAnchorMicros("4.99", "EUR")).toBe("4990000");
    // JPY exponent 0 — only whole numbers.
    expect(fileDecimalToAnchorMicros("150", "JPY")).toBe("150000000");
    expect(fileDecimalToAnchorMicros("150.50", "JPY")).toBeNull();
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

  it("uses USD as the default anchor currency (constant exported)", () => {
    expect(DEFAULT_ANCHOR_CURRENCY).toBe("USD");
    expect(ANCHOR_CURRENCY).toBe("USD"); // back-compat alias
  });
});

describe("detectCrossCurrencyTrigger (Cycle 43 header-first)", () => {
  // PRIMARY: explicit "Price (XXX)" headers — header-first.
  describe("explicit header (Pass 1) — header-first trigger", () => {
    it("Price (USD) header + VND app → cross-currency, anchor=USD (the REAL VN.xlsx repro)", () => {
      // EXACT repro fixture: real file uses explicit "Price (USD)" header
      // (cell B1) against the VND-default app "CookieRun: Bánh Quy Đại
      // Chiến". Each of the four real prices must trigger header-first.
      for (const price of ["4.99", "9.99", "21.99", "35.99"]) {
        const trigger = detectCrossCurrencyTrigger({
          basePriceDecimal: price,
          baseCurrency: "USD",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "VND",
        });
        expect(trigger).toEqual({
          kind: "explicit_header",
          anchorCurrency: "USD",
        });
      }
    });

    it("Price (USD) header + USD app → null (same currency, current path)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "USD",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "USD",
        }),
      ).toBeNull();
    });

    it("Price (VND) header + VND app → null (same currency)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "25000",
          baseCurrency: "VND",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "VND",
        }),
      ).toBeNull();
    });

    it("Price (EUR) header + VND app → cross-currency, anchor=EUR (NOT hardcoded USD)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "EUR",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "VND",
        }),
      ).toEqual({ kind: "explicit_header", anchorCurrency: "EUR" });
    });

    it("Price (USD) header + VND app with an INTEGER value (e.g. 25) → cross-currency", () => {
      // Pre-Cycle-43 (value-based only) would have MISSED this: 25 passes
      // VND precision when wizard stomped baseCurrency=VND. Header-first
      // catches it.
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "25",
          baseCurrency: "USD",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "VND",
        }),
      ).toEqual({ kind: "explicit_header", anchorCurrency: "USD" });
    });

    it("is case-insensitive on currency code comparison", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "usd",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "vnd",
        }),
      ).toEqual({ kind: "explicit_header", anchorCurrency: "USD" });
    });
  });

  // FALLBACK: generic "Price" headers — value-based.
  describe("inferred header (Pass 2) — value-based fallback trigger", () => {
    it("generic Price + VND app + 4.99 → cross-currency, anchor=USD (fallback)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "VND", // parser inferred VND from app default
          priceHeaderSource: "inferred",
          appDefaultCurrency: "VND",
        }),
      ).toEqual({ kind: "value_based", anchorCurrency: "USD" });
    });

    it("generic Price + VND app + whole-number 25000 → null (passes VND precision)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "25000",
          baseCurrency: "VND",
          priceHeaderSource: "inferred",
          appDefaultCurrency: "VND",
        }),
      ).toBeNull();
    });

    it("generic Price + USD app + 4.99 → null (passes USD precision)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "USD",
          priceHeaderSource: "inferred",
          appDefaultCurrency: "USD",
        }),
      ).toBeNull();
    });
  });

  describe("guards", () => {
    it("returns null when appDefaultCurrency is null/empty (can't classify)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "USD",
          priceHeaderSource: "explicit",
          appDefaultCurrency: null,
        }),
      ).toBeNull();
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "USD",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "",
        }),
      ).toBeNull();
    });

    it("returns null on empty inputs (defensive)", () => {
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "",
          baseCurrency: "USD",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "VND",
        }),
      ).toBeNull();
      expect(
        detectCrossCurrencyTrigger({
          basePriceDecimal: "4.99",
          baseCurrency: "",
          priceHeaderSource: "explicit",
          appDefaultCurrency: "VND",
        }),
      ).toBeNull();
    });
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
