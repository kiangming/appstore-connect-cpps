/**
 * Test helper (not a test: vitest runs `*.test.ts` only) — the `iap_mgmt`
 * pricing-template tables on REAL Postgres (PGlite 0.4.6 = Postgres 17.5),
 * behind a PostgREST-shaped fake of `iapDb()`.
 *
 * Why real Postgres: R6 (2026-10-19) lived in the query planner — a fake that
 * merely slices an array cannot lose rows the way an index-then-heap paged
 * read does. The fake turns the supabase-js calls the repository makes into
 * the SQL PostgREST would send (filters, ORDER BY, LIMIT/OFFSET literal) and
 * runs it on PGlite.
 *
 * Only what the read paths and the matrix export use is implemented: select
 * (+ exact head count), eq, is, order, range, maybeSingle. Writes go through
 * plain SQL helpers (`insertTemplate`), shaped like `replaceTemplate`'s.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { parsePriceTiersXlsx, flattenTemplateEntries } from "../parsers/price-tiers";
import type { FlatTemplateEntry, PriceTiersParseResult } from "../parsers/price-tiers";

/** The entries table exactly as `20260519000000_iap_mgmt_pricing_templates.sql`
 *  declares it (PK + lookup index + FKs) — pinned by the R6 test. */
export const IAP_TEMPLATE_DDL = `
create schema iap_mgmt;
create table iap_mgmt.apps (id text primary key, bundle_id text not null, name text not null default '');
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

export interface FakeKnobs {
  /** Force the planner per entries page (R6): index scan for OFFSET below
   *  this, sequential (heap) scan from it on. null = let Postgres choose. */
  forceSplitAt: number | null;
  /** PostgREST `db-max-rows`: caps every response. */
  maxRows: number | null;
  /** Runs after the n-th entries page (0-based). */
  afterEntriesPage: null | ((n: number) => Promise<void>);
  /** Make the count request return null (no Content-Range). */
  nullCount: boolean;
}

type Row = Record<string, unknown>;

export interface PgIapDb {
  pg: PGlite;
  /** What `iapDb()` should return. */
  db: { from: (table: string) => unknown };
  knobs: FakeKnobs;
  resetKnobs(): void;
  insertTiers(tiers: ReadonlyArray<{ tier_id: string; tier_name: string }>): Promise<void>;
  insertTemplate(
    entries: ReadonlyArray<FlatTemplateEntry>,
    scope: { account: string } | { app: string },
  ): Promise<string>;
  insertApp(app: { id: string; bundle_id: string; name: string }): Promise<void>;
}

export async function createPgIapDb(): Promise<PgIapDb> {
  const pg = new PGlite();
  await pg.exec(IAP_TEMPLATE_DDL);
  const knobs: FakeKnobs = { forceSplitAt: null, maxRows: null, afterEntriesPage: null, nullCount: false };
  let entriesPagesServed = 0;

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

  return {
    pg,
    db: { from: (table: string) => new Query(table) },
    knobs,
    resetKnobs() {
      knobs.forceSplitAt = null;
      knobs.maxRows = null;
      knobs.afterEntriesPage = null;
      knobs.nullCount = false;
      entriesPagesServed = 0;
    },
    async insertTiers(tiers) {
      const values = tiers.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(", ");
      await pg.query(
        `insert into iap_mgmt.price_tiers (tier_id, tier_name) values ${values} on conflict (tier_id) do nothing`,
        tiers.flatMap((t) => [t.tier_id, t.tier_name]),
      );
    },
    async insertApp(app) {
      await pg.query("insert into iap_mgmt.apps (id, bundle_id, name) values ($1, $2, $3)", [
        app.id,
        app.bundle_id,
        app.name,
      ]);
    },
    async insertTemplate(entries, scope) {
      const isApp = "app" in scope;
      const id = (
        await pg.query<{ id: string }>(
          "insert into iap_mgmt.price_tier_templates (scope_type, scope_account_id, scope_app_id, uploaded_by, source_filename) " +
            "values ($1, $2, $3, 'manager@example.test', 'price-tiers-template.xlsx') returning id",
          [isApp ? "APP" : "ACCOUNT", isApp ? null : scope.account, isApp ? scope.app : null],
        )
      ).rows[0].id;
      // Same shape as replaceTemplate: 1 000-row chunks, in the given order.
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
      await pg.exec("analyze;");
      return id;
    },
  };
}

export interface RealTemplateFile {
  bytes: Buffer;
  parsed: PriceTiersParseResult;
  /** Flatten order = the order replaceTemplate inserts. */
  entries: FlatTemplateEntry[];
  /** Column order of the file = the order the matrix must show (Hotfix 24). */
  territoryOrder: string[];
}

/** The real Manager template — docs/iap-management/templates/price-tiers-template.xlsx
 *  (95 tiers × 175 territories = 16 625 entries) — through the REAL parser. */
export async function loadRealTemplateFile(): Promise<RealTemplateFile> {
  const bytes = fs.readFileSync(
    path.join(process.cwd(), "docs/iap-management/templates/price-tiers-template.xlsx"),
  );
  const parsed = await parsePriceTiersXlsx(new File([bytes], "price-tiers-template.xlsx"));
  const entries = flattenTemplateEntries(parsed);
  return { bytes, parsed, entries, territoryOrder: [...new Set(entries.map((e) => e.territory_code))] };
}
