import { describe, it, expect } from "vitest";

import {
  inferCurrencyFromLanguage,
  isKnownLanguage,
} from "./region-currency-map";

describe("inferCurrencyFromLanguage", () => {
  it("maps known BCP-47 codes exactly", () => {
    expect(inferCurrencyFromLanguage("vi-VN")).toBe("VND");
    expect(inferCurrencyFromLanguage("ja-JP")).toBe("JPY");
    expect(inferCurrencyFromLanguage("en-GB")).toBe("GBP");
    expect(inferCurrencyFromLanguage("pt-BR")).toBe("BRL");
  });

  it("strips region tag and retries the base when full code unknown", () => {
    // "vi" is in the map, "vi-Latn" is not — should fall through to "vi".
    expect(inferCurrencyFromLanguage("vi-Latn")).toBe("VND");
    expect(inferCurrencyFromLanguage("fr-CH-something")).toBe("EUR");
  });

  it("returns USD for unknown language", () => {
    expect(inferCurrencyFromLanguage("xx-YY")).toBe("USD");
    expect(inferCurrencyFromLanguage("klingon")).toBe("USD");
  });

  it("returns USD for null / empty / whitespace input", () => {
    expect(inferCurrencyFromLanguage(null)).toBe("USD");
    expect(inferCurrencyFromLanguage(undefined)).toBe("USD");
    expect(inferCurrencyFromLanguage("")).toBe("USD");
    expect(inferCurrencyFromLanguage("   ")).toBe("USD");
  });

  it("preserves regional overrides over base language", () => {
    // "fr" maps to EUR; "fr-CA" must map to CAD, not EUR.
    expect(inferCurrencyFromLanguage("fr-CA")).toBe("CAD");
    // "en" maps to USD; "en-IN" must map to INR.
    expect(inferCurrencyFromLanguage("en-IN")).toBe("INR");
  });
});

describe("isKnownLanguage", () => {
  it("returns true for full-code and base-language matches", () => {
    expect(isKnownLanguage("vi-VN")).toBe(true);
    expect(isKnownLanguage("vi")).toBe(true);
    expect(isKnownLanguage("vi-Latn")).toBe(true); // base "vi" wins
  });

  it("returns false for unknown + empty inputs", () => {
    expect(isKnownLanguage("klingon")).toBe(false);
    expect(isKnownLanguage("")).toBe(false);
    expect(isKnownLanguage(null)).toBe(false);
    expect(isKnownLanguage(undefined)).toBe(false);
  });
});
