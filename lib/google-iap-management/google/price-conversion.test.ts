import { describe, it, expect } from "vitest";

import {
  decimalToMicros,
  microsToDecimal,
  assertMicrosRoundTrip,
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
