/**
 * D0 [arc-google-missing-purchase-options] — read/write of
 * apps.iaps_last_synced_at. Both functions THROW on anything that is not a
 * clean answer: a read error must never come back as "never synced" (or as
 * any other default), and a stamp that wrote 0 rows must never look like a
 * success (KB §9 P2: an uninspected write fails silently).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbSpy = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb: dbSpy }));

import { getIapsMirrorSyncedAt, markIapsMirrorSynced } from "./apps";

interface Recorded {
  table?: string;
  select?: string;
  update?: Record<string, unknown>;
  eq: Array<[string, unknown]>;
}

/** Minimal PostgREST-shaped builder: records the call, resolves `result`. */
function fakeDb(result: { data: unknown; error: { message: string } | null }) {
  const rec: Recorded = { eq: [] };
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

describe("getIapsMirrorSyncedAt", () => {
  it("returns the stamp of the requested app row", async () => {
    const rec = fakeDb({ data: { iaps_last_synced_at: "2026-10-16T03:25:10Z" }, error: null });
    await expect(getIapsMirrorSyncedAt("app-1")).resolves.toBe("2026-10-16T03:25:10Z");
    expect(rec.table).toBe("apps");
    expect(rec.select).toBe("iaps_last_synced_at");
    expect(rec.eq).toEqual([["id", "app-1"]]);
  });

  it("NULL column ⇒ null (never synced)", async () => {
    fakeDb({ data: { iaps_last_synced_at: null }, error: null });
    await expect(getIapsMirrorSyncedAt("app-1")).resolves.toBeNull();
  });

  it("DB error ⇒ THROWS (not null: 'could not read' ≠ 'never synced')", async () => {
    fakeDb({ data: null, error: { message: "column apps.iaps_last_synced_at does not exist" } });
    await expect(getIapsMirrorSyncedAt("app-1")).rejects.toThrow(/does not exist/);
  });

  it("app row missing ⇒ THROWS", async () => {
    fakeDb({ data: null, error: null });
    await expect(getIapsMirrorSyncedAt("app-x")).rejects.toThrow(/not found/);
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
