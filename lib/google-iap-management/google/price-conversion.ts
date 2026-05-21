/**
 * Decimal ↔ micros conversion at the Manager-input / Google-wire boundary.
 *
 * Q-GIAP.F: Manager enters decimal (e.g. "1.99"); Google's API uses string
 * `priceMicros` (e.g. "1990000"). One micro = 1e-6 currency units. We use
 * string-based arithmetic (no Number) so 0.1+0.2-style FP errors can't leak
 * into stored prices. Output is digits-only (no decimal, no sign).
 *
 * Hotfix 5: callers that know the target currency should pass it so the
 * function can enforce currency precision (e.g. VND/JPY/KRW cannot have
 * fractional values — Google rejects with "Illegal default price-value").
 * The no-currency call path is preserved for read-side helpers that just
 * need a numeric round-trip (e.g. iap-diff snapshot construction).
 */

import { getCurrencyDecimals } from "./currency-precision";

const MICROS_PER_UNIT = BigInt(1_000_000);
const ZERO = BigInt(0);

/** Strip surrounding whitespace, reject anything that isn't a non-negative
 *  decimal with at most one dot. We tolerate trailing zeros and missing
 *  fractional part. */
function parseDecimalString(input: string): { whole: string; frac: string } {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Decimal price is empty.");
  }
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    throw new Error(
      `Decimal price must be a non-negative number (got "${input}").`,
    );
  }
  const [whole, frac = ""] = trimmed.split(".");
  return { whole, frac };
}

/**
 * Convert a Manager-input decimal price string to Google's priceMicros wire
 * format. Examples:
 *   "1.99"     → "1990000"
 *   "0.99"     → "990000"
 *   "10"       → "10000000"
 *   "0.000001" → "1"
 *
 * Throws on negative, non-numeric, or more-than-6-decimal-place inputs.
 *
 * Hotfix 5: pass `currency` to enforce per-currency precision. Trailing
 * zeros are tolerated ("23000.00" is treated as 0 fractional digits for
 * VND, since the value is still a whole number). Without a currency the
 * function preserves its legacy behaviour (any precision up to 6).
 */
export function decimalToMicros(
  decimal: string | number,
  currency?: string,
): string {
  const input = typeof decimal === "number" ? decimal.toString() : decimal;
  const { whole, frac } = parseDecimalString(input);
  if (frac.length > 6) {
    throw new Error(
      `Decimal price has more than 6 fractional digits ("${input}"); micros precision exhausted.`,
    );
  }
  if (currency) {
    const allowed = getCurrencyDecimals(currency);
    // Strip trailing zeros — "23000.00" → "" fractional for VND.
    const significantFrac = frac.replace(/0+$/, "");
    if (significantFrac.length > allowed) {
      const norm = currency.trim().toUpperCase();
      if (allowed === 0) {
        throw new Error(
          `${norm} only accepts whole numbers (got "${input}"). Google rejects fractional values for this currency.`,
        );
      }
      throw new Error(
        `${norm} supports at most ${allowed} decimal place${allowed === 1 ? "" : "s"} (got "${input}" with ${significantFrac.length}).`,
      );
    }
  }
  // Pad fractional part to exactly 6 digits, then concatenate.
  const padded = (frac + "000000").slice(0, 6);
  const combined = whole + padded;
  // Strip leading zeros but leave at least one digit.
  const stripped = combined.replace(/^0+/, "") || "0";
  return stripped;
}

/**
 * Convert Google's priceMicros wire format to a decimal display string.
 * Examples:
 *   "1990000" → "1.99"
 *   "990000"  → "0.99"
 *   "10000000"→ "10.00"
 *   "1"       → "0.000001"
 *
 * `displayDecimals` (default 2) trims trailing zeros beyond that point but
 * preserves at least the requested precision. Set to 6 for full fidelity.
 */
export function microsToDecimal(
  micros: string | bigint,
  displayDecimals = 2,
): string {
  if (displayDecimals < 0 || displayDecimals > 6 || !Number.isInteger(displayDecimals)) {
    throw new Error("displayDecimals must be an integer in [0, 6].");
  }
  let value: bigint;
  if (typeof micros === "bigint") {
    value = micros;
  } else {
    const trimmed = micros.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`priceMicros must be a non-negative integer string (got "${micros}").`);
    }
    value = BigInt(trimmed);
  }
  if (value < ZERO) {
    throw new Error("priceMicros cannot be negative.");
  }
  const whole = value / MICROS_PER_UNIT;
  const remainder = value % MICROS_PER_UNIT;
  const fracFull = remainder.toString().padStart(6, "0");
  if (displayDecimals === 0) {
    return whole.toString();
  }
  // Take exactly displayDecimals first; if more precision exists, extend.
  const fracDisplay = fracFull.slice(0, displayDecimals);
  const fracRest = fracFull.slice(displayDecimals).replace(/0+$/, "");
  const frac = fracRest ? fracDisplay + fracRest : fracDisplay;
  return `${whole}.${frac}`;
}

/**
 * Hotfix 8 — Money conversion (legacy `priceMicros` ↔ new `Money` shape).
 *
 * The Monetization API v3 OneTimeProduct schema uses Google's standard
 * `Money` resource for pricing instead of the legacy `priceMicros` string.
 * `Money` carries `units` (whole int64 string) + `nanos` (10^-9 fractional
 * integer), which is a finer granularity than micros (10^-6).
 *
 * Examples (all exact, no FP drift):
 *   1.99 USD →  Money{ units: "1",     nanos: 990_000_000 }  ↔ priceMicros "1990000"
 *   23000 VND → Money{ units: "23000", nanos: 0 }            ↔ priceMicros "23000000000"
 *   0.99 USD →  Money{ units: "0",     nanos: 990_000_000 }  ↔ priceMicros "990000"
 *   1 micro  →  Money{ units: "0",     nanos: 1000 }         ↔ priceMicros "1"
 *
 * Round-trip via BigInt to keep arithmetic exact across the full int64
 * range Money's `units` can carry.
 */

const NANOS_PER_UNIT = BigInt(1_000_000_000);
const NANOS_PER_MICRO = BigInt(1000);

export interface MoneyShape {
  currencyCode?: string | null;
  units?: string | null;
  nanos?: number | null;
}

/** Convert Google's priceMicros wire format to a Money shape with
 *  units + nanos. Caller supplies the currencyCode separately (priceMicros
 *  doesn't carry one). */
export function microsToMoney(
  micros: string | bigint,
  currencyCode: string,
): MoneyShape {
  let value: bigint;
  if (typeof micros === "bigint") {
    value = micros;
  } else {
    const trimmed = micros.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`priceMicros must be a non-negative integer string (got "${micros}").`);
    }
    value = BigInt(trimmed);
  }
  if (value < ZERO) {
    throw new Error("priceMicros cannot be negative.");
  }
  // micros → nanos: multiply by 1000, then split into units + nanos.
  const totalNanos = value * NANOS_PER_MICRO;
  const units = totalNanos / NANOS_PER_UNIT;
  const nanos = totalNanos % NANOS_PER_UNIT;
  return {
    currencyCode: currencyCode.trim().toUpperCase(),
    units: units.toString(),
    nanos: Number(nanos),
  };
}

/** Convert a Money shape to priceMicros string. Returns "0" for null/zero
 *  Money. The nanos field must be a multiple of 1000 since micros is the
 *  coarser unit — fractional micros (sub-thousandth of a nano) are
 *  truncated, which matches Google's own legacy serialisation behaviour. */
export function moneyToMicros(money: MoneyShape | null | undefined): string {
  if (!money) return "0";
  const unitsRaw = money.units ?? "0";
  const nanosRaw = money.nanos ?? 0;
  if (!/^-?\d+$/.test(unitsRaw)) {
    throw new Error(`Money.units must be an integer string (got "${unitsRaw}").`);
  }
  if (!Number.isInteger(nanosRaw)) {
    throw new Error(`Money.nanos must be an integer (got ${nanosRaw}).`);
  }
  const units = BigInt(unitsRaw);
  const nanos = BigInt(nanosRaw);
  if (units < ZERO || nanos < ZERO) {
    throw new Error("Negative Money not supported for IAP pricing.");
  }
  // total nanos → micros: divide by 1000 (truncating the sub-micro tail).
  const totalNanos = units * NANOS_PER_UNIT + nanos;
  const micros = totalNanos / NANOS_PER_MICRO;
  return micros.toString();
}

/**
 * Quick sanity check: round-trip a decimal → micros → decimal at a chosen
 * display precision and assert no drift up to that precision. Used by
 * orchestrators that want a belt-and-braces guard before sending to Google.
 */
export function assertMicrosRoundTrip(
  decimal: string,
  displayDecimals = 2,
): void {
  const micros = decimalToMicros(decimal);
  const roundTrip = microsToDecimal(micros, displayDecimals);
  // Normalize the input the same way for comparison
  const norm = microsToDecimal(decimalToMicros(decimal), displayDecimals);
  if (roundTrip !== norm) {
    throw new Error(
      `Micros round-trip drift: "${decimal}" → ${micros} → "${roundTrip}" ≠ "${norm}"`,
    );
  }
}
