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
 * The DB layer below is a PostgREST-shaped fake: it turns the supabase-js
 * calls the repository makes into the SQL PostgREST would send (filters,
 * ORDER BY, LIMIT/OFFSET) and runs it on PGlite.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { parsePriceTiersXlsx, flattenTemplateEntries } from "../parsers/price-tiers";
import type { FlatTemplateEntry } from "../parsers/price-tiers";

vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db", () => ({ iapDb: () => dbHolder.current }));

import { getTemplateOverview } from "./templates";
import { readTemplateEntries, TemplateEntriesIncompleteError } from "./template-entries";
import { composeMatrix, fetchDefaultMatrix } from "./template-matrix";

const ROOT = process.cwd();
const ACCOUNT = "acct-r6";

// The entries table exactly as the migration declares it (PK + lookup index
// + FKs) — pinned against the migration file in the last test.
const DDL = `
create schema iap_mgmt;
create table iap_mgmt.price_tiers (tier_id text primary key, tier_name text not null);
create table iap_mgmt.price_tier_templates (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null, scope_account_id text, scope_app_id text,
  uploaded_at timestamptz not null default now(), uploaded_by text not null,
  source_filename text, origin_note text);
create table iap_mgmt.price_tier_template_entries (
  template_id    uuid           not null references iap_mgmt.price_tier_templates(id) on delete cascade,
  tier_id        text           not null references iap_mgmt.price_tiers(tier_id) on delete cascade,
  territory_code text           not null,
  currency_code  text           not null,
  customer_price numeric(18, 4) not null,
  proceeds       numeric(18, 4),
  primary key (template_id, tier_id, territory_code));
create index idx_iap_mgmt_price_tier_template_entries_lookup
  on iap_mgmt.price_tier_template_entries(template_id, tier_id);
`;

/** Knobs of the fake PostgREST. */
const knobs = {
  /** Force the planner per entries page (R6). */
  forceSplitAt: null as number | null,
  /** PostgREST `db-max-rows`: caps every response. */
  maxRows: null as number | null,
  /** Runs after the n-th entries page (0-based). */
  afterEntriesPage: null as null | ((n: number) => Promise<void>),
  /** Make the count request return null (no Content-Range). */
  nullCount: false,
};
let entriesPagesServed = 0;

type Row = Record<string, unknown>;

function makeDb(pg: PGlite) {
  class Query {
    private cols = "*";
    private head = false;
    private filters: Array<[string, unknown]> = [];
    private orders: Array<[string, boolean]> = [];
    private rng: [number, number] | null = null;
    constructor(private readonly table: string) {}
    select(cols: string, opts?: { count?: string; head?: boolean }) {
      this.cols = cols;
      this.head = opts?.head === true;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    is(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orders.push([col, opts?.ascending !== false]);
      return this;
    }
    range(from: number, to: number) {
      this.rng = [from, to];
      return this;
    }
    private async run(): Promise<{ data: Row[] | null; error: null; count: number | null }> {
      const params: unknown[] = [];
      const where = this.filters.map(([c, v]) => {
        if (v === null) return `${c} is null`;
        params.push(v);
        return `${c} = $${params.length}`;
      });
      const w = where.length ? ` where ${where.join(" and ")}` : "";
      if (this.head) {
        const r = await pg.query<{ n: number }>(
          `select count(*)::int as n from iap_mgmt.${this.table}${w}`,
          params,
        );
        return { data: null, error: null, count: knobs.nullCount ? null : r.rows[0].n };
      }
      const ord = this.orders.length
        ? ` order by ${this.orders.map(([c, a]) => `${c} ${a ? "asc" : "desc"}`).join(", ")}`
        : "";
      const lim = this.rng ? ` limit ${this.rng[1] - this.rng[0] + 1} offset ${this.rng[0]}` : "";
      const isEntriesPage = this.table === "price_tier_template_entries" && this.rng !== null;
      if (isEntriesPage && knobs.forceSplitAt !== null) {
        // The census-observed split: index order first, heap order after.
        await pg.exec(
          this.rng![0] < knobs.forceSplitAt
            ? "set enable_seqscan = off; set enable_bitmapscan = off; set enable_indexscan = on;"
            : "set enable_indexscan = off; set enable_indexonlyscan = off; set enable_bitmapscan = off; set enable_seqscan = on;",
        );
      }
      const r = await pg.query<Row>(`select ${this.cols} from iap_mgmt.${this.table}${w}${ord}${lim}`, params);
      if (isEntriesPage) await pg.exec("reset all;");
      let rows = r.rows;
      if (knobs.maxRows !== null && rows.length > knobs.maxRows) rows = rows.slice(0, knobs.maxRows);
      if (isEntriesPage && knobs.afterEntriesPage) await knobs.afterEntriesPage(entriesPagesServed);
      if (isEntriesPage) entriesPagesServed += 1;
      return { data: rows, error: null, count: null };
    }
    async maybeSingle() {
      const r = await this.run();
      const rows = r.data ?? [];
      if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: rows[0] ?? null, error: null };
    }
    then<A, B>(onOk: (v: unknown) => A, onErr?: (e: unknown) => B) {
      return this.run().then(onOk, onErr);
    }
  }
  return { from: (table: string) => new Query(table) };
}

let pg: PGlite;
let fileEntries: FlatTemplateEntry[];
let fileTerritoryOrder: string[];
let templateId: string;

async function insertTemplate(entries: FlatTemplateEntry[], account = ACCOUNT): Promise<string> {
  const id = (
    await pg.query<{ id: string }>(
      "insert into iap_mgmt.price_tier_templates (scope_type, scope_account_id, uploaded_by, source_filename) " +
        "values ('ACCOUNT', $1, 'manager@example.test', 'price-tiers-template.xlsx') returning id",
      [account],
    )
  ).rows[0].id;
  // Same shape as replaceTemplate: 1 000-row chunks, in flatten order.
  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((e, j) => {
      const b = j * 6;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
      params.push(id, e.tier_id, e.territory_code, e.currency_code, e.customer_price, e.proceeds);
    });
    await pg.query(
      `insert into iap_mgmt.price_tier_template_entries
         (template_id, tier_id, territory_code, currency_code, customer_price, proceeds)
       values ${values.join(", ")}`,
      params,
    );
  }
  return id;
}

/** What `fetchAllEntries` did before R6: count, then pages with NO ORDER BY,
 *  offset += 1000, no check. Kept here only to prove the harness reproduces
 *  the defect the fix is about. */
async function legacyUnorderedRead(id: string): Promise<FlatTemplateEntry[]> {
  const db = dbHolder.current as ReturnType<typeof makeDb>;
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
  const buf = fs.readFileSync(path.join(ROOT, "docs/iap-management/templates/price-tiers-template.xlsx"));
  const parsed = await parsePriceTiersXlsx(new File([buf], "price-tiers-template.xlsx"));
  fileEntries = flattenTemplateEntries(parsed);
  fileTerritoryOrder = [...new Set(fileEntries.map((e) => e.territory_code))];

  pg = new PGlite();
  await pg.exec(DDL);
  const tierValues = parsed.tiers.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(", ");
  await pg.query(
    `insert into iap_mgmt.price_tiers (tier_id, tier_name) values ${tierValues}`,
    parsed.tiers.flatMap((t) => [t.tier_id, t.tier_name]),
  );
  templateId = await insertTemplate(fileEntries);
  await pg.exec("analyze;");
  dbHolder.current = makeDb(pg);
}, 60_000);

beforeEach(() => {
  knobs.forceSplitAt = 2000;
  knobs.maxRows = null;
  knobs.afterEntriesPage = null;
  knobs.nullCount = false;
  entriesPagesServed = 0;
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
    knobs.maxRows = 500;
    const rows = await readTemplateEntries(templateId);
    expect(rows).toHaveLength(16_625);
    expect(new Set(rows.map(keyOf)).size).toBe(16_625);
  });

  it("template replaced while being read ⇒ a clear error, never the partial rows", async () => {
    const victim = await insertTemplate(fileEntries.slice(0, 3_000), "acct-victim");
    knobs.afterEntriesPage = async (n) => {
      if (n === 0) await pg.query("delete from iap_mgmt.price_tier_templates where id = $1", [victim]);
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
    knobs.nullCount = true;
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
