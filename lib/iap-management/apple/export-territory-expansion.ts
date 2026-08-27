/**
 * What "all countries" means in the Apple export.
 *
 * `[Q-EXPORT.apple-only-picker]` (Manager, 2026-08-27): the columns are
 * **Apple's 175 markets** — every territory Apple sells to, and nothing else.
 *
 * ─── WHY THIS IS NOW APPLE'S LIST AND NOT A UNION ──────────────────────────
 *
 * F-B shipped this as `union(catalog 183, Apple 175) = 194`, and that was the
 * right answer to the question being asked then. The picker offered all 183,
 * so all 183 were questions the Manager could ask, and dropping any of them
 * would have been the silent-drop class this arc exists to remove.
 *
 * G3 changed the question. The Apple picker now offers Apple's 175, so the 19
 * catalog-only markets **cannot be ticked**. A column for a market nobody can
 * ask about is not an answer — it is 19 columns of `—` that no reader
 * requested, on every export, forever.
 *
 * ⚠ THE 194 WAS NOT A MISTAKE AND THE 175 IS NOT A CORRECTION. Both are the
 * same rule — *answer every question that can be asked, and only those* —
 * evaluated against different pickers. Which is why the test that pinned 194
 * changes rather than being deleted: the behaviour it guarded still holds, the
 * input to it moved.
 *
 * ─── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * ⚠ NOT a filter, and not a cap. A territory Apple prices that this snapshot
 * has never heard of still gets a column: `buildExportPlan` unions the codes
 * actually observed on top of this expansion. A market Apple added after
 * 2026-08-27 therefore still EXPORTS — it just cannot be TICKED, and it trips
 * the drift warning. ⚠ That asymmetry is new and it is a real escalation:
 * before G3 a stale snapshot meant a wrong column count; now it means a market
 * the Manager cannot select. See the snapshot module's header.
 *
 * ⚠ RUSSIA IS IN, AND `TERRITORY_CATALOG` WAS NEVER TOUCHED. RU is one of the
 * 11 markets Apple sells to that the shared catalog has never carried. It
 * arrives here from the snapshot, so Google's picker — which reads the
 * catalog — gains nothing and risks nothing (P8).
 */
import {
  APPLE_TERRITORIES_ALPHA3,
  unknownAppleTerritories,
} from "./apple-territories.snapshot";
import { toCatalogCode } from "./territory-code-map";

/**
 * Every territory an "all countries" export gets a column for, as alpha-2
 * catalog codes. Exactly the markets the Apple picker offers.
 *
 * ⚠ `toCatalogCode`, NEVER A HAND-ROLLED CONVERSION. The snapshot speaks
 * Apple's alpha-3 and every column code is alpha-2; Kosovo is `XKS` on one
 * side and `XK` on the other, and no ISO table knows that. Ad-hoc conversions
 * have been written three times in this arc and been wrong three times
 * (P27 #4) — each looked plausible and was caught only by a count.
 *
 * Sorted so the column order is deterministic across runs.
 */
export function allExportTerritories(): string[] {
  const codes = new Set<string>();
  for (const alpha3 of APPLE_TERRITORIES_ALPHA3) {
    codes.add(toCatalogCode(alpha3));
  }
  return [...codes].sort();
}

export { unknownAppleTerritories };
