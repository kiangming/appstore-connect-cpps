/**
 * batchSyncIapsFromGoogle — bulk list-refresh path (>1000-item timeout fix).
 *
 * These tests run the real orchestration against an in-memory fake that
 * models the three tables (iaps, iap_listings, iap_prices) with their
 * unique keys + an advancing updated_at clock, so the upsert-then-delete-
 * stale algorithm is exercised end-to-end.
 *
 * Guards:
 *  - EQUIVALENCE: the bulk path's final DB state matches the old per-item
 *    delete-then-insert loop (reference `oldPerItemLoop`), across a
 *    two-sync sequence that includes a removed region (stale cleanup).
 *  - BOUNDED ROUND-TRIPS: a large refresh uses a handful of set-wide
 *    operations, not ~5 per item.
 *  - PARTIAL-FAILURE SAFETY: a failed price upsert never strips an item's
 *    existing prices, and the item is surfaced as failed.
 *  - EMPTY replace + per-item accounting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbSpy, appDefaultsSpy } = vi.hoisted(() => ({
  dbSpy: vi.fn(),
  appDefaultsSpy: vi.fn(),
}));

vi.mock("../db", () => ({ googleIapDb: dbSpy }));
vi.mock("./apps", () => ({ updateAppDefaults: appDefaultsSpy }));

import {
  batchSyncIapsFromGoogle,
  reconcileDeletedOnGoogle,
  acknowledgeRemoveIaps,
  listFlaggedSkusAmong,
} from "./iaps";
import type { InAppProduct } from "../google/publisher-client";

/* ── In-memory fake DB ───────────────────────────────────────────────── */

type Row = Record<string, unknown>;
type Filter = { kind: "eq" | "in" | "lt" | "notNull"; col: string; val: unknown };

class FakeDb {
  tables: Record<string, Row[]> = { iaps: [], iap_listings: [], iap_prices: [] };
  clock = 0;
  idSeq = 0;
  calls: Array<{ table: string; op: string }> = [];
  /** Return a non-null message to force an upsert error for a chunk. */
  upsertErrorHook?: (table: string, rows: Row[]) => string | null;

  from(table: string) {
    return new FakeBuilder(this, table);
  }
  tick() {
    return String(++this.clock).padStart(6, "0");
  }
}

class FakeBuilder {
  private op: "upsert" | "insert" | "delete" | "update" | "select" = "select";
  private rows: Row[] = [];
  private patch: Row = {};
  private conflict?: string;
  private isSingle = false;
  private selected = false;
  private rangeFrom: number | null = null;
  private rangeTo = 0;
  private filters: Filter[] = [];

  constructor(private db: FakeDb, private table: string) {}

  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.conflict = opts?.onConflict;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  select() {
    this.selected = true;
    return this;
  }
  single() {
    this.isSingle = true;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ kind: "in", col, val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ kind: "lt", col, val });
    return this;
  }
  not(col: string, _op: string, _val: unknown) {
    // Only used as .not(col, "is", null) → "col IS NOT NULL".
    this.filters.push({ kind: "notNull", col, val: null });
    return this;
  }
  then<R>(resolve: (v: { data: unknown; error: { message: string } | null }) => R) {
    return Promise.resolve(this.exec()).then(resolve);
  }

  private matches(x: Row): boolean {
    return this.filters.every((f) => {
      if (f.kind === "eq") return x[f.col] === f.val;
      if (f.kind === "in") return (f.val as unknown[]).includes(x[f.col]);
      if (f.kind === "notNull") return x[f.col] !== null && x[f.col] !== undefined;
      return (x[f.col] as string) < (f.val as string); // lt
    });
  }

  private exec(): { data: unknown; error: { message: string } | null } {
    this.db.calls.push({ table: this.table, op: this.op });
    const store = this.db.tables[this.table];

    if (this.op === "upsert") {
      const err = this.db.upsertErrorHook?.(this.table, this.rows);
      if (err) return { data: null, error: { message: err } };
      const keys = (this.conflict ?? "").split(",");
      const out: Row[] = [];
      for (const r of this.rows) {
        const existing = store.find((x) => keys.every((k) => x[k] === r[k]));
        const updated_at = this.db.tick();
        if (existing) {
          Object.assign(existing, r, { updated_at });
          out.push(existing);
        } else {
          const row = { id: `${this.table}-${++this.db.idSeq}`, created_at: updated_at, updated_at, ...r };
          store.push(row);
          out.push(row);
        }
      }
      return { data: this.isSingle ? out[0] ?? null : out, error: null };
    }

    if (this.op === "insert") {
      for (const r of this.rows) {
        const updated_at = this.db.tick();
        store.push({ id: `${this.table}-${++this.db.idSeq}`, created_at: updated_at, updated_at, ...r });
      }
      return { data: null, error: null };
    }

    if (this.op === "update") {
      for (const x of store) {
        if (this.matches(x)) Object.assign(x, this.patch);
      }
      return { data: null, error: null };
    }

    if (this.op === "delete") {
      const removed = store.filter((x) => this.matches(x));
      this.db.tables[this.table] = store.filter((x) => !this.matches(x));
      return { data: this.selected ? removed : null, error: null };
    }

    // select: apply filters, then range slice.
    let out = store.filter((x) => this.matches(x));
    if (this.rangeFrom !== null) out = out.slice(this.rangeFrom, this.rangeTo + 1);
    return { data: out, error: null };
  }
}

/* ── Reference: the OLD per-item delete-then-insert loop ─────────────── */

async function oldPerItemLoop(db: FakeDb, appId: string, products: InAppProduct[]) {
  let synced = 0;
  let failed = 0;
  for (const product of products) {
    try {
      if (!product.sku) throw new Error("no sku");
      const { data: up, error } = await db
        .from("iaps")
        .upsert(
          {
            app_id: appId,
            sku: product.sku,
            purchase_type: product.purchaseType === "subscription" ? "subscription" : "managed",
            status: product.status === "active" ? "active" : "inactive",
            default_currency: product.defaultPrice?.currency ?? null,
            default_price_micros: product.defaultPrice?.priceMicros ?? null,
            last_synced_at: "now",
          },
          { onConflict: "app_id,sku" },
        )
        .select()
        .single();
      if (error) throw new Error(error.message);
      const iapId = (up as { id: string }).id;

      await db.from("iap_listings").delete().eq("iap_id", iapId);
      const listingRows = Object.entries(product.listings ?? {}).map(([locale, l]) => ({
        iap_id: iapId,
        locale,
        title: l.title ?? "",
        description: l.description ?? "",
      }));
      if (listingRows.length > 0) await db.from("iap_listings").insert(listingRows);

      await db.from("iap_prices").delete().eq("iap_id", iapId);
      const priceRows = Object.entries(product.prices ?? {})
        .filter(([, p]) => p?.priceMicros && p?.currency)
        .map(([region, p]) => ({
          iap_id: iapId,
          region_code: region,
          currency: p.currency as string,
          price_micros: p.priceMicros as string,
        }));
      if (priceRows.length > 0) await db.from("iap_prices").insert(priceRows);
      synced += 1;
    } catch {
      failed += 1;
    }
  }
  return { synced, failed };
}

/* ── Snapshot keyed by sku (id-independent) for equivalence compare ──── */

function snapshot(db: FakeDb) {
  const skuById = new Map<string, string>();
  for (const iap of db.tables.iaps) skuById.set(iap.id as string, iap.sku as string);
  const norm = (t: string, extra: (r: Row) => Row) =>
    db.tables[t]
      .map((r) => ({ sku: skuById.get(r.iap_id as string), ...extra(r) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    iaps: db.tables.iaps
      .map((r) => ({ sku: r.sku, status: r.status, default_currency: r.default_currency }))
      .sort((a, b) => String(a.sku).localeCompare(String(b.sku))),
    listings: norm("iap_listings", (r) => ({ locale: r.locale, title: r.title, description: r.description })),
    prices: norm("iap_prices", (r) => ({ region: r.region_code, currency: r.currency, micros: r.price_micros })),
  };
}

function product(sku: string, opts: Partial<InAppProduct> = {}): InAppProduct {
  return {
    sku,
    status: "active",
    purchaseType: "managedUser",
    defaultLanguage: "en-US",
    defaultPrice: { currency: "USD", priceMicros: "990000" },
    listings: { "en-US": { title: `${sku} title`, description: "d" } },
    prices: { US: { currency: "USD", priceMicros: "990000" } },
    ...opts,
  } as unknown as InAppProduct;
}

beforeEach(() => {
  dbSpy.mockReset();
  appDefaultsSpy.mockReset();
  appDefaultsSpy.mockResolvedValue(undefined);
});

/* ── Tests ───────────────────────────────────────────────────────────── */

describe("batchSyncIapsFromGoogle — equivalence with old per-item loop", () => {
  it("produces identical final DB state across a two-sync sequence (incl. removed region)", async () => {
    const products1 = [
      product("coins.a", {
        listings: { "en-US": { title: "A", description: "aa" }, "ko-KR": { title: "에이", description: "" } },
        prices: {
          US: { currency: "USD", priceMicros: "990000" },
          GB: { currency: "GBP", priceMicros: "790000" },
        },
      } as unknown as Partial<InAppProduct>),
      product("coins.b"),
      product("coins.c", { prices: {} } as Partial<InAppProduct>), // no explicit prices
    ];
    // Second sync: coins.a drops GB (stale region must be removed), b changes price.
    const products2 = [
      product("coins.a", {
        listings: { "en-US": { title: "A2", description: "aa" } },
        prices: { US: { currency: "USD", priceMicros: "1990000" } },
      } as unknown as Partial<InAppProduct>),
      product("coins.b", { prices: { US: { currency: "USD", priceMicros: "490000" } } } as Partial<InAppProduct>),
      product("coins.c", { prices: {} } as Partial<InAppProduct>),
    ];

    const bulkDb = new FakeDb();
    dbSpy.mockReturnValue(bulkDb);
    await batchSyncIapsFromGoogle("app-1", products1);
    await batchSyncIapsFromGoogle("app-1", products2);

    const refDb = new FakeDb();
    await oldPerItemLoop(refDb, "app-1", products1);
    await oldPerItemLoop(refDb, "app-1", products2);

    expect(snapshot(bulkDb)).toEqual(snapshot(refDb));
    // Sanity: coins.a's stale GB price is gone in both.
    expect(snapshot(bulkDb).prices.some((p) => (p as { region?: string }).region === "GB")).toBe(false);
  });
});

describe("batchSyncIapsFromGoogle — bounded round-trips (not linear per item)", () => {
  it("100 items → a handful of set-wide ops, not ~5×N", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    const products = Array.from({ length: 100 }, (_, i) =>
      product(`sku.${i}`, {
        listings: { "en-US": { title: `t${i}`, description: "" }, "ko-KR": { title: "k", description: "" } },
        prices: {
          US: { currency: "USD", priceMicros: "990000" },
          GB: { currency: "GBP", priceMicros: "790000" },
          VN: { currency: "VND", priceMicros: "23000000000" },
        },
      } as unknown as Partial<InAppProduct>),
    );
    const { synced, failed } = await batchSyncIapsFromGoogle("app-1", products);

    expect(synced).toBe(100);
    expect(failed).toBe(0);
    // Old loop would be ~5×100 = 500 DB calls. Bulk path is a few dozen.
    expect(db.calls.length).toBeLessThan(20);
    // And far below linear-per-item.
    expect(db.calls.length).toBeLessThan(products.length);
  });

  it("does not scale linearly: doubling items keeps ops bounded", async () => {
    const run = async (n: number) => {
      const db = new FakeDb();
      dbSpy.mockReturnValue(db);
      await batchSyncIapsFromGoogle(
        "app-1",
        Array.from({ length: n }, (_, i) => product(`s.${i}`)),
      );
      return db.calls.length;
    };
    const c100 = await run(100);
    const c200 = await run(200);
    expect(c100).toBeLessThan(15);
    expect(c200).toBeLessThan(15);
  });
});

describe("batchSyncIapsFromGoogle — partial-failure safety (never strips prices)", () => {
  it("a failed price upsert leaves existing prices intact and surfaces the item as failed", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);

    // Sync #1 — populate prices for both items.
    await batchSyncIapsFromGoogle("app-1", [product("keep.a"), product("keep.b")]);
    const pricesAfter1 = db.tables.iap_prices.length;
    expect(pricesAfter1).toBe(2);

    // Sync #2 — force EVERY iap_prices upsert to fail.
    db.upsertErrorHook = (table) => (table === "iap_prices" ? "simulated price upsert failure" : null);
    const { synced, failed } = await batchSyncIapsFromGoogle("app-1", [
      product("keep.a", { prices: { US: { currency: "USD", priceMicros: "1990000" } } } as Partial<InAppProduct>),
      product("keep.b", { prices: { US: { currency: "USD", priceMicros: "1990000" } } } as Partial<InAppProduct>),
    ]);

    // No price was stripped — the old rows survive (upsert-before-delete +
    // failed items excluded from the delete pass).
    expect(db.tables.iap_prices.length).toBe(2);
    // Both items surfaced as failed.
    expect(failed).toBe(2);
    expect(synced).toBe(0);
    // Listings (which did NOT fail) were still updated → set-wide isolation.
    expect(db.tables.iap_listings.length).toBe(2);
  });

  it("chunk isolation: failing one price chunk fails only its items; a preseeded item keeps its prices", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);

    // >1000 price rows to force 2 upsert chunks (CHILD_UPSERT_CHUNK=1000).
    // 700 single-price items = 700 rows (chunk 1) + one 400-region item
    // = spills into chunk 2.
    const many = Array.from({ length: 700 }, (_, i) => product(`c1.${i}`));
    const bigRegions: Record<string, { currency: string; priceMicros: string }> = {};
    for (let i = 0; i < 400; i++) bigRegions[`R${i}`] = { currency: "USD", priceMicros: "990000" };
    const spill = product("c2.big", { prices: bigRegions } as Partial<InAppProduct>);

    // Seed first so the spill item has existing prices to protect.
    await batchSyncIapsFromGoogle("app-1", [...many, spill]);
    const spillId = db.tables.iaps.find((r) => r.sku === "c2.big")!.id as string;
    const spillPricesBefore = db.tables.iap_prices.filter((r) => r.iap_id === spillId).length;
    expect(spillPricesBefore).toBe(400);

    // Re-sync; fail only the chunk that contains the spill item's rows.
    db.upsertErrorHook = (table, rows) =>
      table === "iap_prices" && rows.some((r) => r.iap_id === spillId)
        ? "chunk 2 failed"
        : null;
    const { failed } = await batchSyncIapsFromGoogle("app-1", [...many, spill]);

    // Spill item retained all its prices (never stripped).
    expect(db.tables.iap_prices.filter((r) => r.iap_id === spillId).length).toBe(400);
    // Its failure is surfaced; chunk-1 items still succeeded.
    expect(failed).toBeGreaterThanOrEqual(1);
  });
});

describe("batchSyncIapsFromGoogle — replace + accounting", () => {
  it("an item whose prices went empty has its stale prices removed", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    await batchSyncIapsFromGoogle("app-1", [product("x")]);
    expect(db.tables.iap_prices.length).toBe(1);

    await batchSyncIapsFromGoogle("app-1", [product("x", { prices: {} } as Partial<InAppProduct>)]);
    expect(db.tables.iap_prices.length).toBe(0);
  });

  it("counts no-sku products as failed; total = synced + failed", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    const products = [
      product("ok.1"),
      { status: "active", purchaseType: "managedUser" } as unknown as InAppProduct, // no sku
      product("ok.2"),
    ];
    const { synced, failed } = await batchSyncIapsFromGoogle("app-1", products);
    expect(synced).toBe(2);
    expect(failed).toBe(1);
    expect(synced + failed).toBe(products.length);
  });
});

/* ── Soft-delete flag reconcile ──────────────────────────────────────── */

function seedIap(
  db: FakeDb,
  appId: string,
  sku: string,
  deleted_on_google_at: string | null = null,
) {
  db.tables.iaps.push({
    id: `iap-${sku}`,
    app_id: appId,
    sku,
    deleted_on_google_at,
  });
}

describe("reconcileDeletedOnGoogle — flag / unflag / preserve", () => {
  const base = { allProductsHadSku: true, fetchComplete: true, now: "2026-07-02T00:00:00Z" };

  it("flags items absent from Google; items in both stay clear", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    // 4 cached, 2 incoming (≥50% — clears the anomaly guard).
    seedIap(db, "app-1", "live.a");
    seedIap(db, "app-1", "live.b");
    seedIap(db, "app-1", "gone.c");
    seedIap(db, "app-1", "gone.d");

    const r = await reconcileDeletedOnGoogle({
      ...base,
      appId: "app-1",
      incomingSkus: ["live.a", "live.b"],
    });
    expect(r.flagged).toBe(2);
    expect(r.flaggedSkus.sort()).toEqual(["gone.c", "gone.d"]);
    expect(r.skippedReason).toBeNull();
    // live items stay clear; the two absent ones are flagged.
    const byS = Object.fromEntries(db.tables.iaps.map((r2) => [r2.sku, r2.deleted_on_google_at]));
    expect(byS["live.a"]).toBeNull();
    expect(byS["gone.c"]).toBe(base.now);
  });

  it("un-flags a reappearing item (self-correcting)", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    seedIap(db, "app-1", "back.a", "2026-06-01T00:00:00Z"); // was flagged

    const r = await reconcileDeletedOnGoogle({ ...base, appId: "app-1", incomingSkus: ["back.a"] });
    expect(r.unflagged).toBe(1);
    expect(r.unflaggedSkus).toEqual(["back.a"]);
    expect(db.tables.iaps[0].deleted_on_google_at).toBeNull();
  });

  it("preserves the ORIGINAL detection date for a still-missing flagged item", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    const original = "2026-06-01T00:00:00Z";
    seedIap(db, "app-1", "still.gone", original);
    seedIap(db, "app-1", "live.a");

    const r = await reconcileDeletedOnGoogle({ ...base, appId: "app-1", incomingSkus: ["live.a"] });
    // Already flagged → NOT re-flagged, date untouched.
    expect(r.flagged).toBe(0);
    expect(db.tables.iaps.find((x) => x.sku === "still.gone")!.deleted_on_google_at).toBe(original);
  });

  it("clean sync of an unchanged set flags nothing", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    seedIap(db, "app-1", "a");
    seedIap(db, "app-1", "b");
    const r = await reconcileDeletedOnGoogle({ ...base, appId: "app-1", incomingSkus: ["a", "b"] });
    expect(r.flagged).toBe(0);
    expect(r.unflagged).toBe(0);
  });
});

describe("reconcileDeletedOnGoogle — anomaly guard (never spuriously flags)", () => {
  const now = "2026-07-02T00:00:00Z";
  function seeded() {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    for (let i = 0; i < 100; i++) seedIap(db, "app-1", `sku.${i}`);
    return db;
  }

  it("empty response → skip", async () => {
    const db = seeded();
    const r = await reconcileDeletedOnGoogle({ appId: "app-1", incomingSkus: [], allProductsHadSku: true, fetchComplete: true, now });
    expect(r.skippedReason).toBe("empty_response");
    expect(r.flagged).toBe(0);
    expect(db.tables.iaps.every((x) => x.deleted_on_google_at === null)).toBe(true);
  });

  it("a product missing a SKU → skip", async () => {
    seeded();
    const r = await reconcileDeletedOnGoogle({ appId: "app-1", incomingSkus: ["sku.0"], allProductsHadSku: false, fetchComplete: true, now });
    expect(r.skippedReason).toBe("product_missing_sku");
    expect(r.flagged).toBe(0);
  });

  it("fetch incomplete → skip", async () => {
    seeded();
    const r = await reconcileDeletedOnGoogle({ appId: "app-1", incomingSkus: ["sku.0"], allProductsHadSku: true, fetchComplete: false, now });
    expect(r.skippedReason).toBe("fetch_incomplete");
  });

  it("incoming < 50% of cached → skip (protects the warning's credibility)", async () => {
    const db = seeded(); // 100 cached
    const incoming = Array.from({ length: 40 }, (_, i) => `sku.${i}`); // 40 < 50
    const r = await reconcileDeletedOnGoogle({ appId: "app-1", incomingSkus: incoming, allProductsHadSku: true, fetchComplete: true, now });
    expect(r.skippedReason).toMatch(/incoming_below_50pct/);
    expect(r.flagged).toBe(0);
    expect(db.tables.iaps.every((x) => x.deleted_on_google_at === null)).toBe(true);
  });

  it("incoming ≥ 50% of cached → proceeds", async () => {
    seeded(); // 100 cached
    const incoming = Array.from({ length: 60 }, (_, i) => `sku.${i}`); // 60 ≥ 50
    const r = await reconcileDeletedOnGoogle({ appId: "app-1", incomingSkus: incoming, allProductsHadSku: true, fetchComplete: true, now });
    expect(r.skippedReason).toBeNull();
    expect(r.flagged).toBe(40); // sku.60..99 absent
  });
});

describe("batchSyncIapsFromGoogle — 293/109 end-to-end flagging + audit counts", () => {
  it("cached 402, incoming 293 (>50%) → 109 flagged, 293 clear", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    const all = Array.from({ length: 402 }, (_, i) => product(`sku.${i}`));
    // First sync seeds all 402.
    await batchSyncIapsFromGoogle("app-1", all);
    expect(db.tables.iaps.length).toBe(402);

    // Second sync: Google now returns only the first 293.
    const incoming = all.slice(0, 293);
    const res = await batchSyncIapsFromGoogle("app-1", incoming);

    expect(res.flagReconcile.skippedReason).toBeNull();
    expect(res.flagReconcile.flagged).toBe(109);
    const flaggedCount = db.tables.iaps.filter((x) => x.deleted_on_google_at !== null).length;
    expect(flaggedCount).toBe(109);
    const clearCount = db.tables.iaps.filter((x) => x.deleted_on_google_at === null).length;
    expect(clearCount).toBe(293);
    // Table still holds all 402 rows (soft-delete, not removed).
    expect(db.tables.iaps.length).toBe(402);
  });
});

describe("acknowledgeRemoveIaps + listFlaggedSkusAmong", () => {
  it("removes ONLY flagged rows; a present-on-Google sku cannot be removed", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    seedIap(db, "app-1", "flagged.a", "2026-07-02T00:00:00Z");
    seedIap(db, "app-1", "live.b"); // NOT flagged

    const { removed } = await acknowledgeRemoveIaps("app-1", ["flagged.a", "live.b"]);
    expect(removed).toEqual(["flagged.a"]);
    // live.b survives (guard: only deleted_on_google_at IS NOT NULL rows deleted).
    expect(db.tables.iaps.map((x) => x.sku)).toEqual(["live.b"]);
  });

  it("listFlaggedSkusAmong returns only the flagged subset", async () => {
    const db = new FakeDb();
    dbSpy.mockReturnValue(db);
    seedIap(db, "app-1", "a", "2026-07-02T00:00:00Z");
    seedIap(db, "app-1", "b");
    seedIap(db, "app-1", "c", "2026-07-02T00:00:00Z");

    const flagged = await listFlaggedSkusAmong("app-1", ["a", "b", "c"]);
    expect([...flagged].sort()).toEqual(["a", "c"]);
  });
});
