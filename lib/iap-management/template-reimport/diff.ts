/**
 * [TEMPLATE-xlsx-reimport] PA2.2 — what an "Export for editing" import WILL
 * DO, for the preview (Manager 2026-10-19, Q-F).
 *
 * ⚠ DISPLAY ONLY. The current template is read to SHOW the change, never to
 *   decide what is written: the write is always exactly the file (rule 1).
 *   Nothing here may feed `replaceTemplate`. In particular nothing here may
 *   treat a price equal to the current one (or Apple's, or the Default's) as
 *   "inherited" — the Manager forbade that heuristic, and an override set on
 *   purpose at the same price as before stays an override.
 *
 * Pure: no I/O, no Apple, no DB. Prices compare at NUMERIC(18,4) precision
 * (`canon`) because PostgREST may hand NUMERIC back as a string ("1.9900").
 */
import { compareTierId } from "../tier-order";

export interface DiffEntry {
  tier_id: string;
  territory_code: string;
  currency_code: string;
  customer_price: number | string;
  proceeds?: number | string | null;
}

export type RemovedBecause = "cleared" | "column-absent" | "row-absent";

export interface DiffChange {
  kind: "added" | "changed" | "removed";
  tier_id: string;
  territory_code: string;
  before: { price: number; currency: string } | null;
  after: { price: number; currency: string } | null;
  removedBecause?: RemovedBecause;
  /** "usa" — the USA cell (bulk import's accepted tiers + USD base);
   *  "magnitude" — new/old price ×10 or ÷10 (a locale typo like 49,000 → 49);
   *  "ladder" — a new override outside its neighbouring tiers in the file. */
  flags: Array<"usa" | "magnitude" | "ladder">;
}

export interface TemplateDiff {
  totals: {
    before: number;
    after: number;
    added: number;
    changed: number;
    removed: number;
    removedCleared: number;
    removedColumnAbsent: number;
    removedRowAbsent: number;
    unchanged: number;
    /** Entries that hold proceeds today — every one is NULL after the write (Q-G). */
    proceedsCleared: number;
  };
  warnings: {
    /** USA cells changed: bulk import reads its tiers and USD base from them. */
    usaChanges: number;
    /** The file has no USA column — bulk import from this template will find no tier. */
    usaColumnMissing: boolean;
    /** The USA column's currency is not USD — bulk import only reads USD USA prices. */
    usaCurrencyNotUsd: boolean;
    magnitude: number;
    ladder: number;
  };
  /** Every added / changed / removed cell (unchanged cells are only counted). */
  changes: DiffChange[];
}

const canon = (x: number | string | null | undefined) => Math.round(Number(x) * 1e4);
const keyOf = (e: { tier_id: string; territory_code: string }) => `${e.tier_id}|${e.territory_code}`;

export function diffTemplate(args: {
  current: ReadonlyArray<DiffEntry>;
  file: {
    entries: ReadonlyArray<DiffEntry>;
    territories: ReadonlyArray<string>;
    tierIds: ReadonlyArray<string>;
    headerCurrency: ReadonlyMap<string, string>;
  };
}): TemplateDiff {
  const { current, file } = args;
  const before = new Map(current.map((e) => [keyOf(e), e]));
  const after = new Map(file.entries.map((e) => [keyOf(e), e]));
  const fileTerritories = new Set(file.territories);
  const fileTiers = new Set(file.tierIds);
  const changes: DiffChange[] = [];
  let unchanged = 0;

  for (const [key, a] of after) {
    const b = before.get(key);
    const afterPrice = { price: Number(a.customer_price), currency: a.currency_code };
    if (!b) {
      changes.push({ kind: "added", tier_id: a.tier_id, territory_code: a.territory_code, before: null, after: afterPrice, flags: [] });
      continue;
    }
    if (canon(b.customer_price) !== canon(a.customer_price) || b.currency_code !== a.currency_code) {
      const flags: DiffChange["flags"] = [];
      const bp = Number(b.customer_price);
      const ap = Number(a.customer_price);
      if (bp > 0 && (ap / bp > 10 || ap / bp < 0.1)) flags.push("magnitude");
      changes.push({
        kind: "changed",
        tier_id: a.tier_id,
        territory_code: a.territory_code,
        before: { price: bp, currency: b.currency_code },
        after: afterPrice,
        flags,
      });
      continue;
    }
    unchanged += 1;
  }
  for (const [key, b] of before) {
    if (after.has(key)) continue;
    const removedBecause: RemovedBecause = !fileTerritories.has(b.territory_code)
      ? "column-absent"
      : !fileTiers.has(b.tier_id)
        ? "row-absent"
        : "cleared";
    changes.push({
      kind: "removed",
      tier_id: b.tier_id,
      territory_code: b.territory_code,
      before: { price: Number(b.customer_price), currency: b.currency_code },
      after: null,
      removedBecause,
      flags: [],
    });
  }

  // Ladder: a NEW override should sit between the neighbouring standard tiers
  // of its own column in the file (prices rise with the tier). Warn only.
  const byTerritory = new Map<string, Array<{ tier_id: string; price: number }>>();
  for (const e of file.entries) {
    if (e.tier_id.startsWith("ALT_")) continue;
    if (!byTerritory.has(e.territory_code)) byTerritory.set(e.territory_code, []);
    byTerritory.get(e.territory_code)!.push({ tier_id: e.tier_id, price: Number(e.customer_price) });
  }
  for (const col of byTerritory.values()) col.sort((x, y) => compareTierId(x.tier_id, y.tier_id));
  for (const ch of changes) {
    if (ch.territory_code === "USA") ch.flags.push("usa");
    if (ch.kind !== "added" || ch.tier_id.startsWith("ALT_")) continue;
    const col = byTerritory.get(ch.territory_code) ?? [];
    const i = col.findIndex((x) => x.tier_id === ch.tier_id);
    const lower = i > 0 ? col[i - 1].price : undefined;
    const higher = i >= 0 && i < col.length - 1 ? col[i + 1].price : undefined;
    const p = ch.after!.price;
    if ((lower !== undefined && p < lower) || (higher !== undefined && p > higher)) ch.flags.push("ladder");
  }

  const count = (k: DiffChange["kind"]) => changes.filter((c) => c.kind === k).length;
  const removed = changes.filter((c) => c.kind === "removed");
  return {
    totals: {
      before: before.size,
      after: after.size,
      added: count("added"),
      changed: count("changed"),
      removed: removed.length,
      removedCleared: removed.filter((c) => c.removedBecause === "cleared").length,
      removedColumnAbsent: removed.filter((c) => c.removedBecause === "column-absent").length,
      removedRowAbsent: removed.filter((c) => c.removedBecause === "row-absent").length,
      unchanged,
      proceedsCleared: current.filter((e) => e.proceeds !== null && e.proceeds !== undefined).length,
    },
    warnings: {
      usaChanges: changes.filter((c) => c.flags.includes("usa")).length,
      usaColumnMissing: !fileTerritories.has("USA"),
      usaCurrencyNotUsd: fileTerritories.has("USA") && file.headerCurrency.get("USA") !== "USD",
      magnitude: changes.filter((c) => c.flags.includes("magnitude")).length,
      ladder: changes.filter((c) => c.flags.includes("ladder")).length,
    },
    changes,
  };
}
