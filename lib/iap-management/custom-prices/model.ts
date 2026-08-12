/**
 * Per-territory Custom Prices — the PURE model.
 *
 * Design: docs/iap-management/design-apple-custom-territory-prices.md §A.1, §C, §D.
 *
 * ⚠ THIS FILE MUST STAY IMPORTABLE FROM A CLIENT COMPONENT. It has no DB, no
 * `fs`, no `iapDb`, no Apple client — deliberately, because the staleness rule
 * has to be ONE function used by both sides:
 *
 *   client — disables Create/Update on Apple while a custom set is stale
 *   server — recomputes and returns 422 before any Apple call
 *
 * A client-only block is bypassable from a stale tab; a server-only block is a
 * dead end with no way forward from the UI. Two implementations of "is this
 * stale" would drift, and the drift would be invisible until a wrong price
 * reached a live store. `custom-prices/purity.test.ts` fails if a server-only
 * import ever lands here.
 *
 * ── The two-meanings-of-empty hazard, designed out rather than documented ──
 *
 * The Google custom-prices cycle produced three separate dead-affordance bugs
 * from ONE root cause: empty/absent carrying two meanings — "not set yet" vs
 * "deliberately cleared → inherit". Apple has the identical hazard. Two
 * structural choices remove it instead of warning about it:
 *
 *   1. A territory is a KEY IN A MAP or it is ABSENT. There is no
 *      `customer_price: null`, no `""`, no sentinel. `clearCustomPrice`
 *      DELETES the key. `CustomPriceEntry.customer_price` is `number`, not
 *      `number | null`, so "cleared" is unrepresentable as a value.
 *   2. Whether the caller is SAYING ANYTHING AT ALL is a separate axis from
 *      what it says: `CustomPricePersistIntent` is a discriminated union, so
 *      "the payload omitted the field" (`untouched`) cannot collapse into "the
 *      Manager cleared every custom" (`replace` with zero entries). Both are
 *      legitimate and they mean opposite things at the DB.
 *
 * Presentation state (a half-finished dialog edit) lives in the dialog's own
 * draft map in SC2 and is never the same object as the persisted set.
 */
import type { PricingSourceKind } from "@/lib/iap-management/validation";

/**
 * One territory's custom price.
 *
 * Isomorphic to `FlatTemplateEntry` minus `tier_id` + `proceeds`, so the
 * orchestrator's resolution loop is the same code shape for a custom and a
 * template entry (design §G.1).
 *
 * ⚠ There is no `price_point_id` field and there must never be one. Apple's
 * price-point id is per-IAP and cannot exist before the IAP does (gate G2);
 * ids are resolved server-side at submit from `customer_price`, exactly as
 * template entries are. `no-price-point-id.test.ts` pins this.
 */
export interface CustomPriceEntry {
  /** Apple ISO 3166-1 alpha-3, e.g. "VNM", "JPN". */
  territory_code: string;
  /** Picked from Apple's own per-territory list; never free-typed. */
  customer_price: number;
  /** DISPLAY METADATA ONLY — never a join key. A territory's currency can
   *  change (Bulgaria BGN→EUR, Jan 2026); matching is on customer_price alone. */
  currency_code: string;
}

/**
 * The G6 baseline fingerprint: everything whose change moves the price a
 * territory would get if it had no custom.
 *
 * `pricing_source` is in here even though it does NOT move the base price on
 * the single-IAP forms (both routes resolve the base via `getTierUsdPrice`,
 * which reads the legacy USA/USD cache regardless of source) — because it does
 * decide WHICH TEMPLATE's per-territory overrides apply, which is precisely
 * what a custom is layered on top of.
 */
export interface CustomPriceBaseline {
  tier_id: string;
  pricing_source: PricingSourceKind;
  base_territory: string;
}

/** Base territory is a constant today — see the migration's note on why it is
 *  still a fingerprint member. */
export const DEFAULT_BASE_TERRITORY = "USA";

/** The persisted set, keyed by territory. Key present = has a custom. */
export type CustomPriceSet = ReadonlyMap<string, CustomPriceEntry>;

export const EMPTY_CUSTOM_PRICE_SET: CustomPriceSet = new Map();

/**
 * Whether a payload is saying anything about custom prices at all.
 *
 * `untouched` — the field was absent. Leave the stored set alone.
 * `replace`   — the field was present. Store exactly these entries; an empty
 *               array is an explicit "clear them all", not a no-op.
 *
 * This union exists so the two can never be conflated by a `?? []` or a zod
 * `.default([])`, either of which turns "a layer forgot to thread the field"
 * into "the Manager's custom prices silently vanished on Save Draft".
 */
export type CustomPricePersistIntent =
  | { kind: "untouched" }
  | { kind: "replace"; entries: readonly CustomPriceEntry[] };

/**
 * Classify a payload field into an intent. `undefined` / `null` mean the field
 * was not sent; an array — including `[]` — means it was.
 */
export function persistIntentFrom(
  field: readonly CustomPriceEntry[] | null | undefined,
): CustomPricePersistIntent {
  if (field === undefined || field === null) return { kind: "untouched" };
  return { kind: "replace", entries: normalizeEntries(field) };
}

// ─── Entry / set transformations (all pure, all non-mutating) ────────────────

/** Uppercase + trim a territory code so "vnm" and "VNM " are one key. */
export function normalizeTerritoryCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A structurally usable entry: real territory code, finite non-negative
 *  price, non-empty currency. Rejects the shapes the DB would refuse anyway,
 *  early enough to give the caller a useful error. */
export function isValidCustomPriceEntry(entry: CustomPriceEntry): boolean {
  return (
    typeof entry.territory_code === "string" &&
    normalizeTerritoryCode(entry.territory_code).length > 0 &&
    typeof entry.customer_price === "number" &&
    Number.isFinite(entry.customer_price) &&
    entry.customer_price >= 0 &&
    typeof entry.currency_code === "string" &&
    entry.currency_code.trim().length > 0
  );
}

/**
 * Normalize a list into canonical storage order: territory codes uppercased,
 * invalid entries dropped, duplicates collapsed LAST-WINS, sorted by
 * territory.
 *
 * Last-wins deduping is not the real defence — `PRIMARY KEY (iap_id,
 * territory_code)` is (gate G1). This keeps a caller from sending a payload the
 * DB would reject mid-batch, and makes the sorted output byte-comparable in
 * tests.
 */
export function normalizeEntries(
  entries: readonly CustomPriceEntry[],
): CustomPriceEntry[] {
  const byTerritory = new Map<string, CustomPriceEntry>();
  for (const entry of entries) {
    if (!isValidCustomPriceEntry(entry)) continue;
    const territory_code = normalizeTerritoryCode(entry.territory_code);
    byTerritory.set(territory_code, {
      territory_code,
      customer_price: entry.customer_price,
      currency_code: entry.currency_code.trim().toUpperCase(),
    });
  }
  return [...byTerritory.values()].sort((a, b) =>
    a.territory_code.localeCompare(b.territory_code),
  );
}

export function toCustomPriceSet(
  entries: readonly CustomPriceEntry[],
): CustomPriceSet {
  return new Map(normalizeEntries(entries).map((e) => [e.territory_code, e]));
}

/** Canonical (sorted) list form. Round-trips with `toCustomPriceSet`. */
export function toCustomPriceEntries(set: CustomPriceSet): CustomPriceEntry[] {
  return normalizeEntries([...set.values()]);
}

/** Add or overwrite one territory's custom. Returns a new set. */
export function setCustomPrice(
  set: CustomPriceSet,
  entry: CustomPriceEntry,
): CustomPriceSet {
  if (!isValidCustomPriceEntry(entry)) return set;
  const next = new Map(set);
  const territory_code = normalizeTerritoryCode(entry.territory_code);
  next.set(territory_code, {
    territory_code,
    customer_price: entry.customer_price,
    currency_code: entry.currency_code.trim().toUpperCase(),
  });
  return next;
}

/**
 * Revert ONE territory. **Deletes the key** — it does not write null, 0, or "".
 * That is the whole dead-affordance fix: after this call the territory is
 * indistinguishable from one that never had a custom, which is exactly what
 * "revert to template/auto" means.
 */
export function clearCustomPrice(
  set: CustomPriceSet,
  territoryCode: string,
): CustomPriceSet {
  const next = new Map(set);
  next.delete(normalizeTerritoryCode(territoryCode));
  return next;
}

/** Revert ALL territories. The Manager must always be able to exit the custom
 *  state (design §C) — this is that exit, and it is a plain empty set. */
export function clearAllCustomPrices(): CustomPriceSet {
  return new Map();
}

export function customPriceCount(set: CustomPriceSet): number {
  return set.size;
}

export function hasCustomPrice(set: CustomPriceSet, territoryCode: string): boolean {
  return set.has(normalizeTerritoryCode(territoryCode));
}

// ─── The stale fingerprint — ONE function, both sides ────────────────────────

/**
 * Compute the current baseline fingerprint from whatever the form holds.
 *
 * Returns `null` when `tier_id` is absent: a custom overrides a base price, so
 * with no base there is nothing to be measured against (rule CP-3 — the dialog
 * refuses to open without a tier, because the server would otherwise drop the
 * whole set silently via `skipped-no-tier`).
 */
export function fingerprintOf(input: {
  tier_id: string | null | undefined;
  pricing_source?: PricingSourceKind | null;
  base_territory?: string | null;
}): CustomPriceBaseline | null {
  if (!input.tier_id) return null;
  return {
    tier_id: input.tier_id,
    pricing_source: input.pricing_source ?? "APPLE",
    base_territory: input.base_territory ?? DEFAULT_BASE_TERRITORY,
  };
}

/**
 * ⚠ THE staleness rule. Imported by the client (to disable submit) and by the
 * server (to 422 before any Apple call). One function, so the two cannot drift.
 *
 * A COMPARISON, never a stored boolean. Consequence, and the reason the design
 * insists on it: changing the base and changing it BACK clears staleness with
 * no user action and nothing to acknowledge. A one-way `reviewed` flag would
 * force the Manager to dismiss a no-op, and worse, would let a LATER baseline
 * change go unnoticed.
 *
 * Cases:
 *   stored === null            → nothing was ever baselined ⇒ not stale
 *                                (a set with no fingerprint cannot exist: the
 *                                DB coherence CHECK makes the columns
 *                                all-or-nothing, and the writer always stamps)
 *   current === null           → the tier was cleared, so the customs are
 *                                certainly not against the current base ⇒ stale
 *   field-by-field difference  → stale
 */
export function isCustomBaselineStale(
  current: CustomPriceBaseline | null,
  stored: CustomPriceBaseline | null,
): boolean {
  if (stored === null) return false;
  if (current === null) return true;
  return (
    current.tier_id !== stored.tier_id ||
    current.pricing_source !== stored.pricing_source ||
    current.base_territory !== stored.base_territory
  );
}

/**
 * The submit-blocking predicate both layers ask. Stale customs block a push to
 * Apple only when there ARE customs — a stale fingerprint with an empty set is
 * nothing to review.
 */
export function isCustomPricesSubmitBlocked(args: {
  customPriceCount: number;
  current: CustomPriceBaseline | null;
  stored: CustomPriceBaseline | null;
}): boolean {
  if (args.customPriceCount === 0) return false;
  return isCustomBaselineStale(args.current, args.stored);
}

/**
 * Which persistence operation a save actually is.
 *
 * SC1 deliberately gave the feature three audit action types, and they only
 * carry their meaning if the writer picks the right one. This keeps that choice
 * pure and testable instead of inlining it in a route handler:
 *
 *   "clear"    — the incoming set is empty. Destructive; audited with the
 *                removed values, which is the only recovery path.
 *   "rebaseline" — the prices are byte-identical to what is stored and only the
 *                fingerprint moved. That is "Keep them (reviewed)": it changes
 *                what will ship while changing nothing visible, so it must not
 *                be logged as an ordinary save.
 *   "replace"  — anything else.
 */
export type CustomPriceWriteKind = "clear" | "rebaseline" | "replace";

export function decideCustomPriceWrite(args: {
  storedEntries: readonly CustomPriceEntry[];
  storedBaseline: CustomPriceBaseline | null;
  incomingEntries: readonly CustomPriceEntry[];
  incomingBaseline: CustomPriceBaseline | null;
}): CustomPriceWriteKind {
  const incoming = normalizeEntries(args.incomingEntries);
  if (incoming.length === 0) return "clear";

  const stored = normalizeEntries(args.storedEntries);
  const sameEntries =
    stored.length === incoming.length &&
    stored.every((s, i) => {
      const n = incoming[i];
      return (
        s.territory_code === n.territory_code &&
        s.customer_price === n.customer_price &&
        s.currency_code === n.currency_code
      );
    });
  if (!sameEntries) return "replace";

  const baselineMoved = isCustomBaselineStale(
    args.incomingBaseline,
    args.storedBaseline,
  );
  return baselineMoved ? "rebaseline" : "replace";
}

/** Human-readable difference, for the banner copy and the 422 body. Empty when
 *  not stale. Kept here so client and server word it identically. */
export function describeBaselineDrift(
  current: CustomPriceBaseline | null,
  stored: CustomPriceBaseline | null,
): string[] {
  if (!isCustomBaselineStale(current, stored) || stored === null) return [];
  if (current === null) {
    return [`price tier cleared (was ${stored.tier_id})`];
  }
  const out: string[] = [];
  if (current.tier_id !== stored.tier_id) {
    out.push(`price tier ${stored.tier_id} → ${current.tier_id}`);
  }
  if (current.pricing_source !== stored.pricing_source) {
    out.push(`pricing source ${stored.pricing_source} → ${current.pricing_source}`);
  }
  if (current.base_territory !== stored.base_territory) {
    out.push(`base territory ${stored.base_territory} → ${current.base_territory}`);
  }
  return out;
}
