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
 * Implemented: what the read paths, the matrix export AND `replaceTemplate`
 * use — select (+ exact head count), eq, is, order, range, maybeSingle,
 * single, insert / upsert (+ `.select()` returning), update, delete. Errors
 * come back as `{ error }` like supabase-js, never thrown. Seeding goes
 * through plain SQL helpers (`insertTemplate`), shaped like replaceTemplate's.
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
create table iap_mgmt.price_tiers (
  tier_id text primary key, tier_name text not null,
  imported_at timestamptz not null default now(), imported_by text not null default 'seed');
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
create table iap_mgmt.import_batches (
  id uuid primary key default gen_random_uuid(), app_id text,
  imported_at timestamptz not null default now(), imported_by text not null,
  template_version text, total_rows int not null default 0, created_count int not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED')),
  notes text);
create table iap_mgmt.actions_log (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references iap_mgmt.import_batches(id) on delete set null,
  actor text not null,
  action_type text not null check (action_type in ('PRICE_TIER_IMPORT', 'BULK_IMPORT_BATCH')),
  payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
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
  /** Fail the n-th (0-based) INSERT into price_tier_template_entries — a
   *  write that breaks part-way (after the old template was deleted). */
  failEntriesInsertAt: number | null;
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
  const knobs: FakeKnobs = {
    forceSplitAt: null,
    maxRows: null,
    afterEntriesPage: null,
    nullCount: false,
    failEntriesInsertAt: null,
  };
  let entriesPagesServed = 0;
  let entriesInserts = 0;
  const sqlValue = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

  class Query {
    private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    private payload: Row | Row[] | null = null;
    private onConflict: string | null = null;
    private returning: string | null = null;
    private cols = "*";
    private head = false;
    private filters: Array<[string, unknown]> = [];
    private orders: Array<[string, boolean]> = [];
    private rng: [number, number] | null = null;
    constructor(private readonly table: string) {}
    select(cols: string, opts?: { count?: string; head?: boolean }) {
      if (this.op !== "select") {
        this.returning = cols;
        return this;
      }
      this.cols = cols;
      this.head = opts?.head === true;
      return this;
    }
    insert(payload: Row | Row[]) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = payload;
      this.onConflict = opts?.onConflict ?? null;
      return this;
    }
    update(payload: Row) {
      this.op = "update";
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
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
    private async run(): Promise<{ data: Row[] | null; error: { message: string } | null; count: number | null }> {
      try {
        return this.op === "select" ? await this.runSelect() : await this.runWrite();
      } catch (err) {
        return { data: null, error: { message: err instanceof Error ? err.message : String(err) }, count: null };
      }
    }
    private whereClause(params: unknown[]): string {
      const where = this.filters.map(([c, v]) => {
        if (v === null) return `${c} is null`;
        params.push(sqlValue(v));
        return `${c} = $${params.length}`;
      });
      return where.length ? ` where ${where.join(" and ")}` : "";
    }
    private async runWrite(): Promise<{ data: Row[] | null; error: { message: string } | null; count: number | null }> {
      const params: unknown[] = [];
      const ret = this.returning ? ` returning ${this.returning}` : "";
      if (this.op === "delete") {
        const w = this.whereClause(params);
        const r = await pg.query<Row>(`delete from iap_mgmt.${this.table}${w}${ret}`, params);
        return { data: r.rows, error: null, count: null };
      }
      if (this.op === "update") {
        const sets = Object.entries(this.payload as Row).map(([c, v]) => {
          params.push(sqlValue(v));
          return `${c} = $${params.length}`;
        });
        const w = this.whereClause(params);
        const r = await pg.query<Row>(`update iap_mgmt.${this.table} set ${sets.join(", ")}${w}${ret}`, params);
        return { data: r.rows, error: null, count: null };
      }
      // insert / upsert
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      if (this.table === "price_tier_template_entries") {
        const n = entriesInserts++;
        if (knobs.failEntriesInsertAt !== null && n === knobs.failEntriesInsertAt) {
          return { data: null, error: { message: "simulated: connection reset during entries insert" }, count: null };
        }
      }
      if (rows.length === 0) return { data: [], error: null, count: null };
      const cols = Object.keys(rows[0]);
      const tuples = rows.map((row) => {
        const ph = cols.map((c) => {
          params.push(sqlValue(row[c]));
          return `$${params.length}`;
        });
        return `(${ph.join(", ")})`;
      });
      const conflict =
        this.op === "upsert" && this.onConflict
          ? ` on conflict (${this.onConflict}) do update set ${cols
              .filter((c) => c !== this.onConflict)
              .map((c) => `${c} = excluded.${c}`)
              .join(", ")}`
          : "";
      const r = await pg.query<Row>(
        `insert into iap_mgmt.${this.table} (${cols.join(", ")}) values ${tuples.join(", ")}${conflict}${ret}`,
        params,
      );
      return { data: r.rows, error: null, count: null };
    }
    private async runSelect(): Promise<{ data: Row[] | null; error: { message: string } | null; count: number | null }> {
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
      if (r.error) return { data: null, error: r.error };
      const rows = r.data ?? [];
      if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: rows[0] ?? null, error: null };
    }
    async single() {
      const r = await this.run();
      if (r.error) return { data: null, error: r.error };
      const rows = r.data ?? [];
      if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
      return { data: rows[0], error: null };
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
      knobs.failEntriesInsertAt = null;
      entriesPagesServed = 0;
      entriesInserts = 0;
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

/**
 * PA2.3 — the UAT data behind the Excel fixtures in
 * docs/iap-management/uat/pa2-excel/ (guide: README.md there). ONE seeding,
 * used by matrix-reimport.uat-expectations.test.ts — which PINS the committed
 * base files to what "Export for editing" makes from it today, and
 * regenerates them under UAT_REGEN_BASE_FILES=1 — AND by the golden test that
 * reads the files back after the Manager edited them in Excel — so the
 * expected table and the file can never be about two different templates.
 *   Default of UAT_ACCOUNT = the real Manager template (16 625 prices).
 *   Per-App of UAT_APP     = 5 tiers × 5 territories of it, 3 holes.
 */
export const UAT_ACCOUNT = { id: "uat-account", name: "UAT Test Account" } as const;
export const UAT_APP = { id: "uat-app", bundle_id: "com.vng.uat.fixture", name: "UAT Fixture App" } as const;
export const UAT_PER_APP_TIERS = ["TIER_1", "TIER_2", "TIER_3", "TIER_10", "ALT_A"] as const;
export const UAT_PER_APP_TERRITORIES = ["USA", "VNM", "THA", "JPN", "DEU"] as const;
export const UAT_PER_APP_HOLES = ["TIER_2|THA", "TIER_10|JPN", "ALT_A|DEU"] as const;

export async function seedPa2UatFixtures(h: PgIapDb, file: RealTemplateFile): Promise<void> {
  await h.insertTiers(file.parsed.tiers);
  await h.insertTemplate(file.entries, { account: UAT_ACCOUNT.id });
  await h.insertApp(UAT_APP);
  const tiers = new Set<string>(UAT_PER_APP_TIERS);
  const codes = new Set<string>(UAT_PER_APP_TERRITORIES);
  const holes = new Set<string>(UAT_PER_APP_HOLES);
  await h.insertTemplate(
    file.entries.filter(
      (e) => tiers.has(e.tier_id) && codes.has(e.territory_code) && !holes.has(`${e.tier_id}|${e.territory_code}`),
    ),
    { app: UAT_APP.id },
  );
}
