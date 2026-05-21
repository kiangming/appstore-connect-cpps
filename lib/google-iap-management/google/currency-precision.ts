/**
 * ISO 4217 currency exponent (decimal precision) lookup — Hotfix 5.
 *
 * Google Play's `priceMicros` is always "1/million of the currency base
 * unit", regardless of currency. So 1.99 USD = 1,990,000 micros (valid:
 * USD has 2 decimal places) but 1.99 VND would mean 1.99 of the smallest
 * VND unit (1 VND = 1,000,000 micros), i.e. 0.99 VND fractional — which
 * doesn't exist in the wild and Google rejects with "Illegal default
 * price-value".
 *
 * The exponent table below is the ISO 4217 specification. Currencies not
 * listed default to 2 (the overwhelmingly common case). Callers that
 * have a specific currency should pass it; callers that don't can use
 * the "no validation" path (decimalToMicros without a currency arg).
 *
 * This module is intentionally minimal — it does NOT enforce minimum
 * prices (those are per-developer-payouts-country and change; Google
 * still does that check server-side). Scope here is exponent only.
 */

/** ISO 4217 currency exponents (decimal places). Sourced from the
 *  specification's table A.1. Currencies with exponent 0 cannot carry
 *  fractional values; their priceMicros must be a multiple of 1,000,000. */
const CURRENCY_DECIMALS: Record<string, number> = {
  // Exponent 0 — no minor unit (the bug class Hotfix 5 fixes).
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IDR: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  LAK: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  HUF: 0, // technically 2 in ISO 4217 but Google Play treats HUF as 0
  TWD: 0, // ISO 4217 says 2; Google Play Console treats TWD as 0 in practice
  // (kept here because the Manager portfolio includes TW)

  // Exponent 3 — rare 3-decimal currencies.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,

  // Exponent 4 — Unidad de Fomento (rare, listed for completeness).
  CLF: 4,
  UYW: 4,

  // Everything else (USD, EUR, GBP, CNY, INR, ...) → default exponent 2.
};

/** Default decimal places for currencies not in the override table.
 *  Most modern currencies use 2 (cents). */
const DEFAULT_DECIMALS = 2;

/**
 * Return the number of fractional digits a currency supports.
 * Unknown currencies fall back to {@link DEFAULT_DECIMALS}.
 * Case-insensitive; whitespace tolerated.
 */
export function getCurrencyDecimals(currency: string | null | undefined): number {
  if (!currency) return DEFAULT_DECIMALS;
  const norm = currency.trim().toUpperCase();
  if (norm === "") return DEFAULT_DECIMALS;
  return Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, norm)
    ? CURRENCY_DECIMALS[norm]
    : DEFAULT_DECIMALS;
}

/**
 * Validate a decimal price string against a currency's allowed precision.
 * Returns null when valid, an error message string when invalid.
 * The error message names the currency + the offending input so the UI
 * can surface it inline without re-formatting.
 *
 * Empty / whitespace-only input returns null (caller decides whether
 * "required" applies). Non-numeric input returns a generic error.
 */
export function validateDecimalForCurrency(
  decimal: string,
  currency: string,
): string | null {
  const trimmed = decimal.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    return `Price must be a non-negative number (got "${decimal}").`;
  }
  const dotIdx = trimmed.indexOf(".");
  const fracLen = dotIdx === -1
    ? 0
    : trimmed.slice(dotIdx + 1).replace(/0+$/, "").length;
  const allowed = getCurrencyDecimals(currency);
  if (fracLen > allowed) {
    const norm = currency.trim().toUpperCase();
    if (allowed === 0) {
      return `${norm} only accepts whole numbers (got "${decimal}"). Google rejects fractional values for this currency.`;
    }
    return `${norm} supports at most ${allowed} decimal place${allowed === 1 ? "" : "s"} (got "${decimal}" with ${fracLen}).`;
  }
  return null;
}

/**
 * UI helper: the `step` attribute to feed into an <input type="number">
 * so the browser surfaces a currency-appropriate spinner / mobile keypad.
 * Examples: USD → "0.01", VND → "1", BHD → "0.001".
 */
export function inputStepForCurrency(currency: string): string {
  const decimals = getCurrencyDecimals(currency);
  if (decimals === 0) return "1";
  return `0.${"0".repeat(decimals - 1)}1`;
}
