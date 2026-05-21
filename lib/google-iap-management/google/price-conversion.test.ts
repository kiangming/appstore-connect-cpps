import { describe, it, expect } from "vitest";

import {
  decimalToMicros,
  microsToDecimal,
  assertMicrosRoundTrip,
  microsToMoney,
  moneyToMicros,
} from "./price-conversion";

describe("decimalToMicros", () => {
  it("converts common Manager-input prices", () => {
    expect(decimalToMicros("1.99")).toBe("1990000");
    expect(decimalToMicros("0.99")).toBe("990000");
    expect(decimalToMicros("10")).toBe("10000000");
    expect(decimalToMicros("0")).toBe("0");
    expect(decimalToMicros("0.01")).toBe("10000");
  });

  it("handles trailing zeros and partial fractions", () => {
    expect(decimalToMicros("1.5")).toBe("1500000");
    expect(decimalToMicros("1.50")).toBe("1500000");
    expect(decimalToMicros("1.500000")).toBe("1500000");
    expect(decimalToMicros("0.000001")).toBe("1");
  });

  it("accepts number input", () => {
    expect(decimalToMicros(1.99)).toBe("1990000");
    expect(decimalToMicros(0)).toBe("0");
  });

  it("trims surrounding whitespace", () => {
    expect(decimalToMicros("  1.99  ")).toBe("1990000");
  });

  it("rejects negative prices", () => {
    expect(() => decimalToMicros("-1")).toThrow();
    expect(() => decimalToMicros("-0.5")).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => decimalToMicros("1.2.3")).toThrow();
    expect(() => decimalToMicros("abc")).toThrow();
    expect(() => decimalToMicros("")).toThrow();
    expect(() => decimalToMicros("1,99")).toThrow(); // EU comma
  });

  it("rejects more than 6 fractional digits (micros overflow)", () => {
    expect(() => decimalToMicros("1.1234567")).toThrow(/6 fractional/);
  });

  // --- Hotfix 5: currency-aware validation ---

  it("converts integers for zero-decimal currencies (VND/JPY/KRW)", () => {
    expect(decimalToMicros("23000", "VND")).toBe("23000000000");
    expect(decimalToMicros("100", "JPY")).toBe("100000000");
    expect(decimalToMicros("1000", "KRW")).toBe("1000000000");
  });

  it("tolerates trailing-zero fractions for zero-decimal currencies", () => {
    // "23000.00" parses cleanly; the .00 has no significant fractional digits.
    expect(decimalToMicros("23000.00", "VND")).toBe("23000000000");
    expect(decimalToMicros("100.000", "JPY")).toBe("100000000");
  });

  it("rejects fractional values for zero-decimal currencies", () => {
    expect(() => decimalToMicros("1.99", "VND")).toThrow(
      /VND only accepts whole numbers/,
    );
    expect(() => decimalToMicros("0.99", "JPY")).toThrow(/JPY/);
    expect(() => decimalToMicros("100.5", "KRW")).toThrow(/KRW/);
  });

  it("respects 3-decimal precision (BHD/KWD/OMR)", () => {
    expect(decimalToMicros("1.250", "BHD")).toBe("1250000");
    expect(() => decimalToMicros("1.2345", "BHD")).toThrow(/BHD/);
  });

  it("preserves the no-currency legacy path", () => {
    // Without a currency arg, the old behaviour is unchanged — fractional
    // is allowed up to 6 digits regardless of what currency might apply.
    expect(decimalToMicros("1.99")).toBe("1990000");
    expect(decimalToMicros("0.000001")).toBe("1");
  });
});

describe("microsToDecimal", () => {
  it("converts common wire-format prices at default precision", () => {
    expect(microsToDecimal("1990000")).toBe("1.99");
    expect(microsToDecimal("990000")).toBe("0.99");
    expect(microsToDecimal("10000000")).toBe("10.00");
    expect(microsToDecimal("0")).toBe("0.00");
  });

  it("preserves sub-cent precision when requested", () => {
    expect(microsToDecimal("1500000", 6)).toBe("1.500000");
    expect(microsToDecimal("1", 6)).toBe("0.000001");
  });

  it("extends precision beyond displayDecimals only when nonzero remainder exists", () => {
    // 1.001 at default 2dp → '1.001' (would lose info otherwise)
    expect(microsToDecimal("1001000", 2)).toBe("1.001");
    // 1.00 at default 2dp → '1.00' (no hidden remainder)
    expect(microsToDecimal("1000000", 2)).toBe("1.00");
  });

  it("supports bigint input", () => {
    expect(microsToDecimal(BigInt(1_990_000))).toBe("1.99");
  });

  it("supports displayDecimals=0", () => {
    expect(microsToDecimal("1000000", 0)).toBe("1");
  });

  it("rejects non-integer micros strings", () => {
    expect(() => microsToDecimal("1.5")).toThrow();
    expect(() => microsToDecimal("abc")).toThrow();
    expect(() => microsToDecimal("-100")).toThrow();
  });

  it("rejects displayDecimals out of range", () => {
    expect(() => microsToDecimal("1000000", -1)).toThrow();
    expect(() => microsToDecimal("1000000", 7)).toThrow();
    expect(() => microsToDecimal("1000000", 2.5)).toThrow();
  });
});

describe("assertMicrosRoundTrip", () => {
  it("succeeds for clean round-trip values", () => {
    expect(() => assertMicrosRoundTrip("1.99")).not.toThrow();
    expect(() => assertMicrosRoundTrip("0", 0)).not.toThrow();
    expect(() => assertMicrosRoundTrip("1.500000", 6)).not.toThrow();
  });
});

describe("microsToMoney / moneyToMicros (Hotfix 8)", () => {
  it("converts USD micros → Money with units + nanos", () => {
    expect(microsToMoney("1990000", "USD")).toEqual({
      currencyCode: "USD",
      units: "1",
      nanos: 990_000_000,
    });
    expect(microsToMoney("0", "USD")).toEqual({
      currencyCode: "USD",
      units: "0",
      nanos: 0,
    });
    expect(microsToMoney("990000", "USD")).toEqual({
      currencyCode: "USD",
      units: "0",
      nanos: 990_000_000,
    });
  });

  it("converts VND (zero-decimal) micros → Money with zero nanos", () => {
    expect(microsToMoney("23000000000", "VND")).toEqual({
      currencyCode: "VND",
      units: "23000",
      nanos: 0,
    });
  });

  it("preserves smallest-unit micros (1 micro = 1000 nanos)", () => {
    expect(microsToMoney("1", "USD")).toEqual({
      currencyCode: "USD",
      units: "0",
      nanos: 1000,
    });
  });

  it("normalises currency case", () => {
    expect(microsToMoney("1990000", "usd").currencyCode).toBe("USD");
  });

  it("rejects negative or non-numeric input", () => {
    expect(() => microsToMoney("-1", "USD")).toThrow();
    expect(() => microsToMoney("abc", "USD")).toThrow();
  });

  it("converts Money → micros, truncating sub-micro nanos", () => {
    expect(moneyToMicros({ currencyCode: "USD", units: "1", nanos: 990_000_000 }))
      .toBe("1990000");
    expect(moneyToMicros({ currencyCode: "VND", units: "23000", nanos: 0 }))
      .toBe("23000000000");
    // 999 nanos (sub-micro) truncates to 0 micros.
    expect(moneyToMicros({ currencyCode: "USD", units: "0", nanos: 999 }))
      .toBe("0");
    // 1000 nanos = exactly 1 micro.
    expect(moneyToMicros({ currencyCode: "USD", units: "0", nanos: 1000 }))
      .toBe("1");
  });

  it("returns '0' for null / undefined Money", () => {
    expect(moneyToMicros(null)).toBe("0");
    expect(moneyToMicros(undefined)).toBe("0");
  });

  it("treats missing units / nanos as zero", () => {
    expect(moneyToMicros({ currencyCode: "USD" })).toBe("0");
  });

  it("round-trips micros → Money → micros without drift", () => {
    for (const m of ["1990000", "23000000000", "990000", "0", "1", "1500000"]) {
      expect(moneyToMicros(microsToMoney(m, "USD"))).toBe(m);
    }
  });

  it("rejects negative Money", () => {
    expect(() =>
      moneyToMicros({ currencyCode: "USD", units: "-1", nanos: 0 }),
    ).toThrow();
  });
});
