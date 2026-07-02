/**
 * listIapsWithDefaultLocale — the per-app list read that returned EMPTY at
 * ~293 items. supabase-js does not chunk `.in()`, so the un-chunked listings
 * read produced an oversized URI that the gateway rejected → the code threw
 * → page.tsx swallowed it into []. These tests lock the fix:
 *   - the `.in()` is id-chunked (≤ ID_IN_CHUNK) so a 293/500-id read never
 *     exceeds the URI cap, and the merged result is complete;
 *   - each chunk is range-paginated so >1000 listing rows are not truncated;
 *   - a genuine read error still THROWS (so the page can show an error state
 *     rather than a misleading empty list);
 *   - a small (<100-id) app still works, single-chunk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbSpy } = vi.hoisted(() => ({ dbSpy: vi.fn() }));
vi.mock("../db", () => ({ googleIapDb: dbSpy }));
vi.mock("./apps", () => ({ updateAppDefaults: vi.fn() }));

import { listIapsWithDefaultLocale } from "./iaps";

type IapRow = { id: string; app_id: string; sku: string };
type ListingRow = { iap_id: string; locale: string; title: string };

/** Fake modelling the gateway URI cap + PostgREST 1000-row default. */
class ReadFakeDb {
  iaps: IapRow[] = [];
  listings: ListingRow[] = [];
  /** `.in()` with more ids than this simulates the gateway 414 (URI too long). */
  uriIdCap = Infinity;
  /** Force every listings read to error (simulate a hard load failure). */
  forceListingsError = false;
  /** Recorded listings `.in()` calls, for asserting chunk/page behaviour. */
  inCalls: Array<{ ids: string[]; from: number; to: number }> = [];

  from(table: string) {
    return new ReadBuilder(this, table);
  }
}

class ReadBuilder {
  private inIds: string[] = [];
  private rangeFrom = 0;
  private rangeTo = Number.MAX_SAFE_INTEGER;
  private appId: string | null = null;

  constructor(private db: ReadFakeDb, private table: string) {}
  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(col: string, val: string) {
    if (col === "app_id") this.appId = val;
    return this;
  }
  in(_col: string, ids: string[]) {
    this.inIds = ids;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  then<R>(resolve: (v: { data: unknown; error: { message: string } | null }) => R) {
    return Promise.resolve(this.exec()).then(resolve);
  }

  private exec(): { data: unknown; error: { message: string } | null } {
    if (this.table === "iaps") {
      const data = this.db.iaps.filter((r) => r.app_id === this.appId);
      return { data, error: null };
    }
    // iap_listings
    this.db.inCalls.push({ ids: this.inIds, from: this.rangeFrom, to: this.rangeTo });
    if (this.db.forceListingsError) {
      return { data: null, error: { message: "simulated hard failure" } };
    }
    if (this.inIds.length > this.db.uriIdCap) {
      return { data: null, error: { message: "414 Request-URI Too Large" } };
    }
    const matching = this.db.listings.filter((l) => this.inIds.includes(l.iap_id));
    const window = matching.slice(this.rangeFrom, this.rangeTo + 1);
    return { data: window, error: null };
  }
}

function makeApp(db: ReadFakeDb, appId: string, count: number, localesPerIap = 1) {
  for (let i = 0; i < count; i++) {
    const id = `iap-${i}`;
    db.iaps.push({ id, app_id: appId, sku: `sku.${i}` });
    for (let l = 0; l < localesPerIap; l++) {
      const locale = l === 0 ? "en-US" : `loc-${l}`;
      db.listings.push({ iap_id: id, locale, title: `${id}:${locale}` });
    }
  }
}

beforeEach(() => dbSpy.mockReset());

describe("listIapsWithDefaultLocale — id-chunked listings read", () => {
  it("293 items: chunks the .in() so it never exceeds the URI cap; result complete", async () => {
    const db = new ReadFakeDb();
    makeApp(db, "app-1", 293);
    db.uriIdCap = 210; // un-chunked (293) would 414; chunked (≤200) must not.
    dbSpy.mockReturnValue(db);

    const iaps = await listIapsWithDefaultLocale("app-1");

    expect(iaps.length).toBe(293);
    expect(iaps.every((i) => i.default_title !== null)).toBe(true);
    // Every listings request stayed within the chunk size.
    expect(db.inCalls.every((c) => c.ids.length <= 200)).toBe(true);
    // 293 → 2 chunks of ≤200.
    const chunkSizes = db.inCalls.map((c) => c.ids.length);
    expect(chunkSizes).toEqual([200, 93]);
  });

  it("500 items: 3 chunks, all listings merged", async () => {
    const db = new ReadFakeDb();
    makeApp(db, "app-1", 500);
    db.uriIdCap = 210;
    dbSpy.mockReturnValue(db);

    const iaps = await listIapsWithDefaultLocale("app-1");
    expect(iaps.length).toBe(500);
    expect(iaps.every((i) => i.default_title !== null)).toBe(true);
    expect(db.inCalls.filter((c) => c.from === 0).length).toBe(3); // 3 chunks
  });

  it(">1000 listing rows in a chunk are range-paginated (no 1000-row truncation)", async () => {
    const db = new ReadFakeDb();
    // 50 items × 30 locales = 1500 listing rows — one id-chunk, >1000 rows.
    makeApp(db, "app-1", 50, 30);
    dbSpy.mockReturnValue(db);

    const iaps = await listIapsWithDefaultLocale("app-1");
    expect(iaps.length).toBe(50);
    // All 50 resolve en-US titles — including items whose rows sit past row
    // 1000, which a single un-paginated read would have dropped.
    expect(iaps.every((i) => i.default_title?.endsWith(":en-US"))).toBe(true);
    // Pagination happened: a second page (from=1000) was requested.
    expect(db.inCalls.some((c) => c.from === 1000)).toBe(true);
  });

  it("small (<100) app works unchanged in a single chunk", async () => {
    const db = new ReadFakeDb();
    makeApp(db, "app-1", 80);
    db.uriIdCap = 210;
    dbSpy.mockReturnValue(db);

    const iaps = await listIapsWithDefaultLocale("app-1");
    expect(iaps.length).toBe(80);
    // Single id-chunk, single page.
    expect(db.inCalls.length).toBe(1);
    expect(db.inCalls[0].ids.length).toBe(80);
  });

  it("empty app returns [] without any listings read", async () => {
    const db = new ReadFakeDb();
    dbSpy.mockReturnValue(db);
    const iaps = await listIapsWithDefaultLocale("app-1");
    expect(iaps).toEqual([]);
    expect(db.inCalls.length).toBe(0);
  });

  it("a genuine listings read error THROWS (so the page can show an error state)", async () => {
    const db = new ReadFakeDb();
    makeApp(db, "app-1", 10);
    db.forceListingsError = true;
    dbSpy.mockReturnValue(db);

    await expect(listIapsWithDefaultLocale("app-1")).rejects.toThrow(/Failed to load IAP listings/);
  });
});
