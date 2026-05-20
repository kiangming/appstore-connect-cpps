/**
 * Decimal ↔ micros conversion at the Manager-input / Google-wire boundary.
 *
 * Q-GIAP.F: Manager enters decimal (e.g. "1.99"); Google's API uses string
 * `priceMicros` (e.g. "1990000"). One micro = 1e-6 currency units. We use
 * string-based arithmetic (no Number) so 0.1+0.2-style FP errors can't leak
 * into stored prices. Output is digits-only (no decimal, no sign).
 *
 * Currency-aware formatting (decimal places) lives at the UI layer; this
 * module is pure micros arithmetic.
 */

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
 */
export function decimalToMicros(decimal: string | number): string {
  const input = typeof decimal === "number" ? decimal.toString() : decimal;
  const { whole, frac } = parseDecimalString(input);
  if (frac.length > 6) {
    throw new Error(
      `Decimal price has more than 6 fractional digits ("${input}"); micros precision exhausted.`,
    );
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
