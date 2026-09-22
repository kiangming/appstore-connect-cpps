/**
 * [TIER-TIEBREAK-priority] — the tier ranking is a CONTRACT, and the dropdown
 * and the resolver read it from the same place.
 *
 * ⚠ WHAT THIS REPLACES. `resolveTierByUsdPrice` broke ties with
 * `localeCompare(tier_id)` under a comment reading "Manager spec: ORDER BY
 * tier_id ASC LIMIT 1". That spec is about DETERMINISM, and it delivered
 * determinism — there was a real `.sort()`, so Postgres row order never
 * mattered. What it never decided was which KIND of tier wins, and the answer
 * it produced was an accident of the naming scheme: `"ALT_"` sorts before
 * `"TIER_"`.
 *
 * The original intent is on record in the repo, in three places, all predating
 * this arc:
 *   1. `queries/price-tiers.test.ts` carried a case TITLED "returns TIER_5"
 *      whose assertion read `toBe("ALT_5")`;
 *   2. `queries/template-matrix.ts:87-88` already sorted primary before alternate;
 *   3. `sortTierId` — in TWO byte-identical copies — already ranked
 *      FREE → TIER → ALT, numeric-aware, and the resolver never called it.
 *
 * ⚠ AND THE STAKES, measured 2026-09-22 over production data (KB §26): tiers
 * that tie on USD are NOT interchangeable. $0.99 diverges in 75 of 175
 * countries, $1.99 in 13, $2.99 in 8, $3.99 in 11, $4.99 in 9.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareTierId,
  candidateTiersForPrice,
  isAmbiguousPrice,
} from "./tier-order";
import { resolveTierByUsdPrice, type UsdTierEntry } from "./queries/price-tiers";

/**
 * ⚠ THE $0.99 GROUP IS FOUR TIERS WIDE IN THE REAL DATA, not two. Manager's
 * census SQL (2026-09-22) found five shared-price groups — $0.99, $1.99,
 * $2.99, $3.99, $4.99 — and $0.99 carries ALT_1, ALT_A, ALT_B and TIER_1. A
 * two-element fixture would let a tie-break that is merely "not alphabetical"
 * pass; four elements force the full ranking to be right.
 */
const REAL_SHAPE: UsdTierEntry[] = [
  { tier_id: "ALT_A", customer_price: 0.99 },
  { tier_id: "TIER_1", customer_price: 0.99 },
  { tier_id: "ALT_B", customer_price: 0.99 },
  { tier_id: "ALT_1", customer_price: 0.99 },
  { tier_id: "ALT_5", customer_price: 4.99 },
  { tier_id: "TIER_5", customer_price: 4.99 },
  { tier_id: "TIER_2", customer_price: 1.49 },
  { tier_id: "TIER_10", customer_price: 1.49 },
  { tier_id: "TIER_87", customer_price: 99.99 },
  { tier_id: "FREE", customer_price: 0 },
];

describe("compareTierId — the ranking, stated", () => {
  it("⚠ a standard Tier beats an Alternate at the same price", () => {
    // The whole point of the arc. Under localeCompare this was the reverse.
    expect(compareTierId("TIER_5", "ALT_5")).toBeLessThan(0);
    expect(compareTierId("TIER_1", "ALT_A")).toBeLessThan(0);
  });

  it("⚠ orders standard tiers NUMERICALLY, not as strings", () => {
    // "TIER_2".localeCompare("TIER_10") === 1, i.e. TIER_10 used to win.
    // ⚠ GUARD, NOT A LIVE FIX: the census found NO TIER-vs-TIER collision in
    // production — all five shared-price groups are TIER-vs-ALT. This is a
    // contract written ahead of the case.
    expect(compareTierId("TIER_2", "TIER_10")).toBeLessThan(0);
    expect(compareTierId("TIER_9", "TIER_87")).toBeLessThan(0);
  });

  it("puts FREE first and numeric alternates before letter alternates", () => {
    expect(compareTierId("FREE", "TIER_1")).toBeLessThan(0);
    expect(compareTierId("ALT_1", "ALT_A")).toBeLessThan(0);
    expect(compareTierId("ALT_A", "ALT_B")).toBeLessThan(0);
  });

  it("is a total order — sorting the real-shape group is stable and complete", () => {
    const ids = REAL_SHAPE.filter((t) => t.customer_price === 0.99).map(
      (t) => t.tier_id,
    );
    expect([...ids].sort(compareTierId)).toEqual([
      "TIER_1",
      "ALT_1",
      "ALT_A",
      "ALT_B",
    ]);
  });
});

describe("candidateTiersForPrice — one ordered list", () => {
  it("returns every tier at that price, ranked", () => {
    expect(
      candidateTiersForPrice(0.99, REAL_SHAPE).map((t) => t.tier_id),
    ).toEqual(["TIER_1", "ALT_1", "ALT_A", "ALT_B"]);
  });

  it("⚠ THE INVARIANT: option[0] IS what the resolver picks", () => {
    // Two readers, one list. Before this they were separate expressions —
    // the resolver filtered AND sorted, the dropdown filtered and did NOT —
    // so the top option and the pre-selected value were two answers to one
    // question, the second ordered by whatever Postgres returned.
    for (const price of [0.99, 4.99, 1.49, 99.99]) {
      const first = candidateTiersForPrice(price, REAL_SHAPE)[0]?.tier_id;
      expect(resolveTierByUsdPrice(price, REAL_SHAPE)).toBe(first);
    }
  });

  it("price 0 lists the FREE row", () => {
    expect(candidateTiersForPrice(0, REAL_SHAPE).map((t) => t.tier_id)).toEqual([
      "FREE",
    ]);
  });

  it("⚠ the resolver's FREE short-circuit is NOT this function (IAP.h2 lock)", () => {
    // Price 0 resolves to FREE whether or not the cache holds the row. The
    // list must NOT invent a row that is not there — a dropdown showing an
    // option the data does not contain would be the worse bug.
    const noFree = REAL_SHAPE.filter((t) => t.tier_id !== "FREE");
    expect(candidateTiersForPrice(0, noFree)).toEqual([]);
    expect(resolveTierByUsdPrice(0, noFree)).toBe("FREE");
  });

  it("no match → empty list → resolver returns null", () => {
    expect(candidateTiersForPrice(7.77, REAL_SHAPE)).toEqual([]);
    expect(resolveTierByUsdPrice(7.77, REAL_SHAPE)).toBeNull();
  });

  it("does not mutate the caller's array", () => {
    const before = REAL_SHAPE.map((t) => t.tier_id);
    candidateTiersForPrice(0.99, REAL_SHAPE);
    expect(REAL_SHAPE.map((t) => t.tier_id)).toEqual(before);
  });
});

describe("isAmbiguousPrice — the Step-3 filter predicate", () => {
  it("true only when more than one tier matches", () => {
    expect(isAmbiguousPrice(0.99, REAL_SHAPE)).toBe(true);
    expect(isAmbiguousPrice(4.99, REAL_SHAPE)).toBe(true);
    expect(isAmbiguousPrice(99.99, REAL_SHAPE)).toBe(false);
    expect(isAmbiguousPrice(7.77, REAL_SHAPE)).toBe(false);
  });

  it("agrees with the candidate list it is derived from", () => {
    // The count in the filter bar and the cell that renders a <select> must
    // never be two different judgements of "does this row need a decision".
    for (const price of [0, 0.99, 1.49, 4.99, 7.77, 99.99]) {
      expect(isAmbiguousPrice(price, REAL_SHAPE)).toBe(
        candidateTiersForPrice(price, REAL_SHAPE).length > 1,
      );
    }
  });
});

// ─── structural: exactly one ranking in the codebase ────────────────────────

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * ⚠ COMMENTS ARE NOT CODE, AND THIS TEST LEARNED THAT THE HARD WAY.
 *
 * The first draft of the localeCompare check read the whole file and failed —
 * on the DOCBLOCK in `price-tiers.ts` that quotes the old tie-break so a
 * future reader knows what changed. A structural test that cannot tell a
 * historical quote from live code punishes exactly the comments this arc
 * exists to leave behind. Strip first, then assert.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the ranking has exactly ONE home", () => {
  it("⚠ no module re-declares sortTierId / the rank table", () => {
    // It shipped as TWO byte-identical copies (price-tiers.ts, templates.ts);
    // `templates.ts` even carried a comment admitting it. Using it from a
    // third place without merging would have made three.
    for (const rel of [
      "lib/iap-management/queries/price-tiers.ts",
      "lib/iap-management/queries/templates.ts",
      "lib/iap-management/queries/template-matrix.ts",
      "app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx",
    ]) {
      expect(stripComments(read(rel))).not.toMatch(/function sortTierId/);
    }
  });

  it("⚠ the stripper keeps code and drops comments (guard against a phantom pass)", () => {
    // P44: a probe on the wrong seam reports a harness bug in a product bug's
    // clothing — and a BROKEN stripper would make the next test pass for the
    // wrong reason, silently. Pin the stripper before trusting it.
    const sample = "const a = 1; /* a.tier_id.localeCompare(b) */\nconst b = 2; // also here";
    const out = stripComments(sample);
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
    expect(out).not.toContain("localeCompare");
    expect(out).not.toContain("also here");
  });

  it("⚠ the resolver no longer tie-breaks with localeCompare on tier_id", () => {
    const src = read("lib/iap-management/queries/price-tiers.ts");
    const code = stripComments(src);
    // The old executable shape. The docblock above the resolver still QUOTES
    // it on purpose, which is why this reads `code`, not `src`.
    expect(code).not.toMatch(/a\.tier_id\.localeCompare\(b\.tier_id\)/);
    expect(src).toContain("candidateTiersForPrice(priceUsd, tiers)");
  });

  it("⚠ the wizard does not re-filter tiers by price on its own", () => {
    // The second expression for "which tiers match this price". Its return is
    // the regression: a dropdown ordered independently of the resolver.
    const src = read(
      "app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx",
    );
    expect(stripComments(src)).not.toMatch(
      /usdTiers\.filter\(\(t\) => t\.customer_price ===/,
    );
    expect(src).toContain("candidateTiersForPrice(priceUsd, usdTiers)");
  });
});
