/**
 * R6 (2026-10-19) — a template's entries are read COMPLETELY, or not at all.
 *
 * Runs on REAL Postgres (PGlite 0.4.6 = Postgres 17.5), not on a fake that
 * merely pretends to paginate: R6 lives in the query planner. The census
 * measured the real 16 625-entry template read by `fetchAllEntries` (pages
 * with no ORDER BY) losing 1 225–1 400 entries while still returning
 * `count` rows — an index scan for the first OFFSETs, a heap scan for the
 * later ones, pages overlapping and skipping until duplicates and misses
 * cancel out. HTTP 200, no log, the matrix screen showing the same hole.
 *
 * Which plan Postgres picks depends on statistics, so this test FORCES the
 * same split the census observed (planner switches, per page) instead of
 * hoping ANALYZE reproduces it: index scan for OFFSET < 2000, sequential
 * (heap) scan from 2000 on. Data = the real Manager template file, inserted
 * in the order `replaceTemplate` inserts it.
 *
 * The DB layer is the shared PostgREST-shaped fake over PGlite
 * (`pglite-iap-db.test-helper.ts`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { FlatTemplateEntry } from "../parsers/price-tiers";
import { createPgIapDb, loadRealTemplateFile, type PgIapDb } from "./pglite-iap-db.test-helper";

vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db", () => ({ iapDb: () => dbHolder.current }));

import { getTemplateOverview } from "./templates";
import { readTemplateEntries, TemplateEntriesIncompleteError } from "./template-entries";
import { composeMatrix, fetchDefaultMatrix } from "./template-matrix";

const ROOT = process.cwd();
const ACCOUNT = "acct-r6";

let h: PgIapDb;
let fileEntries: FlatTemplateEntry[];
let fileTerritoryOrder: string[];
let templateId: string;

/** The slice of the fake's query builder the legacy read uses. */
interface LegacyQuery extends PromiseLike<unknown> {
  select(cols: string, opts?: { count?: string; head?: boolean }): LegacyQuery;
  eq(col: string, val: unknown): LegacyQuery;
  range(from: number, to: number): LegacyQuery;
}

/** What `fetchAllEntries` did before R6: count, then pages with NO ORDER BY,
 *  offset += 1000, no check. Kept here only to prove the harness reproduces
 *  the defect the fix is about. */
async function legacyUnorderedRead(id: string): Promise<FlatTemplateEntry[]> {
  const db = h.db as { from: (table: string) => LegacyQuery };
  const countRes = (await db
    .from("price_tier_template_entries")
    .select("template_id", { count: "exact", head: true })
    .eq("template_id", id)) as { count: number };
  const out: FlatTemplateEntry[] = [];
  for (let offset = 0; offset < countRes.count; offset += 1000) {
    const page = (await db
      .from("price_tier_template_entries")
      .select("tier_id, territory_code, currency_code, customer_price, proceeds")
      .eq("template_id", id)
      .range(offset, offset + 999)) as { data: FlatTemplateEntry[] };
    out.push(...page.data);
  }
  return out;
}

const keyOf = (e: { tier_id: string; territory_code: string }) => `${e.tier_id}|${e.territory_code}`;
const canon = (x: unknown) => Math.round(Number(x) * 1e4);

beforeAll(async () => {
  const file = await loadRealTemplateFile();
  fileEntries = file.entries;
  fileTerritoryOrder = file.territoryOrder;
  h = await createPgIapDb();
  await h.insertTiers(file.parsed.tiers);
  templateId = await h.insertTemplate(fileEntries, { account: ACCOUNT });
  dbHolder.current = h.db;
}, 60_000);

beforeEach(() => {
  h.resetKnobs();
  h.knobs.forceSplitAt = 2000;
});

describe("R6 — template entries are read completely or not at all (real Postgres)", () => {
  it("fixture: the real Manager template — 95 tiers × 175 territories = 16 625 entries", () => {
    expect(fileEntries).toHaveLength(16_625);
    expect(new Set(fileEntries.map((e) => e.tier_id)).size).toBe(95);
    expect(fileTerritoryOrder).toHaveLength(175);
  });

  it("harness self-check: the pre-R6 read (no ORDER BY) loses entries while returning `count` rows", async () => {
    // Index order first (ALT_*, FREE, TIER_1, TIER_10, TIER_11, part of
    // TIER_12), heap order from OFFSET 2000 on ⇒ the first 2 000 heap rows
    // (FREE, TIER_1 … TIER_10, the start of TIER_11) are read only where the
    // index pages happened to cover them: TIER_2 … TIER_9 (8 × 175 = 1 400)
    // are never read, and 1 400 others are read twice. The census number.
    const rows = await legacyUnorderedRead(templateId);
    const distinct = new Set(rows.map(keyOf));
    expect(rows).toHaveLength(16_625);
    expect(distinct.size).toBe(15_225);
    const lostTiers = [...new Set(fileEntries.filter((e) => !distinct.has(keyOf(e))).map((e) => e.tier_id))];
    expect(lostTiers.sort()).toEqual(
      ["TIER_2", "TIER_3", "TIER_4", "TIER_5", "TIER_6", "TIER_7", "TIER_8", "TIER_9"],
    );
  });

  it("readTemplateEntries under the same plan split: all 16 625 entries, each exactly once, equal to the file", async () => {
    const rows = await readTemplateEntries(templateId);
    expect(rows).toHaveLength(16_625);
    expect(new Set(rows.map(keyOf)).size).toBe(16_625);
    const byKey = new Map(rows.map((r) => [keyOf(r), r]));
    const diffs = fileEntries.filter((e) => {
      const r = byKey.get(keyOf(e));
      return !r || r.currency_code !== e.currency_code || canon(r.customer_price) !== canon(e.customer_price);
    });
    expect(diffs).toEqual([]);
  });

  it("the matrix (screen + export read) under the plan split: every cell, and the Hotfix 24 column order of the file", async () => {
    const result = await fetchDefaultMatrix(ACCOUNT);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.matrix.cells)).toHaveLength(16_625);
    expect(result!.matrix.tiers).toHaveLength(95);
    expect(result!.matrix.markets.map((m) => m.code)).toEqual(fileTerritoryOrder);
  });

  it("the Settings overview under the plan split: 16 625 entries, 95 tiers × 175", async () => {
    const overview = await getTemplateOverview({ kind: "ACCOUNT", account_id: ACCOUNT });
    expect(overview.populated_entry_count).toBe(16_625);
    expect(overview.territory_count).toBe(175);
    expect(overview.tiers).toHaveLength(95);
    expect(overview.tiers.every((t) => t.entries.length === 175)).toBe(true);
  });

  it("PostgREST max_rows below the page size: still complete (pages advance by rows received)", async () => {
    h.knobs.maxRows = 500;
    const rows = await readTemplateEntries(templateId);
    expect(rows).toHaveLength(16_625);
    expect(new Set(rows.map(keyOf)).size).toBe(16_625);
  });

  it("template replaced while being read ⇒ a clear error, never the partial rows", async () => {
    const victim = await h.insertTemplate(fileEntries.slice(0, 3_000), { account: "acct-victim" });
    h.knobs.afterEntriesPage = async (n) => {
      if (n === 0) await h.pg.query("delete from iap_mgmt.price_tier_templates where id = $1", [victim]);
    };
    const err = await readTemplateEntries(victim).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TemplateEntriesIncompleteError);
    expect(err).toMatchObject({ expected: 3_000, rowsRead: 1_000, distinctRead: 1_000 });
    expect(String((err as Error).message)).toMatch(/could not be read completely: read 1000 rows \(1000 distinct\) of 3000/);
  });

  it("a count that cannot be had ⇒ an error, not an empty template", async () => {
    h.knobs.nullCount = true;
    await expect(readTemplateEntries(templateId)).rejects.toThrow(/count unavailable/);
  });

  it("composeMatrix: the column order never adds or drops a column — unknown codes ignored, unlisted codes appended", () => {
    const entries = [
      { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "VNM", currency_code: "VND", customer_price: 22000, proceeds: null },
      { tier_id: "TIER_1", territory_code: "JPN", currency_code: "JPY", customer_price: 160, proceeds: null },
    ];
    const m = composeMatrix({ entries, tierNames: new Map(), marketOrder: ["VNM", "XXX", "USA"] });
    expect(m.markets.map((x) => x.code)).toEqual(["VNM", "USA", "JPN"]);
  });

  it("the fixture's entries table is the migration's (PK + lookup index)", () => {
    const sql = fs.readFileSync(
      path.join(ROOT, "supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql"),
      "utf8",
    );
    expect(sql).toMatch(/PRIMARY KEY \(template_id, tier_id, territory_code\)/);
    expect(sql).toMatch(/ON iap_mgmt\.price_tier_template_entries\(template_id, tier_id\)/);
  });
});

describe("R6 — one reader (KB P1): no second paged read of entry CONTENT", () => {
  const code = (rel: string) =>
    fs
      .readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("template-entries.ts pages entries in exactly one place — readTemplateEntries, ordered by the key", () => {
    const src = code("lib/iap-management/queries/template-entries.ts");
    expect(src.match(/\.range\(/g)).toHaveLength(1);
    const reader = src.slice(src.indexOf("export async function readTemplateEntries"));
    expect(reader.indexOf(".range(")).toBeGreaterThan(reader.indexOf('.order("territory_code"'));
    expect(reader.indexOf('.order("territory_code"')).toBeGreaterThan(reader.indexOf('.order("tier_id"'));
  });

  it("templates.ts no longer pages entries itself — it reads through the shared reader", () => {
    const src = code("lib/iap-management/queries/templates.ts");
    expect(src.match(/\.range\(/g)).toBeNull();
    expect(src.match(/readTemplateEntries\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("template-matrix.ts pages only the column ORDER (territory_code), never entry content", () => {
    const src = code("lib/iap-management/queries/template-matrix.ts");
    expect(src.match(/\.range\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/customer_price, proceeds/);
    expect(src).toMatch(/\.select\("territory_code"\)/);
  });
});
