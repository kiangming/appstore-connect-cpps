/**
 * Pure merge rules for per-country override rows (SC2).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A merge preserves only what the Manager did NOT change. The bug this cycle
 * fixes is the exact inverse: the Edit form preloads every cached region as an
 * "override", so a passive cache echo outranked the Manager's actual edit and
 * the write shipped the old prices back to Google unchanged.
 *
 * `dirty` (form-state.ts) is what makes the distinction possible. Everything
 * here keys off it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠ THE PRECEDENCE RULE — WHERE TWO GOOD RULES COLLIDE (Manager decision)
 *
 * Two rules are both correct on their own and disagree on exactly one cell:
 *
 *   (i)  re-seed / re-derive : a NON-DIRTY row takes the new source value.
 *   (B)  preserve-bytes      : a NON-DIRTY row is sent back byte-for-byte.
 *
 * They collide on "non-dirty row, and a re-derive was requested" — most
 * visibly on a row whose stored value the tool's own validator rejects
 * (production has exactly one: com.vng.passsdk.2508111020, TW = TWD 6.30).
 *
 * DECIDED: RE-DERIVE WINS.
 *   Changing the base price is the Manager ACTIVELY asking "recompute every
 *   country from this new base". Honouring that on every row the Manager has
 *   not personally pinned is the whole point of the feature.
 *   Preserve-bytes governs the PASSIVE case — an ordinary submit where nobody
 *   asked for a recomputation. There, an untouched row goes back exactly as
 *   Google sent it, odd decimals and all.
 *
 * So: `applyRederivedPrices` overwrites non-dirty rows (active request), while
 * a plain submit never calls it and the rows travel untouched.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠ NO VALUE FROM GOOGLE IS EVER TRANSFORMED HERE.
 * No rounding, no truncation, no re-formatting, no precision "cleanup". Rows
 * are copied or replaced wholesale — never edited in place. TWD 6.30 stays
 * "6.30" through every function in this file.
 *
 * Pure: no React, no I/O. Importable from client and server.
 */
import type { RegionOverrideRow } from "./form-state";

/** A converted/templated price for one region, as returned by
 *  `regions/catalog` or `pricing-templates/tier-entries`. */
export interface DerivedRegionPrice {
  regionCode: string;
  currency: string;
  /** Decimal string, EXACTLY as the source produced it. Never reformatted. */
  priceDecimal: string;
}

/* ── 1. Dirty marking ──────────────────────────────────────────────────── */

/**
 * Apply a Manager edit to one row and stamp it dirty.
 *
 * Only price/currency edits mark a row dirty — those are the values a
 * re-derive would otherwise overwrite. Changing which REGION a row points at
 * is a different kind of edit (it re-targets the row rather than pinning a
 * price), so it carries the dirty flag along unchanged.
 */
export function applyManagerEdit(
  rows: RegionOverrideRow[],
  index: number,
  updates: Partial<RegionOverrideRow>,
  currencyForRegion: (region: string) => string,
): RegionOverrideRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    const merged: RegionOverrideRow = { ...row, ...updates };
    if (updates.region && updates.region !== row.region) {
      merged.currency = currencyForRegion(updates.region);
    }
    const pinnedValue =
      updates.priceDecimal !== undefined || updates.currency !== undefined;
    if (pinnedValue) merged.dirty = true;
    return merged;
  });
}

/* ── 2. Re-derive (active Manager request) ─────────────────────────────── */

/**
 * Replace every NON-DIRTY row with the newly derived price, and add rows for
 * regions the form did not have yet.
 *
 * In the v3 model a base price has no field of its own — the ONLY way to
 * express "the base moved" is to write every regional config. This function
 * is that expression.
 *
 * Dirty rows are returned untouched: the Manager pinned them by hand and a
 * base-price change must not silently un-pin them (see `findReseedConflicts`
 * for how divergence is surfaced instead of resolved).
 */
export function applyRederivedPrices(
  rows: RegionOverrideRow[],
  derived: readonly DerivedRegionPrice[],
): RegionOverrideRow[] {
  const byRegion = new Map(derived.map((d) => [d.regionCode, d]));
  const out: RegionOverrideRow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    seen.add(row.region);
    const d = byRegion.get(row.region);
    if (!d || row.dirty) {
      // Dirty → Manager pinned it. No derived value → nothing to say about
      // this region; leave it exactly as it is.
      out.push(row);
      continue;
    }
    out.push({
      region: row.region,
      currency: d.currency,
      priceDecimal: d.priceDecimal,
      dirty: false,
    });
  }

  for (const d of derived) {
    if (seen.has(d.regionCode)) continue;
    out.push({
      region: d.regionCode,
      currency: d.currency,
      priceDecimal: d.priceDecimal,
      dirty: false,
    });
  }
  return out;
}

/* ── 3. Re-seed (a fresh `initial` arrives mid-edit) ───────────────────── */

export interface ReseedConflict {
  region: string;
  /** What the Manager typed and still has on screen. */
  mine: { currency: string; priceDecimal: string };
  /** What the server now says, which differs from what it said before. */
  theirs: { currency: string; priceDecimal: string };
}

export interface ReseedResult {
  rows: RegionOverrideRow[];
  conflicts: ReseedConflict[];
}

/**
 * Reconcile live form rows against a newly-delivered server snapshot.
 *
 * WHY THIS EXISTS: `initial` is a live prop but the form seeds its state from
 * it exactly once, and the page renders <IapForm> with no key. A
 * `router.refresh()` — which "Sync from Google" performs deliberately
 * (UnifiedPricingTable.tsx:129-131, whose comment states this exact intent) —
 * hands a NEW `initial` to a SURVIVING component instance. The diff then
 * compares fresh server truth (before) against stale client state (after),
 * inverted, so the review modal proposes writing the PRE-sync prices back
 * over Google's current ones. Confirming it would revert real prices.
 *
 * Semantics (i), as decided:
 *   - non-dirty row → re-seed from the new snapshot (it was only an echo)
 *   - dirty row     → KEEP the Manager's value
 *   - dirty row whose server value ALSO moved → keep the Manager's value AND
 *     report a conflict. Never silently pick a side; the Manager decides.
 *
 * Rows absent from the new snapshot are dropped unless dirty — the region no
 * longer exists server-side, but an unsaved Manager edit is never discarded.
 */
export function reseedOverrides(args: {
  /** Current on-screen rows, carrying dirty flags. */
  current: readonly RegionOverrideRow[];
  /** The snapshot the form was last seeded from. */
  serverBefore: readonly RegionOverrideRow[];
  /** The snapshot that just arrived. */
  serverAfter: readonly RegionOverrideRow[];
}): ReseedResult {
  const { current, serverBefore, serverAfter } = args;
  const beforeByRegion = new Map(serverBefore.map((r) => [r.region, r]));
  const afterByRegion = new Map(serverAfter.map((r) => [r.region, r]));

  const rows: RegionOverrideRow[] = [];
  const conflicts: ReseedConflict[] = [];
  const handled = new Set<string>();

  for (const row of current) {
    handled.add(row.region);
    const after = afterByRegion.get(row.region);

    if (!row.dirty) {
      // Passive echo — adopt the new truth verbatim, or drop the row if the
      // region is gone server-side.
      if (after) {
        rows.push({
          region: after.region,
          currency: after.currency,
          priceDecimal: after.priceDecimal,
          dirty: false,
        });
      }
      continue;
    }

    // Dirty: the Manager's value always survives.
    rows.push(row);

    const before = beforeByRegion.get(row.region);
    const serverMoved =
      after !== undefined &&
      before !== undefined &&
      (after.priceDecimal !== before.priceDecimal ||
        after.currency !== before.currency);
    if (serverMoved && after) {
      conflicts.push({
        region: row.region,
        mine: { currency: row.currency, priceDecimal: row.priceDecimal },
        theirs: { currency: after.currency, priceDecimal: after.priceDecimal },
      });
    }
  }

  // Regions the new snapshot introduced.
  for (const after of serverAfter) {
    if (handled.has(after.region)) continue;
    rows.push({
      region: after.region,
      currency: after.currency,
      priceDecimal: after.priceDecimal,
      dirty: false,
    });
  }

  return { rows, conflicts };
}

/* ── 4. Dirty-scoped validation (option B) ─────────────────────────────── */

export interface OverrideValidation {
  /** Keyed by row index. These BLOCK submit — the Manager typed them. */
  blocking: Record<number, string>;
  /** Keyed by row index. These only WARN — nobody touched them, and the value
   *  came from Google. Blocking on them strands the item entirely. */
  warnings: Record<number, string>;
}

/**
 * Split per-row validation errors by who authored the value.
 *
 * Before SC2, any invalid row blocked the whole submit. Production has an item
 * whose Google-supplied TW price (TWD 6.30) the tool's own currency table
 * rejects — so that item could not be edited AT ALL, including its title,
 * because of a row the Manager never touched and Google itself authored.
 *
 * A value the Manager typed must be blocked: they can fix it.
 * A value Google authored must only warn: blocking it fixes nothing and costs
 * everything, and "correcting" it would violate the no-transformation rule.
 */
export function partitionOverrideValidation(
  rows: readonly RegionOverrideRow[],
  validate: (priceDecimal: string, currency: string) => string | null,
): OverrideValidation {
  const blocking: Record<number, string> = {};
  const warnings: Record<number, string> = {};
  rows.forEach((row, i) => {
    if (!row.priceDecimal.trim()) return;
    const err = validate(row.priceDecimal, row.currency);
    if (!err) return;
    if (row.dirty) blocking[i] = err;
    else warnings[i] = err;
  });
  return { blocking, warnings };
}
