/**
 * The one territory search predicate.
 *
 * WHY THIS MODULE EXISTS (P1 — twin path)
 * Two dialogs now search over a ~175-territory list: Custom Prices and the
 * availability territory picker. They sit ADJACENT on the Edit form, so a
 * second hand-rolled "does this row match the box" is the twin-path shape
 * that has bitten this module repeatedly. One predicate, two callers.
 *
 * Field-shaped rather than row-shaped on purpose: `matchesBaselineQuery`
 * used to be typed to `BaselineRow` (price-shaped), which is exactly what
 * made it unreusable. The predicate cares about three strings; the row
 * types stay behind with their owners.
 *
 * ⚠ NEVER TRANSFORM VALUES RECEIVED FROM APPLE. Lower-casing happens on a
 * throwaway copy for comparison only. Nothing here rewrites, trims or
 * re-encodes an id that will be sent back to Apple.
 */

/** The three strings a territory can be found by. */
export interface TerritoryQueryFields {
  /** Display name, e.g. "United States". */
  readonly name: string;
  /** Apple/ISO alpha-3 id, verbatim, e.g. "USA". */
  readonly code: string;
  /** Currency code where the surface has one; availability has none. */
  readonly currency?: string | null;
}

/**
 * Case-insensitive substring match across name, alpha-3 code and currency.
 *
 * An empty or whitespace-only query matches everything — the filter is
 * absent, not unsatisfiable.
 */
export function matchesTerritoryQuery(
  fields: TerritoryQueryFields,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    fields.name.toLowerCase().includes(q) ||
    fields.code.toLowerCase().includes(q) ||
    (fields.currency ?? "").toLowerCase().includes(q)
  );
}
