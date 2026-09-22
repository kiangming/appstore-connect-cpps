/**
 * [TIER-TIEBREAK-priority] — the ONE place that ranks Apple tier ids, and the
 * one place that says which tiers a USD price matches.
 *
 * ⚠ THIS MODULE IS A JOIN, NOT AN INVENTION. Every rule here already existed
 * in this repo before the arc; none of it is new policy:
 *
 *   • the ranking below is `sortTierId`, lifted verbatim from
 *     `queries/price-tiers.ts` and `queries/templates.ts` — which held TWO
 *     byte-identical copies (md5 189add34c9624162970206b101e1c501 on both).
 *     `templates.ts`'s own comment said "once price-tiers.ts retires, can be
 *     lifted to a shared util". A third copy is what this module prevents.
 *   • `queries/template-matrix.ts:87-88` already sorted primary tiers ahead of
 *     alternates for the matrix screen.
 *
 * ⚠ WHY A SEPARATE, DB-FREE FILE. `queries/price-tiers.ts` imports `iapDb`,
 * and `BulkImportWizard.tsx` — a `"use client"` component — already imports
 * from it. That edge exists and works, but it is not one to widen: the tier
 * ranking is needed on BOTH sides of the wire (the resolver runs server-side
 * in `/execute`, the dropdown runs in the browser), so it belongs in a module
 * with no database import at all.
 */

/** Minimal shape both the resolver and the wizard's dropdown already use. */
export interface TierPriceEntry {
  tier_id: string;
  customer_price: number;
}

/**
 * Rank one tier id: `FREE` → `TIER_<n>` → `ALT_<số>` → `ALT_<chữ>` → unknown.
 *
 * ⚠ THE RANKING IS THE CONTRACT. It used to be a side effect.
 *
 * `resolveTierByUsdPrice` broke ties with `a.tier_id.localeCompare(b.tier_id)`
 * under a comment reading "Manager spec: ORDER BY tier_id ASC LIMIT 1". That
 * spec is about DETERMINISM — same input, same answer — and it delivered
 * that. What it did NOT decide is which KIND of tier should win, and the
 * answer it produced was an accident of the id naming scheme: the string
 * `"ALT_"` sorts before `"TIER_"`, so an alternate tier beat the standard
 * tier at every shared price. Measured, not assumed:
 *
 *     "ALT_5".localeCompare("TIER_5")   === -1     ⇒ ALT_5 won
 *     "TIER_2".localeCompare("TIER_10") ===  1     ⇒ TIER_10 won
 *
 * ⚠ THE ORIGINAL INTENT WAS `TIER`, AND THE OLD TEST SAYS SO IN WRITING.
 * `queries/price-tiers.test.ts` carried a case whose TITLE read "returns
 * TIER_5 for price 4.99 (tier_id ASC tie-break wins over ALT_5)" while its
 * assertion read `toBe("ALT_5")` — the author expected the standard tier,
 * found the alternate, and corrected the assertion instead of the rule. That
 * test is the paper trail of a side effect being discovered and accepted.
 *
 * ⚠ `TIER_2` BEFORE `TIER_10` IS A GUARD, NOT A FIX FOR ANYTHING LIVE.
 * Numeric-aware ordering also ends the lexicographic tie-break among standard
 * tiers. Manager's census SQL over production data (2026-09-22) found five
 * shared-price groups — $0.99, $1.99, $2.99, $3.99, $4.99 — and EVERY ONE of
 * them is TIER-vs-ALT. There is **no TIER-vs-TIER collision in the real data**,
 * so nothing is being un-broken here: this is a contract written ahead of the
 * case, and it should not be reported as a bug that was biting someone.
 */
export function compareTierId(a: string, b: string): number {
  const rank = (id: string): [number, number, string] => {
    if (id === "FREE") return [0, 0, ""];
    const tier = /^TIER_(\d+)$/.exec(id);
    if (tier) return [1, Number(tier[1]), ""];
    const alt = /^ALT_(.+)$/.exec(id);
    if (alt) {
      const n = Number(alt[1]);
      return Number.isFinite(n) ? [2, n, ""] : [3, 0, alt[1]];
    }
    return [9, 0, id];
  };
  const [aBucket, aNum, aStr] = rank(a);
  const [bBucket, bNum, bStr] = rank(b);
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (aNum !== bNum) return aNum - bNum;
  return aStr.localeCompare(bStr);
}

/**
 * Every tier whose USA/USD price equals `priceUsd`, **already ranked**.
 *
 * ⚠ ONE LIST, TWO READERS, AND THAT IS THE WHOLE POINT. The resolver takes
 * `[0]`; the wizard's `TierCell` renders the same array as `<option>`s. Before
 * this they were separate expressions — `queries/price-tiers.ts` filtered and
 * sorted, `BulkImportWizard.tsx` filtered and did NOT sort — so the dropdown's
 * first option and the value the resolver had chosen were two different
 * answers to one question, and the second one was ordered by whatever
 * Postgres happened to return (the USD lists are `.order("customer_price")`
 * only, which says nothing about ties). Reading both from here makes
 * "the default" and "the first option" the same fact by construction.
 *
 * ⚠ PRICE 0 IS `FREE`, AND THE RESOLVER'S SHORT-CIRCUIT IS NOT THIS FUNCTION.
 * The IAP.h2 lock says price 0 resolves to `"FREE"` *whether or not the cache
 * holds that row*, so `resolveTierByUsdPrice` answers before calling here.
 * This function reports what the LIST contains, which is what a dropdown must
 * render — an empty result for a list with no FREE row is correct here and
 * would be wrong there.
 */
export function candidateTiersForPrice<T extends TierPriceEntry>(
  priceUsd: number,
  tiers: readonly T[],
): T[] {
  const matches =
    priceUsd === 0
      ? tiers.filter((t) => t.tier_id === "FREE")
      : tiers.filter((t) => t.customer_price === priceUsd);
  return [...matches].sort((a, b) => compareTierId(a.tier_id, b.tier_id));
}

/**
 * Does this price match more than one tier — i.e. does the Manager have a
 * decision to make on this row?
 *
 * Exported so the Step-3 filter and `TierCell` ask the SAME question rather
 * than each re-deriving `candidates.length > 1`.
 */
export function isAmbiguousPrice(
  priceUsd: number,
  tiers: readonly TierPriceEntry[],
): boolean {
  return candidateTiersForPrice(priceUsd, tiers).length > 1;
}
