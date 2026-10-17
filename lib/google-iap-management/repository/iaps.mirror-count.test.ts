/**
 * C2.1a — countLiveMirrorItems: the ONE definition of "the mirror holds items"
 * (rows of THIS app not flagged deleted-on-Google), shared with the one-time
 * backfill 20261016020000. It must never read an error as 0 — an empty answer
 * from Google would then be stamped as a complete refresh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbSpy = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb: dbSpy }));

import { countLiveMirrorItems } from "./iaps";

interface Recorded {
  table?: string;
  select?: [string, unknown];
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
}

function fakeDb(result: { count: number | null; error: { message: string } | null }) {
  const rec: Recorded = { eq: [], is: [] };
  const builder = {
    select(cols: string, opts: unknown) {
      rec.select = [cols, opts];
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
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve({ data: null, ...result }).then(resolve);
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

describe("countLiveMirrorItems", () => {
  it("counts THIS app's rows NOT flagged deleted-on-Google (head-only exact count)", async () => {
    const rec = fakeDb({ count: 16, error: null });
    await expect(countLiveMirrorItems("app-1")).resolves.toBe(16);
    expect(rec.table).toBe("iaps");
    expect(rec.select).toEqual(["id", { count: "exact", head: true }]);
    expect(rec.eq).toEqual([["app_id", "app-1"]]);
    expect(rec.is).toEqual([["deleted_on_google_at", null]]);
  });

  it("0 is a real answer (empty mirror)", async () => {
    fakeDb({ count: 0, error: null });
    await expect(countLiveMirrorItems("app-1")).resolves.toBe(0);
  });

  it("DB error ⇒ THROWS — never 0", async () => {
    fakeDb({ count: null, error: { message: "timeout" } });
    await expect(countLiveMirrorItems("app-1")).rejects.toThrow(/timeout/);
  });

  it("no count returned ⇒ THROWS — never 0", async () => {
    fakeDb({ count: null, error: null });
    await expect(countLiveMirrorItems("app-1")).rejects.toThrow(/no count returned/);
  });
});
