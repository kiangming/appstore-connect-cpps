/**
 * H4 — "the currency written in the import FILE is the ONLY price source"
 * (Manager 2026-10-16). THE choke point for reading a price out of the file.
 *
 * ⚠ ONE function per kind of file price (KB P1). Every place that needs the
 *   file's price asks here — the parser (H4.1), the preview tier lookup, the
 *   orchestrator's per-row re-check (the server side of Q9), the conversion
 *   anchor, defaultPrice, and the custom-price and tier-entry checks. A second private reading (another
 *   currency list, another precision rule, a fallback currency) is exactly
 *   how the app currency got into pricing in the first place.
 * ⚠ H4.3 — the rules for a price a PERSON wrote (the thousands-separator
 *   rule, precision, no 0) live in ONE function, `statedPriceOf`, shared by
 *   the file (filePriceOf), the custom-prices dialog, the single-item form
 *   and the server's custom re-check; prices the TOOL produced (a stored
 *   tier entry) go through `storedRegionPriceOf`, the same rules on micros.
 * ⚠ No app currency, by construction: nothing here takes one. A refusal is
 *   a refusal of the ROW — never a substitution of some other price.
 * ⚠ Client-safe: pure data and pure functions only (the dialog and the item
 *   form import it).
 */
import { PLAY_REGIONS } from "../google/play-regions.snapshot";
import { decimalToMicros, microsToDecimal, stripTrailingZeros } from "../google/price-conversion";
import { getCurrencyDecimals } from "../google/currency-precision";

/** Currencies Google Play bills in — the pinned 173-region catalog. */
export const PLAY_BILLING_CURRENCIES: ReadonlySet<string> = new Set(PLAY_REGIONS.map((r) => r.currency));

export type FilePrice =
  | { ok: true; currency: string; priceMicros: string }
  | { ok: false; reason: string };

/** How the value was written in the file. An Excel NUMBER cell arrives as a
 *  normalised decimal; anything else (a text cell, or a string posted to the
 *  execute route) is TEXT. */
export type FileCell = "text" | "number";

/** The row's main price: the file's decimal in the file's currency, which
 *  must be one Google Play bills in. */
export function filePriceOf(price: { currency: string; priceDecimal: string; cell?: FileCell }): FilePrice {
  const currency = price.currency.trim().toUpperCase();
  if (!PLAY_BILLING_CURRENCIES.has(currency)) {
    return { ok: false, reason: `"${currency}" is not a currency Google Play bills in.` };
  }
  return statedPriceOf({ currency, priceDecimal: price.priceDecimal, cell: price.cell });
}

/**
 * A price a PERSON stated for a currency — a file cell, or a value typed in
 * the custom-prices dialog or the single-item form. THE one definition of
 * the rules (KB P1); no currency gate here (the typed surfaces take their
 * currency from Google's live catalog, not the pinned snapshot).
 *
 *  (a) H4.2 (Manager 2026-10-18) — a currency with NO decimals (VND, IDR,
 *      KRW, JPY, TWD…) written as TEXT with "," or a "." whose fraction is
 *      only zeros ("26.000", "26.", "1.234.567"): most likely a thousands
 *      separator — "26.000" read as 26 would be a price 1000× too low.
 *      Refused. ⚠ This narrows Hotfix 5, which tolerates trailing zeros
 *      ("23000.00"): kept for currencies WITH decimals ("0.990" USD), and for
 *      Excel NUMBER cells (the parser passes cell: "number"; a number has no
 *      separator). H4.3: a fraction that cannot be a thousands group ("30.5"
 *      TWD — 1, 2 or 4+ digits) is refused by the precision rule with the
 *      precision wording; calling Google's own TWD 6.30 "a thousands
 *      separator" would send the Manager the wrong way. "49.900" (3 digits)
 *      keeps the separator wording. The set of refused values is H4.2's.
 *      H4.3 (Manager 2026-10-19): the same rule for typed custom prices and
 *      the item form — applied here, not in validateDecimalForCurrency,
 *      because the tool's own seeds ("26000.00", "26000.000000") pass
 *      through that one.
 *  (b) H4.2 — a 0 price is refused, never sent.
 */
export function statedPriceOf(price: { currency: string; priceDecimal: string; cell?: FileCell }): FilePrice {
  const currency = price.currency.trim().toUpperCase();
  const raw = price.priceDecimal.trim();
  if ((price.cell ?? "text") === "text" && getCurrencyDecimals(currency) === 0) {
    const separator = thousandsSeparatorIn(raw);
    if (separator) {
      return {
        ok: false,
        reason: `"${raw}" has a "${separator}" but ${currency} has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.`,
      };
    }
  }
  let priceMicros: string;
  try {
    priceMicros = decimalToMicros(raw, currency);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (priceMicros === "0") {
    return { ok: false, reason: "the price is 0 — a 0 price is not accepted; enter the real price." };
  }
  return { ok: true, currency, priceMicros };
}

/** "," anywhere, more than one ".", or one "." followed by only zeros or by
 *  exactly THREE digits ("26.000", "49.900" = 49 thousand 900 in the
 *  Vietnamese way of writing). Any other single "." ("30.5", "6.30") is left
 *  to the precision rule — a real fraction, said in its own words. */
function thousandsSeparatorIn(raw: string): "," | "." | null {
  if (raw.includes(",")) return ",";
  const dots = raw.split(".").length - 1;
  if (dots > 1) return ".";
  if (dots === 1) {
    const frac = raw.slice(raw.indexOf(".") + 1);
    if (/^0*$/.test(frac) || /^\d{3}$/.test(frac)) return ".";
  }
  return null;
}

/** UI form of `statedPriceOf`: null when valid or blank (the caller decides
 *  whether blank is allowed), else the reason. */
export function statedPriceError(priceDecimal: string, currency: string): string | null {
  if (priceDecimal.trim() === "") return null;
  const r = statedPriceOf({ currency, priceDecimal });
  return r.ok ? null : r.reason;
}

/** A price the TOOL holds as micros — a pricing-template tier entry. The
 *  same precision and no-0 rules as a stated price, applied to the stored
 *  amount (H4.3: a TWD 30.5 entry used to throw the whole batch). Never
 *  text semantics: "26000.000000" is not a thousands separator. The region /
 *  currency pair is NOT checked against the pinned snapshot here — a tier's
 *  currencies follow Google's live catalog (Hotfix 9). */
export function storedRegionPriceOf(o: { currency: string; priceMicros: string }): FilePrice {
  let decimal: string;
  try {
    decimal = stripTrailingZeros(microsToDecimal(o.priceMicros, 6));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return statedPriceOf({ currency: o.currency, priceDecimal: decimal, cell: "number" });
}
