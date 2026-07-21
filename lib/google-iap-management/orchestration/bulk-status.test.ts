import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks — same pattern as regions-helper.test.ts. The
// orchestrator imports `batchUpdateProductStates` + `resolveLivePurchaseOptions`
// from publisher-client, the db wrapper from ../db, plus appendAction from
// ../repository/actions-log. Mock all four so the orchestrator runs in
// isolation.
const { batchSpy, dbSpy, auditSpy, resolveSpy } = vi.hoisted(() => ({
  batchSpy: vi.fn(),
  dbSpy: vi.fn(),
  auditSpy: vi.fn(),
  resolveSpy: vi.fn(),
}));

vi.mock("../google/publisher-client", () => ({
  batchUpdateProductStates: batchSpy,
  resolveLivePurchaseOptions: resolveSpy,
}));
vi.mock("../db", () => ({
  googleIapDb: dbSpy,
}));
vi.mock("../repository/actions-log", () => ({
  appendAction: auditSpy,
}));

import { chunkArray, executeBulkStatus } from "./bulk-status";

/** Default resolve-live-purchase-option stub: every sku resolves to "buy"
 *  with no multi-option / fetch-failure edge cases. Tests that need to
 *  exercise the RMW resolution (legacy id, per-sku failure isolation,
 *  multi-active warning) override via `resolveSpy.mockImplementation`. */
function defaultResolveImpl(
  _jwt: unknown,
  _packageName: string,
  productIds: readonly string[],
) {
  const map = new Map();
  for (const id of productIds) {
    map.set(id, {
      purchaseOptionId: "buy",
      hasMultipleActiveOptions: false,
      rawOptions: null,
      fetchFailed: false,
    });
  }
  return Promise.resolve(map);
}

// Builder supports BOTH the flagged pre-check (select→eq→not→in, resolves to
// {data:[]} = no flagged) and the cache write (update→eq→in, resolves to
// updateResult). Mode is tracked per chain so `.in()` returns the right shape.
function makeBuilder(updateResult: { error: unknown }) {
  const b: Record<string, unknown> = {};
  let mode: "select" | "update" | null = null;
  b.select = vi.fn(() => {
    mode = "select";
    return b;
  });
  b.update = vi.fn(() => {
    mode = "update";
    return b;
  });
  b.eq = vi.fn(() => b);
  b.not = vi.fn(() => b);
  b.in = vi.fn(() =>
    Promise.resolve(mode === "select" ? { data: [], error: null } : updateResult),
  );
  return b;
}

function fakeDbWithUpdate() {
  const b = makeBuilder({ error: null });
  return {
    from: vi.fn().mockReturnValue(b),
    _update: b.update,
    _eq: b.eq,
    _in: b.in,
  };
}

beforeEach(() => {
  batchSpy.mockReset();
  dbSpy.mockReset();
  auditSpy.mockReset();
  auditSpy.mockResolvedValue(undefined);
  resolveSpy.mockReset();
  resolveSpy.mockImplementation(defaultResolveImpl);
});

describe("chunkArray", () => {
  it("returns empty for empty input", () => {
    expect(chunkArray([], 100)).toEqual([]);
  });

  it("returns one chunk when input ≤ size", () => {
    expect(chunkArray([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });

  it("splits at boundary 100", () => {
    const arr = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkArray(arr, 100);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(100);
    expect(chunks[1].length).toBe(100);
    expect(chunks[2].length).toBe(50);
  });

  it("preserves order across chunks", () => {
    const chunks = chunkArray([1, 2, 3, 4, 5], 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("throws when size < 1", () => {
    expect(() => chunkArray([1], 0)).toThrow(/size/);
  });
});

describe("executeBulkStatus", () => {
  it("returns NO_OP without calling Google when skus empty", async () => {
    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: [],
      action: "activate",
      actorEmail: null,
    });
    expect(out.overall).toBe("NO_OP");
    expect(out.total).toBe(0);
    expect(out.batches).toBe(0);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("activates one chunk — all success path", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValueOnce(undefined);

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["sku.a", "sku.b"],
      action: "activate",
      actorEmail: "minhgv@vng.com.vn",
    });

    expect(out.overall).toBe("SUCCESS");
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(0);
    expect(out.batches).toBe(1);
    expect(out.results.map((r) => r.sku)).toEqual(["sku.a", "sku.b"]);
    expect(out.results.every((r) => r.ok)).toBe(true);

    // Google call shape
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const [, packageName, requests] = batchSpy.mock.calls[0];
    expect(packageName).toBe("com.example.app");
    expect(requests).toEqual([
      { productId: "sku.a", purchaseOptionId: "buy", state: "ACTIVATE" },
      { productId: "sku.b", purchaseOptionId: "buy", state: "ACTIVATE" },
    ]);

    // Cache update fired with active
    expect(db._update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );

    // Audit log captured
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [auditArg] = auditSpy.mock.calls[0];
    expect(auditArg.actionType).toBe("BULK_ACTIVATE");
    expect(auditArg.targetId).toBe("app-1");
    expect(auditArg.payload.succeeded).toBe(2);
  });

  it("deactivates uses DEACTIVATE verb + inactive cache status + BULK_DEACTIVATE audit", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValueOnce(undefined);

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["sku.x"],
      action: "deactivate",
      actorEmail: null,
    });

    expect(out.overall).toBe("SUCCESS");
    const [, , requests] = batchSpy.mock.calls[0];
    expect(requests[0].state).toBe("DEACTIVATE");
    expect(db._update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "inactive" }),
    );
    expect(auditSpy.mock.calls[0][0].actionType).toBe("BULK_DEACTIVATE");
  });

  it("chunks at the default 100 boundary — 250 items = 3 batches", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValue(undefined);

    const skus = Array.from({ length: 250 }, (_, i) => `sku.${i}`);
    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus,
      action: "activate",
      actorEmail: null,
    });

    expect(out.batches).toBe(3);
    expect(batchSpy).toHaveBeenCalledTimes(3);
    expect(out.succeeded).toBe(250);
    expect(out.overall).toBe("SUCCESS");

    // Sequential — first call has 100, second 100, third 50
    expect(batchSpy.mock.calls[0][2].length).toBe(100);
    expect(batchSpy.mock.calls[1][2].length).toBe(100);
    expect(batchSpy.mock.calls[2][2].length).toBe(50);
  });

  it("chunkSize override works for testing smaller batches", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValue(undefined);

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["a", "b", "c", "d", "e"],
      action: "activate",
      actorEmail: null,
      chunkSize: 2,
    });

    expect(out.batches).toBe(3);
    expect(batchSpy).toHaveBeenCalledTimes(3);
  });

  it("partial failure: middle chunk fails, sibling chunks still succeed", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Google 500: internal error"))
      .mockResolvedValueOnce(undefined);

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["a1", "a2", "b1", "b2", "c1", "c2"],
      action: "activate",
      actorEmail: null,
      chunkSize: 2,
    });

    expect(out.overall).toBe("PARTIAL");
    expect(out.batches).toBe(3);
    expect(out.succeeded).toBe(4);
    expect(out.failed).toBe(2);

    const failed = out.results.filter((r) => !r.ok);
    expect(failed.map((r) => r.sku)).toEqual(["b1", "b2"]);
    expect(failed.every((r) => r.error?.includes("Google 500"))).toBe(true);

    const succeeded = out.results.filter((r) => r.ok);
    expect(succeeded.map((r) => r.sku)).toEqual(["a1", "a2", "c1", "c2"]);
  });

  it("excludes flagged (deleted-on-Google) skus from the push; surfaces them blocked", async () => {
    // Builder whose flagged pre-check (select) reports "gone" as flagged.
    const b: Record<string, unknown> = {};
    let mode: "select" | "update" | null = null;
    b.select = vi.fn(() => {
      mode = "select";
      return b;
    });
    b.update = vi.fn(() => {
      mode = "update";
      return b;
    });
    b.eq = vi.fn(() => b);
    b.not = vi.fn(() => b);
    b.in = vi.fn(() =>
      Promise.resolve(
        mode === "select" ? { data: [{ sku: "gone" }], error: null } : { error: null },
      ),
    );
    dbSpy.mockReturnValue({ from: vi.fn(() => b) });
    batchSpy.mockResolvedValueOnce(undefined);

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["ok", "gone"],
      action: "activate",
      actorEmail: null,
    });

    // Only the non-flagged sku was pushed to Google.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0][2].map((r: { productId: string }) => r.productId)).toEqual(["ok"]);
    // "gone" surfaces as a blocked failure with the deleted-on-Google reason.
    const gone = out.results.find((r) => r.sku === "gone");
    expect(gone?.ok).toBe(false);
    expect(gone?.error).toMatch(/deleted on Google/i);
    const ok = out.results.find((r) => r.sku === "ok");
    expect(ok?.ok).toBe(true);
    expect(out.overall).toBe("PARTIAL");
  });

  it("total failure: every chunk fails → overall=FAILURE", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockRejectedValue(new Error("auth expired"));

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["x", "y"],
      action: "deactivate",
      actorEmail: null,
    });

    expect(out.overall).toBe("FAILURE");
    expect(out.succeeded).toBe(0);
    expect(out.failed).toBe(2);
  });

  it("cache update DB failure is swallowed (non-fatal) — result still SUCCESS", async () => {
    // Flagged pre-check succeeds (select→{data:[]}); the cache update fails.
    const failingDb = {
      from: vi.fn().mockReturnValue(makeBuilder({ error: { message: "db down" } })),
    };
    dbSpy.mockReturnValue(failingDb);
    batchSpy.mockResolvedValueOnce(undefined);

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["sku.k"],
      action: "activate",
      actorEmail: null,
    });

    expect(out.overall).toBe("SUCCESS");
    expect(out.results[0].ok).toBe(true);
  });

  // ── Hotfix 30 gauntlet: live purchase-option resolution ──────────────

  it("resolves the REAL live purchase-option id per product — legacy-migrated sku uses 'legacy-base', not the hardcoded 'buy' default", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValueOnce(undefined);
    resolveSpy.mockImplementation((_jwt: unknown, _pkg: string, productIds: readonly string[]) => {
      const map = new Map();
      for (const id of productIds) {
        map.set(id, {
          purchaseOptionId: id === "vn.vng.uprace.pro" ? "legacy-base" : "buy",
          hasMultipleActiveOptions: false,
          rawOptions: null,
          fetchFailed: false,
        });
      }
      return Promise.resolve(map);
    });

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "vn.vng.uprace",
      skus: ["vn.vng.uprace.pro", "vn.vng.uprace.other"],
      action: "deactivate",
      actorEmail: null,
    });

    expect(out.overall).toBe("SUCCESS");
    const [, , requests] = batchSpy.mock.calls[0];
    expect(requests).toEqual([
      { productId: "vn.vng.uprace.pro", purchaseOptionId: "legacy-base", state: "DEACTIVATE" },
      { productId: "vn.vng.uprace.other", purchaseOptionId: "buy", state: "DEACTIVATE" },
    ]);
  });

  it("full-set-deferred: a product with 2+ active purchase options is explicitly surfaced via a warning, not silently under-deactivated", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValueOnce(undefined);
    resolveSpy.mockImplementation((_jwt: unknown, _pkg: string, productIds: readonly string[]) => {
      const map = new Map();
      for (const id of productIds) {
        map.set(id, {
          purchaseOptionId: "legacy-base",
          hasMultipleActiveOptions: id === "multi.option.sku",
          rawOptions: null,
          fetchFailed: false,
        });
      }
      return Promise.resolve(map);
    });

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["multi.option.sku", "single.option.sku"],
      action: "deactivate",
      actorEmail: null,
    });

    expect(out.overall).toBe("SUCCESS"); // warning is non-blocking, not a failure
    const multi = out.results.find((r) => r.sku === "multi.option.sku");
    expect(multi?.ok).toBe(true);
    expect(multi?.warning).toMatch(/multiple active purchase options/i);
    const single = out.results.find((r) => r.sku === "single.option.sku");
    expect(single?.ok).toBe(true);
    expect(single?.warning).toBeUndefined();
  });

  it("per-sku failure isolation: one product's live-resolve fails, siblings still process and the batch is not aborted", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValueOnce(undefined);
    resolveSpy.mockImplementation((_jwt: unknown, _pkg: string, productIds: readonly string[]) => {
      const map = new Map();
      for (const id of productIds) {
        if (id === "broken.sku") {
          map.set(id, {
            purchaseOptionId: null,
            hasMultipleActiveOptions: false,
            rawOptions: null,
            fetchFailed: true,
          });
        } else {
          map.set(id, {
            purchaseOptionId: "buy",
            hasMultipleActiveOptions: false,
            rawOptions: null,
            fetchFailed: false,
          });
        }
      }
      return Promise.resolve(map);
    });

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["ok.a", "broken.sku", "ok.b"],
      action: "activate",
      actorEmail: null,
    });

    // The batch POST only ever saw the resolvable skus.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(
      batchSpy.mock.calls[0][2].map((r: { productId: string }) => r.productId),
    ).toEqual(["ok.a", "ok.b"]);

    const broken = out.results.find((r) => r.sku === "broken.sku");
    expect(broken?.ok).toBe(false);
    expect(broken?.error).toMatch(/resolve live purchase option/i);

    const ok = out.results.filter((r) => r.sku !== "broken.sku");
    expect(ok.every((r) => r.ok)).toBe(true);
    expect(out.overall).toBe("PARTIAL");
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(1);
  });

  it("the hardcoded 'buy' fallback no longer fires unconditionally — request purchaseOptionId always comes from the resolver", async () => {
    const db = fakeDbWithUpdate();
    dbSpy.mockReturnValue(db);
    batchSpy.mockResolvedValueOnce(undefined);
    resolveSpy.mockImplementation((_jwt: unknown, _pkg: string, productIds: readonly string[]) => {
      const map = new Map();
      for (const id of productIds) {
        map.set(id, {
          purchaseOptionId: "custom-option-id",
          hasMultipleActiveOptions: false,
          rawOptions: null,
          fetchFailed: false,
        });
      }
      return Promise.resolve(map);
    });

    const out = await executeBulkStatus({
      jwt: {} as never,
      appId: "app-1",
      packageName: "com.example.app",
      skus: ["sku.z"],
      action: "activate",
      actorEmail: null,
    });

    expect(out.overall).toBe("SUCCESS");
    expect(batchSpy.mock.calls[0][2][0].purchaseOptionId).toBe("custom-option-id");
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(),
      "com.example.app",
      ["sku.z"],
      expect.any(Number),
    );
  });
});
