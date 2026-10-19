/**
 * H4 — "the currency written in the import FILE is the ONLY price source"
 * (Manager 2026-10-16). THE choke point for reading a price out of the file.
 *
 * ⚠ ONE function per kind of file price (KB P1). Every place that needs the
 *   file's price asks here — the parser (H4.1), and from H4.2/H4.3 the tier
 *   lookup, the conversion anchor, defaultPrice, custom prices and the
 *   execute route's per-row re-check. A second private reading (another
 *   currency list, another precision rule, a fallback currency) is exactly
 *   how the app currency got into pricing in the first place.
 * ⚠ No app currency, by construction: nothing here takes one. A refusal is
 *   a refusal of the ROW — never a substitution of some other price.
 */
import { PLAY_REGIONS } from "../google/play-regions.snapshot";
import { decimalToMicros } from "../google/price-conversion";
import { getCurrencyDecimals } from "../google/currency-precision";

/** Currencies Google Play bills in — the pinned 173-region catalog. */
export const PLAY_BILLING_CURRENCIES: ReadonlySet<string> = new Set(PLAY_REGIONS.map((r) => r.currency));

/** Region code → the currency Google Play bills that region in. */
const BILLED_IN: ReadonlyMap<string, string> = new Map(PLAY_REGIONS.map((r) => [r.code, r.currency]));

export type FilePrice =
  | { ok: true; currency: string; priceMicros: string }
  | { ok: false; reason: string };

/** How the value was written in the file. An Excel NUMBER cell arrives as a
 *  normalised decimal; anything else (a text cell, or a string posted to the
 *  execute route) is TEXT. */
export type FileCell = "text" | "number";

/** The row's main price: the file's decimal in the file's currency. */
export function filePriceOf(price: { currency: string; priceDecimal: string; cell?: FileCell }): FilePrice {
  const currency = price.currency.trim().toUpperCase();
  if (!PLAY_BILLING_CURRENCIES.has(currency)) {
    return { ok: false, reason: `"${currency}" is not a currency Google Play bills in.` };
  }
  const raw = price.priceDecimal.trim();
  // H4.2 (Manager 2026-10-18, a) — a currency with NO decimals (VND, IDR,
  // KRW, JPY, TWD…) typed as TEXT with "." or ",": most likely a thousands
  // separator — "26.000" read as 26 would be a price 1000× too low. Refused.
  // ⚠ This narrows Hotfix 5, which tolerates trailing zeros ("23000.00"):
  //   kept for currencies WITH decimals ("0.990" USD), and for Excel NUMBER
  //   cells (the parser passes cell: "number"; a number has no separator).
  const separator = raw.match(/[.,]/)?.[0];
  if ((price.cell ?? "text") === "text" && separator && getCurrencyDecimals(currency) === 0) {
    return {
      ok: false,
      reason: `"${raw}" has a "${separator}" but ${currency} has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.`,
    };
  }
  let priceMicros: string;
  try {
    priceMicros = decimalToMicros(raw, currency);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  // H4.2 (Manager 2026-10-18, b) — a 0 price is refused, never sent.
  if (priceMicros === "0") {
    return { ok: false, reason: "the price is 0 — a 0 price is not accepted; enter the real price." };
  }
  return { ok: true, currency, priceMicros };
}

/** A GT override: a price for ONE region, in the currency Google bills that
 *  region in. Refused when the pair does not match the catalog (Google would
 *  not bill that region in that currency) or the price breaks the currency's
 *  precision. */
export function fileRegionPriceOf(o: {
  region: string;
  currency: string;
  priceDecimal: string;
  cell?: FileCell;
}): FilePrice {
  const region = o.region.trim().toUpperCase();
  const currency = o.currency.trim().toUpperCase();
  const billed = BILLED_IN.get(region);
  if (billed !== currency) {
    return {
      ok: false,
      reason: billed
        ? `Google Play bills ${region} in ${billed}, not ${currency}.`
        : `${region} is not a region Google Play sells in.`,
    };
  }
  return filePriceOf({ currency, priceDecimal: o.priceDecimal, cell: o.cell });
}
