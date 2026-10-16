/**
 * D0 + D9 [arc-google-missing-purchase-options] — reads/writes behind the
 * bulk-import gate. Every function THROWS on anything that is not a clean
 * answer: a read error must never come back as "never synced", "not
 * declared" or any default, and a write that touched 0 rows must never look
 * like a success (KB §9 P2: an uninspected write fails silently).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbSpy = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb: dbSpy }));

import {
  AppDefaultChangedError,
  declareAppDefault,
  getAppImportReadiness,
  markIapsMirrorSynced,
} from "./apps";

interface Recorded {
  table?: string;
  select?: string;
  update?: Record<string, unknown>;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
}

/** Minimal PostgREST-shaped builder: records the call, resolves `result`. */
function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const rec: Recorded = { eq: [], is: [] };
  const builder = {
    select(cols: string) {
      rec.select = cols;
      return builder;
    },
    update(patch: Record<string, unknown>) {
      rec.update = patch;
      return builder;
    },
    eq(col: string, val: unknown) {
      rec.eq.push([col, val]);
      return builder;
    },
    is(col: string, val: unknown) {
      rec.is.push([col, val]);
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(result).then(resolve);
    },
  };
  dbSpy.mockReturnValue({
    from(table: string) {
      rec.table = table;
      return builder;
    },
  });
  return rec;
}

beforeEach(() => dbSpy.mockReset());

const ROW = {
  iaps_last_synced_at: "2026-10-16T03:25:10Z",
  default_currency: "USD",
  default_currency_source: "guessed",
  default_language: "en-US",
  default_language_source: "declared",
};

describe("getAppImportReadiness", () => {
  it("returns the sync stamp and BOTH defaults with their provenance, for the requested row", async () => {
    const rec = fakeDb({ data: ROW, error: null });
    await expect(getAppImportReadiness("app-1")).resolves.toEqual({
      iapsLastSyncedAt: "2026-10-16T03:25:10Z",
      defaults: {
        currency: { value: "USD", source: "guessed" },
        language: { value: "en-US", source: "declared" },
      },
    });
    expect(rec.table).toBe("apps");
    expect(rec.select).toContain("default_currency_source");
    expect(rec.select).toContain("default_language_source");
    expect(rec.select).toContain("iaps_last_synced_at");
    expect(rec.eq).toEqual([["id", "app-1"]]);
  });

  it("NULL columns ⇒ never synced, nothing set", async () => {
    fakeDb({
      data: {
        iaps_last_synced_at: null,
        default_currency: null,
        default_currency_source: null,
        default_language: null,
        default_language_source: null,
      },
      error: null,
    });
    await expect(getAppImportReadiness("app-1")).resolves.toEqual({
      iapsLastSyncedAt: null,
      defaults: { currency: { value: null, source: null }, language: { value: null, source: null } },
    });
  });

  it("an unknown provenance string reads as null (⇒ not declared), never as declared", async () => {
    fakeDb({ data: { ...ROW, default_currency_source: "DECLARED " }, error: null });
    const r = await getAppImportReadiness("app-1");
    expect(r.defaults.currency.source).toBeNull();
  });

  it("DB error ⇒ THROWS ('could not read' ≠ 'never synced' / 'not declared')", async () => {
    fakeDb({ data: null, error: { message: "column apps.default_currency_source does not exist" } });
    await expect(getAppImportReadiness("app-1")).rejects.toThrow(/does not exist/);
  });

  it("app row missing ⇒ THROWS", async () => {
    fakeDb({ data: null, error: null });
    await expect(getAppImportReadiness("app-x")).rejects.toThrow(/not found/);
  });
});

describe("declareAppDefault — the only writer of the app's currency/language", () => {
  const GUESSED_USD = { value: "USD", source: "guessed" as const };

  it("currency: writes the value AND source='declared' on the requested row, nothing else", async () => {
    const rec = fakeDb({ data: [{ id: "app-1" }], error: null });
    await declareAppDefault("app-1", "currency", "USD", GUESSED_USD);
    expect(rec.update).toEqual({ default_currency: "USD", default_currency_source: "declared" });
    expect(rec.eq[0]).toEqual(["id", "app-1"]);
    expect(rec.select).toBe("id");
  });

  it("compare-and-set: the write is filtered on the value + source the Manager saw", async () => {
    const rec = fakeDb({ data: [{ id: "app-1" }], error: null });
    await declareAppDefault("app-1", "currency", "TWD", GUESSED_USD);
    expect(rec.eq).toEqual([
      ["id", "app-1"],
      ["default_currency", "USD"],
      ["default_currency_source", "guessed"],
    ]);
  });

  it("compare-and-set on an EMPTY value filters with IS NULL (= NULL matches nothing in SQL)", async () => {
    const rec = fakeDb({ data: [{ id: "app-1" }], error: null });
    await declareAppDefault("app-1", "language", "zh-TW", { value: null, source: null });
    expect(rec.update).toEqual({ default_language: "zh-TW", default_language_source: "declared" });
    expect(rec.is).toEqual([
      ["default_language", null],
      ["default_language_source", null],
    ]);
  });

  it("0 rows written ⇒ AppDefaultChangedError (changed since read) — never a silent success", async () => {
    fakeDb({ data: [], error: null });
    const p = declareAppDefault("app-1", "currency", "USD", GUESSED_USD);
    await expect(p).rejects.toBeInstanceOf(AppDefaultChangedError);
    await expect(declareAppDefault("app-1", "currency", "USD", GUESSED_USD)).rejects.toThrow(
      /changed since it was read/,
    );
  });

  it("2 rows written ⇒ THROWS", async () => {
    fakeDb({ data: [{ id: "a" }, { id: "b" }], error: null });
    await expect(declareAppDefault("app-1", "currency", "USD", GUESSED_USD)).rejects.toThrow(
      /expected 1 app row updated, got 2/,
    );
  });

  it("DB error ⇒ THROWS", async () => {
    fakeDb({ data: null, error: { message: "violates check constraint" } });
    await expect(declareAppDefault("app-1", "currency", "USD", GUESSED_USD)).rejects.toThrow(
      /check constraint/,
    );
  });
});

describe("markIapsMirrorSynced", () => {
  it("writes ONLY iaps_last_synced_at on the requested row and asks for the written rows back", async () => {
    const rec = fakeDb({ data: [{ id: "app-1" }], error: null });
    await expect(markIapsMirrorSynced("app-1", "2026-10-16T03:25:10Z")).resolves.toBeUndefined();
    expect(rec.update).toEqual({ iaps_last_synced_at: "2026-10-16T03:25:10Z" });
    expect(rec.eq).toEqual([["id", "app-1"]]);
    expect(rec.select).toBe("id");
  });

  it("0 rows written ⇒ THROWS (silent no-op write is the P2 trap)", async () => {
    fakeDb({ data: [], error: null });
    await expect(markIapsMirrorSynced("app-1", "t")).rejects.toThrow(/expected 1 app row updated, got 0/);
  });

  it("DB error ⇒ THROWS", async () => {
    fakeDb({ data: null, error: { message: "permission denied" } });
    await expect(markIapsMirrorSynced("app-1", "t")).rejects.toThrow(/permission denied/);
  });
});
