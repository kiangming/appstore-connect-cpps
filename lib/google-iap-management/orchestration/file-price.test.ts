/**
 * H4.1 — the file-price choke point. Every refusal is a refusal of the ROW;
 * nothing here can substitute another price or read the app's currency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { filePriceOf, fileRegionPriceOf, PLAY_BILLING_CURRENCIES } from "./file-price";
import { PLAY_REGIONS } from "../google/play-regions.snapshot";

describe("filePriceOf", () => {
  it("the file's decimal in the file's currency → micros", () => {
    expect(filePriceOf({ currency: "USD", priceDecimal: "0.99" })).toEqual({ ok: true, currency: "USD", priceMicros: "990000" });
    expect(filePriceOf({ currency: "vnd", priceDecimal: "26000" })).toEqual({ ok: true, currency: "VND", priceMicros: "26000000000" });
  });

  it("a currency Google Play does not bill in ⇒ refused", () => {
    expect(filePriceOf({ currency: "CNY", priceDecimal: "7" })).toEqual({ ok: false, reason: '"CNY" is not a currency Google Play bills in.' });
    expect(filePriceOf({ currency: "ABC", priceDecimal: "1" }).ok).toBe(false);
  });

  it("more decimals than the currency allows, or not a number ⇒ refused with the precision module's own words", () => {
    expect(filePriceOf({ currency: "TWD", priceDecimal: "30.5" })).toEqual({
      ok: false,
      reason: 'TWD only accepts whole numbers (got "30.5"). Google rejects fractional values for this currency.',
    });
    expect(filePriceOf({ currency: "USD", priceDecimal: "0.999" }).ok).toBe(false);
    expect(filePriceOf({ currency: "USD", priceDecimal: "abc" }).ok).toBe(false);
    expect(filePriceOf({ currency: "USD", priceDecimal: "-1" }).ok).toBe(false);
  });

  it("the currency list IS the measured Play catalog (one source)", () => {
    expect([...PLAY_BILLING_CURRENCIES].sort()).toEqual([...new Set(PLAY_REGIONS.map((r) => r.currency))].sort());
  });
});

describe("fileRegionPriceOf (a GT override)", () => {
  it("region billed in that currency ⇒ ok", () => {
    expect(fileRegionPriceOf({ region: "VN", currency: "VND", priceDecimal: "26000" })).toEqual({
      ok: true,
      currency: "VND",
      priceMicros: "26000000000",
    });
  });

  it("pair not in the catalog ⇒ refused, naming what Google bills instead", () => {
    expect(fileRegionPriceOf({ region: "AR", currency: "ARS", priceDecimal: "900" })).toEqual({
      ok: false,
      reason: "Google Play bills AR in USD, not ARS.",
    });
    expect(fileRegionPriceOf({ region: "CN", currency: "CNY", priceDecimal: "7" })).toEqual({
      ok: false,
      reason: "CN is not a region Google Play sells in.",
    });
  });

  it("precision is checked against the GT currency", () => {
    expect(fileRegionPriceOf({ region: "VN", currency: "VND", priceDecimal: "26000.5" }).ok).toBe(false);
  });
});

describe("structural", () => {
  it("file-price.ts takes no app currency in any spelling", () => {
    const src = readFileSync(join(__dirname, "file-price.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/appDefaultCurrency|default_currency|appCurrency|AppCurrency/);
  });
});
