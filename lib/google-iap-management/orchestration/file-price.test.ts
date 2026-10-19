/**
 * H4.1 — the file-price choke point. Every refusal is a refusal of the ROW;
 * nothing here can substitute another price or read the app's currency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  filePriceOf,
  fileRegionPriceOf,
  PLAY_BILLING_CURRENCIES,
  statedPriceError,
  statedPriceOf,
  storedRegionPriceOf,
} from "./file-price";
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
    expect(filePriceOf({ currency: "TWD", priceDecimal: "30.5", cell: "number" })).toEqual({
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

describe("H4.2 (a) thousands separators, (b) zero", () => {
  it("(a) a no-decimals currency typed as TEXT with '.' or ',' ⇒ refused; a NUMBER keeps its reading", () => {
    for (const raw of ["26.000", "26,000", "26.", "1.234.567", "26,5", "49.900", "26.500"]) {
      const r = filePriceOf({ currency: "VND", priceDecimal: raw });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/it may be a thousands separator \(26\.000 = 26 thousand\?\)/);
    }
    // H4.3 — a REAL fraction is still refused, but by the precision rule and
    // its own words (Google's TWD 6.30 is not "a thousands separator").
    expect(filePriceOf({ currency: "VND", priceDecimal: "30.5" })).toEqual({
      ok: false,
      reason: 'VND only accepts whole numbers (got "30.5"). Google rejects fractional values for this currency.',
    });
    // 2 or 4 fraction digits cannot be a thousands group: precision wording too.
    expect(filePriceOf({ currency: "VND", priceDecimal: "26.50" }).ok && "ok").toBe(false);
    expect((filePriceOf({ currency: "VND", priceDecimal: "26.50" }) as { reason: string }).reason).toMatch(/^VND only accepts whole numbers/);
    expect((filePriceOf({ currency: "TWD", priceDecimal: "6.3000" }) as { reason: string }).reason).toMatch(/^TWD only accepts whole numbers/);
    expect(filePriceOf({ currency: "VND", priceDecimal: "26000", cell: "number" })).toEqual({ ok: true, currency: "VND", priceMicros: "26000000000" });
    expect(filePriceOf({ currency: "VND", priceDecimal: "26000" }).ok).toBe(true);
    // Every no-decimals currency, not just VND.
    for (const c of ["IDR", "KRW", "JPY", "TWD"]) expect(filePriceOf({ currency: c, priceDecimal: "1.000" }).ok).toBe(false);
  });

  it("(a) Hotfix 5 kept for currencies WITH decimals: '0.990' USD is 0.99", () => {
    expect(filePriceOf({ currency: "USD", priceDecimal: "0.990" })).toEqual({ ok: true, currency: "USD", priceMicros: "990000" });
  });

  it("(b) 0 in any spelling ⇒ refused, for the main price and a GT", () => {
    for (const raw of ["0", "0.00", "0.000000"]) {
      expect(filePriceOf({ currency: "USD", priceDecimal: raw })).toEqual({
        ok: false,
        reason: "the price is 0 — a 0 price is not accepted; enter the real price.",
      });
    }
    expect(fileRegionPriceOf({ region: "VN", currency: "VND", priceDecimal: "0", cell: "number" }).ok).toBe(false);
  });
});

describe("H4.3 — statedPriceOf: ONE rule set for every price a person writes (file, custom dialog, item form)", () => {
  it("the same (a) / precision / (b) as filePriceOf, but no Play-currency gate (typed surfaces use Google's live catalog)", () => {
    expect(statedPriceOf({ currency: "VND", priceDecimal: "26000" })).toEqual({ ok: true, currency: "VND", priceMicros: "26000000000" });
    expect(statedPriceOf({ currency: "VND", priceDecimal: "26.000" }).ok).toBe(false);
    expect(statedPriceOf({ currency: "USD", priceDecimal: "0" }).ok).toBe(false);
    expect(statedPriceOf({ currency: "USD", priceDecimal: "0.990" })).toEqual({ ok: true, currency: "USD", priceMicros: "990000" });
    // CNY is not billed by Play (filePriceOf refuses it), but a typed value is
    // only checked against its own currency's rules here.
    expect(filePriceOf({ currency: "CNY", priceDecimal: "7" }).ok).toBe(false);
    expect(statedPriceOf({ currency: "CNY", priceDecimal: "7" }).ok).toBe(true);
  });

  it("statedPriceError: null for blank or valid, the reason otherwise — what the dialog and the form show", () => {
    expect(statedPriceError("", "VND")).toBeNull();
    expect(statedPriceError("  ", "VND")).toBeNull();
    expect(statedPriceError("26000", "VND")).toBeNull();
    expect(statedPriceError("26.000", "VND")).toMatch(/may be a thousands separator/);
    expect(statedPriceError("0", "JPY")).toBe("the price is 0 — a 0 price is not accepted; enter the real price.");
    expect(statedPriceError("1499.50", "JPY")).toMatch(/^JPY only accepts whole numbers/);
  });

  it("filePriceOf IS the Play gate + statedPriceOf (one body, not a copy)", () => {
    const src = readFileSync(join(__dirname, "file-price.ts"), "utf8");
    const body = src.slice(src.indexOf("export function filePriceOf("), src.indexOf("export function statedPriceOf("));
    expect(body).toMatch(/return statedPriceOf\(/);
    expect(body).not.toMatch(/decimalToMicros|thousandsSeparatorIn|priceMicros === "0"/);
  });
});

describe("H4.3 — storedRegionPriceOf: a tier entry the tool holds as micros", () => {
  it("whole amounts in a currency without decimals are fine — '26000.000000' is NOT a thousands separator", () => {
    expect(storedRegionPriceOf({ currency: "VND", priceMicros: "26000000000" })).toEqual({ ok: true, currency: "VND", priceMicros: "26000000000" });
    expect(storedRegionPriceOf({ currency: "TWD", priceMicros: "30000000" }).ok).toBe(true);
    expect(storedRegionPriceOf({ currency: "USD", priceMicros: "990000" }).ok).toBe(true);
  });

  it("wrong precision (TWD 30.5, USD 0.999) and 0 are refused with the shared words", () => {
    expect(storedRegionPriceOf({ currency: "TWD", priceMicros: "30500000" })).toEqual({
      ok: false,
      reason: 'TWD only accepts whole numbers (got "30.5"). Google rejects fractional values for this currency.',
    });
    expect(storedRegionPriceOf({ currency: "USD", priceMicros: "999000" }).ok).toBe(false);
    expect(storedRegionPriceOf({ currency: "TWD", priceMicros: "0" })).toEqual({
      ok: false,
      reason: "the price is 0 — a 0 price is not accepted; enter the real price.",
    });
    expect(storedRegionPriceOf({ currency: "TWD", priceMicros: "abc" }).ok).toBe(false);
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
