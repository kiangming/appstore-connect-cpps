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

/** Default anchor currency for cross-currency resolution when the row's
 *  header was generic (parser source = "inferred"). Manager's templates
 *  carry USD entries alongside per-region equivalents, so USD is the
 *  established convention for the value-based fallback path. Explicit
 *  "Price (XXX)" headers override this with their declared currency. */
export const DEFAULT_ANCHOR_CURRENCY = "USD";

/** Backward-compat alias — kept so existing tests / external callers
 *  that imported `ANCHOR_CURRENCY` don't break. New code should reference
 *  `DEFAULT_ANCHOR_CURRENCY` to make the fallback nature explicit. */
export const ANCHOR_CURRENCY = DEFAULT_ANCHOR_CURRENCY;

/**
 * Cycle 43 header-first trigger. Returns the trigger classification +
 * the anchor currency to use for template lookup, or null when the row
 * is same-currency and the existing flow handles it bit-for-bit.
 *
 * Resolution order (Manager directive 2026-06-01):
 *   1. EXPLICIT header "Price (XXX)" (parser source = "explicit"):
 *        - XXX ≠ app currency → cross-currency, anchor = XXX (the
 *          declared currency, NOT hardcoded USD).
 *        - XXX == app currency → same-currency (null).
 *   2. INFERRED header "Price"/"Default Price"/"Base Price" (parser
 *      source = "inferred"):
 *        - Raw value violates app-currency precision → cross-currency,
 *          anchor = USD (Manager-template convention).
 *        - Raw value passes precision → same-currency (null).
 *
 * appDefaultCurrency null/empty → returns null (caller can't resolve
 * without knowing app currency; same-currency path lets the existing
 * orchestrator code handle the row, where validation already exists).
 */
export type CrossCurrencyTrigger =
  | { kind: "explicit_header"; anchorCurrency: string }
  | { kind: "value_based"; anchorCurrency: string };

export function detectCrossCurrencyTrigger(args: {
  basePriceDecimal: string;
  baseCurrency: string;
  priceHeaderSource: "explicit" | "inferred";
  appDefaultCurrency: string | null;
}): CrossCurrencyTrigger | null {
  if (!args.basePriceDecimal.trim() || !args.baseCurrency.trim()) return null;
  const appCur = (args.appDefaultCurrency ?? "").trim().toUpperCase();
  const rowCur = args.baseCurrency.trim().toUpperCase();
  if (!appCur) return null;

  if (args.priceHeaderSource === "explicit") {
    // Header-first: parser declared an explicit currency. Compare to
    // the app's default currency; the declared XXX is the anchor.
    if (rowCur === appCur) return null;
    return { kind: "explicit_header", anchorCurrency: rowCur };
  }

  // Inferred header: fall back to the value-based detection from the
  // initial Cycle 43 ship. The anchor is USD by convention (Manager's
  // templates index Tier 1..N by USD anchor).
  const violates =
    validateDecimalForCurrency(args.basePriceDecimal, args.baseCurrency) !==
    null;
  if (!violates) return null;
  return { kind: "value_based", anchorCurrency: DEFAULT_ANCHOR_CURRENCY };
}

/**
 * Legacy value-based predicate. Pre-Cycle-43 cross-currency.ts used this
 * standalone; the new `detectCrossCurrencyTrigger` subsumes its role for
 * the orchestrator. Kept exported for any caller still depending on it.
 *
 * @deprecated Use {@link detectCrossCurrencyTrigger} which honours the
 * header-first directive (explicit "Price (XXX)" beats value-based).
 */
export function isCrossCurrencyRow(
  basePriceDecimal: string,
  baseCurrency: string,
): boolean {
  if (!basePriceDecimal.trim() || !baseCurrency.trim()) return false;
  return validateDecimalForCurrency(basePriceDecimal, baseCurrency) !== null;
}

/**
 * Convert the file's Price decimal to anchor-currency micros. Returns
 * null when the value is not a valid decimal for the anchor's precision
 * (e.g. "4.999" against USD which only allows 2 decimals) — caller
 * treats that as a refusal.
 *
 * Anchor currency defaults to USD for back-compat with the initial
 * Cycle 43 ship; the orchestrator passes the trigger's
 * `anchorCurrency` (XXX for explicit headers, USD for inferred).
 */
export function fileDecimalToAnchorMicros(
  filePriceDecimal: string,
  anchorCurrency: string = DEFAULT_ANCHOR_CURRENCY,
): string | null {
  try {
    return decimalToMicros(filePriceDecimal, anchorCurrency);
  } catch {
    return null;
  }
}

/**
 * Look up tier candidates whose anchor-currency entry matches the
 * file's Price value. Returns an empty array when no template exists
 * or no tier carries that (anchorCurrency, anchorMicros) pair. Throws
 * on DB error.
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
  /** Anchor currency for template lookup. Defaults to USD (Manager-
   *  template convention) when omitted, matching the pre-Cycle-43
   *  inferred-header behavior. Explicit "Price (XXX)" headers pass
   *  XXX here. */
  anchorCurrency?: string;
}): Promise<TierCandidate[]> {
  const anchor = (args.anchorCurrency ?? DEFAULT_ANCHOR_CURRENCY)
    .trim()
    .toUpperCase();
  const anchorMicros = fileDecimalToAnchorMicros(args.filePriceDecimal, anchor);
  if (anchorMicros === null) return [];
  return findCandidateTiersForCurrencyPrice({
    scope: args.scope,
    appId: args.appId,
    currencyCode: anchor,
    priceMicros: anchorMicros,
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
  googleDefault: (appCurrency: string, price: string, anchorCurrency?: string) =>
    `App currency is ${appCurrency} but source is Google Default — Price "${price}"${
      anchorCurrency && anchorCurrency !== appCurrency
        ? ` (${anchorCurrency} anchor)`
        : ""
    } cannot be resolved without a pricing template. Select Default Template or Per-App Template, or provide ${appCurrency} prices in the file.`,
  templateMiss: (appCurrency: string, price: string, anchorCurrency?: string) =>
    `No template tier matches ${anchorCurrency ?? DEFAULT_ANCHOR_CURRENCY} price ${price}. App currency ${appCurrency} requires a template entry for resolution.`,
  multiMatchUnresolved: (
    appCurrency: string,
    price: string,
    candidateCount: number,
    anchorCurrency?: string,
  ) =>
    `${candidateCount} template tiers share ${anchorCurrency ?? DEFAULT_ANCHOR_CURRENCY} price ${price}; the wizard must surface a chooser. App currency ${appCurrency} resolution paused pending handler pick.`,
  missingEntries: (identifier: string) =>
    `Template tier "${identifier}" has no entries. Re-upload the pricing template or pick a different tier.`,
  noAppCurrencyEntry: (identifier: string, appCurrency: string) =>
    `Template tier "${identifier}" has no ${appCurrency} entry. Add a ${appCurrency} row to the template and re-upload.`,
} as const;
