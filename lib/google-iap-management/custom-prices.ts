/**
 * Row model for the Bulk Import per-item custom-prices dialog.
 *
 * Pure + deterministic — no I/O — sibling to `unified-pricing.ts` and held
 * to the same discipline: the merge of (Google's country catalog × the
 * row's template baseline × the Manager's typed overrides) is computed and
 * tested independently of React.
 *
 * REUSES `statedPriceError` (orchestration/file-price.ts) — no second rule
 * set, no copy: the same rules as a price in the import file and the item
 * form (precision per currency, "26.000" in a currency without decimals
 * refused as a possible thousands separator, no 0 — Manager 2026-10-19).
 * The dialog calls `validateCustomPrices` to gate Save; the orchestrator's
 * custom pre-pass re-runs `statedPriceOf` server-side because client state
 * is untrusted. (Template prices are NOT validated at upload — a stored
 * tier entry is checked at push by `storedRegionPriceOf`.)
 *
 * CURRENCY IS DERIVED, NEVER TYPED (design §1.5, code-backed by
 * UnifiedPricingTable.tsx:367-369 where it renders as a chip). Derivation
 * order, implemented in `buildCustomPriceRows`:
 *   1. the row's template entry for that country — authoritative, it is
 *      what the push would actually send;
 *   2. else Google's own catalog (`convertRegionPrices` via the
 *      regions/catalog route), which is the canonical country→currency map;
 *   3. never `getAllRegions()` alone — ~250 ISO codes with no currency,
 *      including markets Google does not sell in.
 */
import { statedPriceError } from "./orchestration/file-price";
import { regionNameFromCode } from "./region-name";

/** One country as offered by Google's catalog. `currency` is Google's
 *  fixed billing currency for that country. */
export interface CatalogCountry {
  regionCode: string;
  currency: string;
  /** Google's conversion of the caller-supplied base price for this
   *  country, when the catalog route was asked for one. Used as the
   *  reference column under Google Conversion, where no template exists.
   *  Absent when the route ran its nominal probe — those amounts are
   *  meaningless and must never be shown as prices. */
  convertedDecimal?: string;
}

/** A template tier's entry for one country (from pricing_template_entries
 *  via lookupTemplateEntriesForIdentifier). */
export interface TemplateEntry {
  regionCode: string;
  currency: string;
  priceDecimal: string;
}

/** A Manager-typed override for one country. */
export interface CustomEntry {
  region: string;
  currency: string;
  priceDecimal: string;
}

export type CustomPriceState =
  /** Value equals the template baseline — not customised. */
  | "template"
  /** Manager typed a value that differs from the baseline (or there is no
   *  baseline and they typed one). */
  | "custom"
  /** No value on either side — Google's conversion fills this country at
   *  push time (bulk-import.ts:839-846). Surfaced explicitly so the
   *  bootstrap is visible rather than implicit. */
  | "inherit";

export interface CustomPriceRow {
  regionCode: string;
  countryName: string;
  /** Derived — display only. */
  currency: string;
  /** The template's price for this country, or null when the template
   *  doesn't cover it / there is no template baseline at all. */
  templateDecimal: string | null;
  /** What the Manager has typed, or null when untouched/cleared. */
  customDecimal: string | null;
  state: CustomPriceState;
}

export interface BuildCustomPriceRowsArgs {
  /** Google's supported countries + their billing currency. */
  countries: ReadonlyArray<CatalogCountry>;
  /** The row's template tier entries. Empty for a row with no tier match —
   *  a legitimate state, rendered as "no baseline". */
  templateEntries: ReadonlyArray<TemplateEntry>;
  /** Already-saved custom entries (re-opening the dialog). */
  custom: ReadonlyArray<CustomEntry>;
}

function norm(code: string): string {
  return code.trim().toUpperCase();
}

/** Trailing-zero-insensitive equality so "1.990" counts as unchanged
 *  against a template "1.99" — otherwise the Δ column and the changed
 *  counter would both lie about a value the Manager never edited. */
function sameAmount(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const clean = (v: string) => {
    const t = v.trim();
    if (!t.includes(".")) return t;
    return t.replace(/0+$/, "").replace(/\.$/, "");
  };
  return clean(a) === clean(b);
}

/**
 * Merge catalog × template × custom into the dialog's row set.
 *
 * The row set is the UNION of Google's catalog and the template's
 * countries: a template may cover a country Google's current catalog
 * omits (or vice versa), and dropping either side would silently hide a
 * price the push would still send.
 */
export function buildCustomPriceRows(
  args: BuildCustomPriceRowsArgs,
): CustomPriceRow[] {
  const { countries, templateEntries, custom } = args;

  const templateByRegion = new Map<string, TemplateEntry>();
  for (const e of templateEntries) {
    const r = norm(e.regionCode);
    if (!templateByRegion.has(r)) templateByRegion.set(r, e);
  }
  const customByRegion = new Map<string, CustomEntry>();
  for (const c of custom) {
    const r = norm(c.region);
    if (!customByRegion.has(r)) customByRegion.set(r, c);
  }

  const regions: string[] = [];
  const seen = new Set<string>();
  for (const c of countries) {
    const r = norm(c.regionCode);
    if (r && !seen.has(r)) {
      seen.add(r);
      regions.push(r);
    }
  }
  // Template-only (and custom-only) countries still belong in the list.
  for (const r of [...templateByRegion.keys(), ...customByRegion.keys()]) {
    if (!seen.has(r)) {
      seen.add(r);
      regions.push(r);
    }
  }

  const currencyByRegion = new Map<string, string>();
  for (const c of countries) currencyByRegion.set(norm(c.regionCode), c.currency);

  const rows: CustomPriceRow[] = regions.map((regionCode) => {
    const tpl = templateByRegion.get(regionCode) ?? null;
    const cus = customByRegion.get(regionCode) ?? null;
    // Derivation order: template entry wins (it is what a non-custom push
    // would send), then Google's catalog. A custom entry's own currency is
    // NOT trusted as a source — currency isn't user-editable, so a
    // divergent one would mean stale saved state, and the authoritative
    // sources must win.
    const currency =
      tpl?.currency ?? currencyByRegion.get(regionCode) ?? cus?.currency ?? "";
    const templateDecimal = tpl?.priceDecimal?.trim() ? tpl.priceDecimal.trim() : null;
    const customRaw = cus?.priceDecimal?.trim() ? cus.priceDecimal.trim() : null;

    let state: CustomPriceState;
    if (customRaw === null) {
      state = templateDecimal === null ? "inherit" : "template";
    } else if (sameAmount(customRaw, templateDecimal)) {
      state = "template";
    } else {
      state = "custom";
    }

    return {
      regionCode,
      countryName: regionNameFromCode(regionCode),
      currency,
      templateDecimal,
      customDecimal: customRaw,
      state,
    };
  });

  rows.sort((a, b) => a.countryName.localeCompare(b.countryName));
  return rows;
}

export interface CustomPriceError {
  regionCode: string;
  error: string;
}

/**
 * Validate every typed price against ITS OWN country's currency.
 *
 * Delegates to `statedPriceError` (file-price.ts) — the exact function the
 * item form calls (IapForm.tsx validateDecimal) and the rules the server
 * re-runs. Rows the Manager hasn't typed into are not errors: a blank price
 * means "let Google convert this country", which is a valid choice.
 *
 * Scope note (design §1.4, R4): this checks the PRICE RULES only. There
 * is no per-country minimum/maximum table anywhere in the tool
 * (currency-precision.ts:16-18 states so) — Google enforces floors
 * server-side at push. `flagSuspiciousDrops` below is the cheap heuristic
 * that catches the common floor violation before it gets there.
 */
export function validateCustomPrices(
  rows: ReadonlyArray<CustomPriceRow>,
): CustomPriceError[] {
  const errors: CustomPriceError[] = [];
  for (const r of rows) {
    if (r.customDecimal === null) continue;
    if (!r.currency) {
      errors.push({
        regionCode: r.regionCode,
        error: `No billing currency known for ${r.countryName} (${r.regionCode}) — remove this price or refresh the country list.`,
      });
      continue;
    }
    const err = statedPriceError(r.customDecimal, r.currency);
    if (err) errors.push({ regionCode: r.regionCode, error: err });
  }
  return errors;
}

/** Count of countries whose price differs from the template baseline. */
export function diffFromTemplate(rows: ReadonlyArray<CustomPriceRow>): number {
  return rows.filter((r) => r.state === "custom").length;
}

export interface CustomPriceSummary {
  total: number;
  /** state === "custom" */
  customised: number;
  /** state === "template" */
  atTemplate: number;
  /** state === "inherit" — Google's conversion fills these at push. */
  blank: number;
}

export function summarizeCustomPrices(
  rows: ReadonlyArray<CustomPriceRow>,
): CustomPriceSummary {
  let customised = 0;
  let atTemplate = 0;
  let blank = 0;
  for (const r of rows) {
    if (r.state === "custom") customised += 1;
    else if (r.state === "template") atTemplate += 1;
    else blank += 1;
  }
  return { total: rows.length, customised, atTemplate, blank };
}

/* H4.2 (Manager Q6, 2026-10-17): the Save gate that demanded a custom price
 * in the APP's currency (findAppCurrencyEntry / customAppCurrencyGate) is
 * gone — defaultPrice and the conversion base are always the file's price,
 * so no currency is special. Removed together with the orchestrator's twin
 * refusal (custom_no_app_currency_entry). */

export interface SuspiciousDrop {
  regionCode: string;
  /** Percent below the template baseline, rounded. */
  percentBelow: number;
  message: string;
}

/**
 * Non-blocking heuristic for the missing-floor-table problem (R4).
 *
 * There is no per-country min/max data in the tool, and Google returns NO
 * structured per-row errors on batchUpdate (bulk-import.ts:33-35) — so a
 * single below-floor price fails the whole batch with an opaque message.
 * We can't validate floors, but a price dramatically below the template
 * baseline is the shape most floor violations take (a mistyped decimal,
 * a pasted wrong column). Warn, never block: an aggressive regional
 * discount is legitimate.
 */
export function flagSuspiciousDrops(
  rows: ReadonlyArray<CustomPriceRow>,
  thresholdPercent = 90,
): SuspiciousDrop[] {
  const out: SuspiciousDrop[] = [];
  for (const r of rows) {
    if (r.state !== "custom" || r.customDecimal === null || r.templateDecimal === null) {
      continue;
    }
    const custom = Number(r.customDecimal);
    const template = Number(r.templateDecimal);
    if (!Number.isFinite(custom) || !Number.isFinite(template) || template <= 0) {
      continue;
    }
    if (custom >= template) continue;
    const percentBelow = Math.round(((template - custom) / template) * 100);
    if (percentBelow < thresholdPercent) continue;
    out.push({
      regionCode: r.regionCode,
      percentBelow,
      message: `${percentBelow}% below the template price — Google may reject this as below the country minimum.`,
    });
  }
  return out;
}

/** Dialog rows → the wire shape the execute payload carries. Blank
 *  countries are OMITTED: they are the "let Google convert" choice, and
 *  sending an empty priceDecimal would be an invalid price rather than an
 *  absent one. */
export function toCustomEntries(
  rows: ReadonlyArray<CustomPriceRow>,
): CustomEntry[] {
  return rows
    .filter((r) => r.customDecimal !== null)
    .map((r) => ({
      region: r.regionCode,
      currency: r.currency,
      priceDecimal: r.customDecimal as string,
    }));
}
