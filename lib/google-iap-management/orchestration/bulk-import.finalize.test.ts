/**
 * H4.4 — KB P10 finalize-in-finally (Manager 2026-10-19): an import_batches
 * row ALWAYS ends in a terminal state, even when the batch throws a DB /
 * network / logic error after the row was inserted. Before H4.4 every such
 * throw (template lookups, a drifted tier, more than 100 rows…) left it
 * IN_PROGRESS for good. Also KB P2: a close whose write fails is logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const batchUpsertInAppProducts = vi.hoisted(() => vi.fn());
vi.mock("../google/publisher-client", () => ({ batchUpsertInAppProducts }));
const buildRegionMapFromBasePrice = vi.hoisted(() => vi.fn());
vi.mock("../google/regions-helper", () => ({ buildRegionMapFromBasePrice }));
vi.mock("../repository/iaps", () => ({ syncIapFromGoogle: vi.fn(async () => undefined) }));
const appendAction = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../repository/actions-log", () => ({ appendAction }));

const templateExists = vi.hoisted(() => vi.fn());
const lookupTemplateEntriesForIdentifier = vi.hoisted(() => vi.fn());
vi.mock("../queries/templates", () => ({
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice: vi.fn(async () => []),
  templateExists,
  findTemplateId: vi.fn(async () => "tpl-1"),
}));

const updates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const updateError = vi.hoisted(() => ({ value: null as { message: string } | null }));
const googleIapDb = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb }));

import { executeBulkImport, type BulkImportRow } from "./bulk-import";

function makeDb() {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: async () => ({ error: updateError.value }) };
      },
    }),
  };
}

const row = (n: number, over: Partial<BulkImportRow> = {}): BulkImportRow =>
  ({
    rowNumber: n,
    sku: `gem.${n}`,
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    regionOverrides: [],
    listings: [{ locale: "en-US", title: "Gem", description: "d" }],
    decision: "create",
    ...over,
  }) as BulkImportRow;

const INPUT = {
  appId: "app-1",
  accountId: "acct-1",
  packageName: "com.vng.finalize",
  sourceFilename: "x.xlsx",
  actorEmail: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  updateError.value = null;
  googleIapDb.mockReturnValue(makeDb());
  templateExists.mockResolvedValue(true);
  buildRegionMapFromBasePrice.mockResolvedValue({
    regions: [{ region: "US", currency: "USD", priceMicros: "990000" }],
    regionsVersion: "2025/03",
  });
  batchUpsertInAppProducts.mockImplementation(async (_j, _p, inputs) =>
    inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
  );
});

describe("H4.4 — import_batches always ends in a terminal state (finalize-in-finally)", () => {
  it("a DB error in a template lookup ⇒ the error still reaches the caller, AND the batch is closed FAILED (rows_failed = rows not skipped)", async () => {
    templateExists.mockRejectedValue(new Error("db timeout"));
    await expect(
      executeBulkImport({} as never, {
        ...INPUT,
        pricingSource: "default_template",
        rows: [row(2), row(3), row(4, { decision: "skip" })],
        droppedRows: [
          { rowNumber: 5, sku: "d", reason: "x." },
          { rowNumber: 6, sku: "e", reason: "y." },
        ],
      }),
    ).rejects.toThrow("db timeout");
    // 2 actionable + 2 dropped (the rows of the file not skipped), not 3 input rows.
    expect(updates).toEqual([
      expect.objectContaining({ status: "FAILED", rows_success: 0, rows_skipped: 1, rows_failed: 4 }),
    ]);
  });

  it("a batch closed by the finally still gets its audit row — the rule, the header and the CAUSE — and the log names the cause", async () => {
    templateExists.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      executeBulkImport({} as never, { ...INPUT, pricingSource: "default_template", priceHeader: "Price (VND)", rows: [row(2)] }),
    ).rejects.toThrow(/statement timeout/);
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => /closing it FAILED \(finally\) err=".*statement timeout/.test(l))).toBe(true);
    const payload = (appendAction.mock.calls.at(-1) as unknown as [{ payload: Record<string, unknown> }])[0].payload;
    expect(payload).toMatchObject({
      batch_id: "batch-1",
      pricing_rule: "file-currency-only/v1",
      price_header: "Price (VND)",
      closed_by: "finally",
      rows_failed: 1,
    });
    expect(String(payload.error)).toMatch(/statement timeout/);
    spy.mockRestore();
  });

  it("the nothing-to-push exit is closed exactly ONCE", async () => {
    await executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row(2, { basePriceDecimal: "0" })] });
    expect(updates).toEqual([expect.objectContaining({ status: "FAILED", rows_failed: 1 })]);
  });

  it("a close write that THROWS is logged and swallowed — the batch result still returns, and the finally does not write again", async () => {
    googleIapDb.mockReturnValue({
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          throw new Error("socket closed");
        },
      }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row(2)] });
    expect(res.rowsCreated).toBe(1);
    expect(updates).toHaveLength(1);
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("import_batches close THREW batch=batch-1"))).toBe(true);
    spy.mockRestore();
  });

  it("a drifted tier (chosen tier has no entries) ⇒ closed FAILED", async () => {
    lookupTemplateEntriesForIdentifier.mockResolvedValue([]);
    await expect(
      executeBulkImport({} as never, {
        ...INPUT,
        pricingSource: "default_template",
        rows: [row(2, { chosenTierIdentifier: "gone", tierCandidateCount: 1 })],
      }),
    ).rejects.toThrow(/has no entries/);
    expect(updates).toEqual([expect.objectContaining({ status: "FAILED" })]);
  });

  it("more than 100 rows ⇒ closed FAILED", async () => {
    await expect(
      executeBulkImport({} as never, {
        ...INPUT,
        pricingSource: "google_default",
        rows: Array.from({ length: 101 }, (_, i) => row(i + 2)),
      }),
    ).rejects.toThrow(/per-call cap/);
    expect(updates).toEqual([expect.objectContaining({ status: "FAILED", rows_failed: 101 })]);
  });

  it("a clean batch is closed exactly ONCE (COMPLETE) — the finally never adds a second, FAILED write", async () => {
    await executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row(2)] });
    expect(updates).toEqual([expect.objectContaining({ status: "COMPLETE", rows_success: 1 })]);
  });

  it("a Google error on the push ⇒ closed FAILED once by the push's own catch (not twice)", async () => {
    batchUpsertInAppProducts.mockRejectedValue(Object.assign(new Error("boom"), { code: 500 }));
    await expect(
      executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row(2)] }),
    ).rejects.toThrow("boom");
    expect(updates).toEqual([expect.objectContaining({ status: "FAILED", rows_failed: 1 })]);
  });

  it("KB P2: a close whose write is REFUSED is logged, not silent", async () => {
    updateError.value = { message: 'new row violates check constraint "import_batches_status_check"' };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row(2)] });
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("import_batches close FAILED batch=batch-1 status=COMPLETE"))).toBe(true);
    // An ATTEMPTED close counts: the finally must not overwrite the real
    // outcome (COMPLETE) with FAILED because the write was refused.
    expect(updates).toHaveLength(1);
    spy.mockRestore();
  });
});
