import { describe, it, expect } from "vitest";

import {
  getCurrencyDecimals,
  validateDecimalForCurrency,
  inputStepForCurrency,
} from "./currency-precision";

describe("getCurrencyDecimals", () => {
  it("returns 0 for zero-decimal currencies", () => {
    expect(getCurrencyDecimals("VND")).toBe(0);
    expect(getCurrencyDecimals("JPY")).toBe(0);
    expect(getCurrencyDecimals("KRW")).toBe(0);
    expect(getCurrencyDecimals("IDR")).toBe(0);
    expect(getCurrencyDecimals("HUF")).toBe(0);
    expect(getCurrencyDecimals("TWD")).toBe(0);
  });

  it("returns 3 for 3-decimal currencies", () => {
    expect(getCurrencyDecimals("BHD")).toBe(3);
    expect(getCurrencyDecimals("KWD")).toBe(3);
    expect(getCurrencyDecimals("OMR")).toBe(3);
  });

  it("returns 2 for common 2-decimal currencies", () => {
    expect(getCurrencyDecimals("USD")).toBe(2);
    expect(getCurrencyDecimals("EUR")).toBe(2);
    expect(getCurrencyDecimals("GBP")).toBe(2);
    expect(getCurrencyDecimals("THB")).toBe(2);
  });

  it("falls back to 2 for unknown currencies + empty inputs", () => {
    expect(getCurrencyDecimals("XYZ")).toBe(2);
    expect(getCurrencyDecimals("")).toBe(2);
    expect(getCurrencyDecimals(null)).toBe(2);
    expect(getCurrencyDecimals(undefined)).toBe(2);
  });

  it("normalises case + whitespace", () => {
    expect(getCurrencyDecimals("vnd")).toBe(0);
    expect(getCurrencyDecimals(" usd ")).toBe(2);
  });
});

describe("validateDecimalForCurrency", () => {
  it("accepts integer values for zero-decimal currencies", () => {
    expect(validateDecimalForCurrency("23000", "VND")).toBeNull();
    expect(validateDecimalForCurrency("100", "JPY")).toBeNull();
    expect(validateDecimalForCurrency("1000", "KRW")).toBeNull();
  });

  it("rejects fractional values for zero-decimal currencies", () => {
    const err = validateDecimalForCurrency("1.99", "VND");
    expect(err).toMatch(/VND only accepts whole numbers/);
    expect(validateDecimalForCurrency("100.5", "JPY")).toMatch(/JPY/);
  });

  it("treats trailing zeros as no fractional part", () => {
    // "23000.00" is logically 23000 — should be accepted for VND.
    expect(validateDecimalForCurrency("23000.00", "VND")).toBeNull();
    expect(validateDecimalForCurrency("100.000", "JPY")).toBeNull();
  });

  it("accepts up to 2 fractional digits for USD/EUR", () => {
    expect(validateDecimalForCurrency("0.99", "USD")).toBeNull();
    expect(validateDecimalForCurrency("1.50", "EUR")).toBeNull();
  });

  it("rejects 3+ fractional digits for 2-decimal currency", () => {
    const err = validateDecimalForCurrency("1.999", "USD");
    expect(err).toMatch(/USD supports at most 2/);
  });

  it("accepts up to 3 fractional digits for BHD/KWD/OMR", () => {
    expect(validateDecimalForCurrency("1.250", "BHD")).toBeNull();
    expect(validateDecimalForCurrency("1.500", "KWD")).toBeNull();
  });

  it("returns null for empty input (required-check is caller's job)", () => {
    expect(validateDecimalForCurrency("", "VND")).toBeNull();
    expect(validateDecimalForCurrency("   ", "USD")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(validateDecimalForCurrency("abc", "USD")).toMatch(/non-negative/);
    expect(validateDecimalForCurrency("-1.99", "USD")).toMatch(/non-negative/);
  });

  it("normalises currency case", () => {
    expect(validateDecimalForCurrency("23000", "vnd")).toBeNull();
    expect(validateDecimalForCurrency("1.99", "vnd")).toMatch(/VND/);
  });
});

describe("inputStepForCurrency", () => {
  it("returns '1' for zero-decimal currencies", () => {
    expect(inputStepForCurrency("VND")).toBe("1");
    expect(inputStepForCurrency("JPY")).toBe("1");
  });

  it("returns '0.01' for 2-decimal currencies", () => {
    expect(inputStepForCurrency("USD")).toBe("0.01");
    expect(inputStepForCurrency("EUR")).toBe("0.01");
  });

  it("returns '0.001' for 3-decimal currencies", () => {
    expect(inputStepForCurrency("BHD")).toBe("0.001");
    expect(inputStepForCurrency("KWD")).toBe("0.001");
  });
});
