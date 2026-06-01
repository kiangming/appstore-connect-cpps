/**
 * Cross-currency price resolution for Google bulk import.
 *
 * Problem this solves: a Manager-uploaded bulk-import file may carry
 * a Price column whose values are USD-style tier anchors (4.99, 9.99,
 * 21.99, 35.99) but be imported against an app whose default currency
 * is whole-number-only (VND, JPY, KRW). Without resolution, the
 * orchestrator's downstream `decimalToMicros(filePrice, "VND")` throws
 * because VND has zero fractional digits, and the entire batch fails.
 *
 * Resolution strategy (Manager-locked, single-source-of-truth):
 *   1. Detect cross-currency rows by precision violation: a row qualifies
 *      when `validateDecimalForCurrency(price, baseCurrency)` returns an
 *      error (i.e. the raw value cannot be sent in the row's resolved
 *      currency).
 *   2. Re-interpret the file Price as a **USD anchor** and match against
 *      the active pricing template by exact `(currency=USD, priceMicros)`
 *      equality — the same primitive `findCandidateTiersForCurrencyPrice`
 *      already uses for the Hotfix 19 same-currency disambiguation.
 *   3. Outcomes:
 *        - 0 candidates → refuse the row (per-row fail-soft, log + audit).
 *        - 1 candidate  → load that tier's entries, pick the entry whose
 *                         currency matches the app's default currency, use
 *                         that price as the row's `defaultPrice`.
 *        - >1 candidates → surface to the handler via the existing
 *                         multi-candidate dropdown (Hotfix 19 pattern);
 *                         the wizard's `chosenTierIdentifier` then drives
 *                         the orchestrator's resolve step.
 *   4. Pricing source `google_default` cannot resolve (no template);
 *      cross-currency rows are refused with an actionable message.
 *
 * Tier name is **not** a match key (Manager directive, 2026-06-01) —
 * matches are purely by USD-anchor price. Tier identifiers surface only
 * as human-readable labels in the multi-candidate chooser.
 *
 * Same-currency rows bypass this module entirely: existing behavior is
 * preserved bit-for-bit.
 */

import { validateDecimalForCurrency } from "../google/currency-precision";
import { decimalToMicros } from "../google/price-conversion";
import {
  findCandidateTiersForCurrencyPrice,
  lookupTemplateEntriesForIdentifier,
  type TemplateScope,
  type TierCandidate,
} from "../queries/templates";
import type { ParsedPricingEntry } from "../parsers/pricing-template-parser";

/** Anchor currency for cross-currency resolution. The Manager-uploaded
 *  bulk-import templates carry tier anchors in USD; templates store the
 *  USD entry alongside per-region equivalents. */
export const ANCHOR_CURRENCY = "USD";

/**
 * A row qualifies for cross-currency resolution when its raw decimal
 * price cannot be sent as-is in its resolved currency (precision
 * violation). The trigger is value-driven, not header-driven, so it
 * fires for both generic "Price" headers (parser-resolved to app
 * currency) and explicit "Price (VND)" headers when the value has
 * disallowed precision.
 *
 * Returns false when the value passes precision validation (same-
 * currency path, current behavior preserved).
 */
export function isCrossCurrencyRow(
  basePriceDecimal: string,
  baseCurrency: string,
): boolean {
  if (!basePriceDecimal.trim() || !baseCurrency.trim()) return false;
  return validateDecimalForCurrency(basePriceDecimal, baseCurrency) !== null;
}

/**
 * Convert the file's Price decimal to USD micros. Returns null when
 * the value itself is not a valid USD-precision decimal (e.g. more
 * than 2 fractional digits) — caller treats that as a refusal.
 */
export function fileDecimalToAnchorMicros(
  filePriceDecimal: string,
): string | null {
  try {
    return decimalToMicros(filePriceDecimal, ANCHOR_CURRENCY);
  } catch {
    return null;
  }
}

/**
 * Look up tier candidates whose USD entry matches the file's Price
 * value. Returns an empty array when no template exists or no tier
 * carries that USD price. Throws on DB error.
 *
 * Caller behavior by candidate count:
 *   0 → refuse the row (template-miss)
 *   1 → auto-resolve via {@link resolveAppCurrencyEntryForTier}
 *  >1 → surface the candidates as a chooser; handler picks one
 */
export async function findCrossCurrencyCandidates(args: {
  scope: TemplateScope;
  appId: string | null;
  filePriceDecimal: string;
}): Promise<TierCandidate[]> {
  const usdMicros = fileDecimalToAnchorMicros(args.filePriceDecimal);
  if (usdMicros === null) return [];
  return findCandidateTiersForCurrencyPrice({
    scope: args.scope,
    appId: args.appId,
    currencyCode: ANCHOR_CURRENCY,
    priceMicros: usdMicros,
  });
}

/** Pure helper: from a tier's full entry set, return the entry whose
 *  currency matches the app's default currency. Returns null when the
 *  tier has no entry for the app's currency (a partially-populated
 *  template — surfaced as a refusal to the handler). */
export function pickAppCurrencyEntry(
  entries: ReadonlyArray<ParsedPricingEntry>,
  appDefaultCurrency: string,
): ParsedPricingEntry | null {
  const normalised = appDefaultCurrency.trim().toUpperCase();
  if (!normalised) return null;
  return (
    entries.find(
      (e) => e.currency.trim().toUpperCase() === normalised,
    ) ?? null
  );
}

/** End-to-end resolution for a single chosen tier: load the tier's
 *  entries from the template, pick the app-currency entry. Returned
 *  shape covers the three possible outcomes the orchestrator must
 *  audit-log distinctly. */
export type ResolveOutcome =
  | {
      kind: "resolved";
      entry: ParsedPricingEntry;
      allEntries: ParsedPricingEntry[];
    }
  | { kind: "missing-entries" }
  | { kind: "no-app-currency-entry"; allEntries: ParsedPricingEntry[] };

export async function resolveAppCurrencyEntryForTier(args: {
  scope: TemplateScope;
  appId: string | null;
  identifier: string;
  appDefaultCurrency: string;
}): Promise<ResolveOutcome> {
  const entries = await lookupTemplateEntriesForIdentifier({
    scope: args.scope,
    appId: args.appId,
    identifier: args.identifier,
  });
  if (entries.length === 0) return { kind: "missing-entries" };
  const entry = pickAppCurrencyEntry(entries, args.appDefaultCurrency);
  if (!entry) return { kind: "no-app-currency-entry", allEntries: entries };
  return { kind: "resolved", entry, allEntries: entries };
}

/** Standard refusal-reason strings — kept here so the preview API, the
 *  orchestrator, and the wizard all surface the same wording. */
export const REFUSAL_REASONS = {
  googleDefault: (appCurrency: string, price: string) =>
    `App currency is ${appCurrency} but source is Google Default — non-integer Price "${price}" cannot be resolved without a pricing template. Select Default Template or Per-App Template, or provide whole-number ${appCurrency} prices in the file.`,
  templateMiss: (appCurrency: string, price: string) =>
    `No template tier matches USD price ${price}. App currency ${appCurrency} requires a template entry for resolution.`,
  multiMatchUnresolved: (
    appCurrency: string,
    price: string,
    candidateCount: number,
  ) =>
    `${candidateCount} template tiers share USD price ${price}; the wizard must surface a chooser. App currency ${appCurrency} resolution paused pending handler pick.`,
  missingEntries: (identifier: string) =>
    `Template tier "${identifier}" has no entries. Re-upload the pricing template or pick a different tier.`,
  noAppCurrencyEntry: (identifier: string, appCurrency: string) =>
    `Template tier "${identifier}" has no ${appCurrency} entry. Add a ${appCurrency} row to the template and re-upload.`,
} as const;
