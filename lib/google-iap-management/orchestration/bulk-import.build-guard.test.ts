/**
 * H4.3 — the guard around buildProduct. Every price is checked before it
 * (file-price pre-pass, custom pre-pass, tier check), so the guard should
 * never fire. This test simulates a check that WRONGLY lets a bad tier price
 * through (storedRegionPriceOf stubbed to always pass): buildProduct then
 * throws, and the batch must refuse THAT row — its own kind,
 * `price_build_failed` — and still send the others, close import_batches and
 * return. Before H4.3 the same throw 500'd the whole batch and left
 * import_batches IN_PROGRESS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const batchUpsertInAppProducts = vi.hoisted(() => vi.fn());
vi.mock("../google/publisher-client", () => ({ batchUpsertInAppProducts }));

const buildRegionMapFromBasePrice = vi.hoisted(() => vi.fn());
vi.mock("../google/regions-helper", () => ({ buildRegionMapFromBasePrice }));

vi.mock("../repository/iaps", () => ({ syncIapFromGoogle: vi.fn(async () => undefined) }));
const appendAction = vi.hoisted(() => vi.fn());
vi.mock("../repository/actions-log", () => ({ appendAction }));

const lookupTemplateEntriesForIdentifier = vi.hoisted(() => vi.fn());
vi.mock("../queries/templates", () => ({
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice: vi.fn(async () => []),
  templateExists: vi.fn(async () => true),
  findTemplateId: vi.fn(async () => "tpl-1"),
}));

// The simulated defect: the tier check passes everything.
vi.mock("./file-price", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-price")>();
  return {
    ...actual,
    storedRegionPriceOf: (o: { currency: string; priceMicros: string }) => ({
      ok: true as const,
      currency: o.currency,
      priceMicros: o.priceMicros,
    }),
  };
});

const batchUpdates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const googleIapDb = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb }));

import { executeBulkImport, type BulkImportRow } from "./bulk-import";

function makeDb() {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        batchUpdates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
}

const row = (rowNumber: number, sku: string, tier: string): BulkImportRow =>
  ({
    rowNumber,
    sku,
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    regionOverrides: [],
    listings: [{ locale: "en-US", title: sku, description: "d" }],
    decision: "create",
    chosenTierIdentifier: tier,
    defaultTierIdentifier: tier,
    tierCandidateCount: 1,
  }) as BulkImportRow;

describe("H4.3 — no price can 500 the batch: buildProduct throwing refuses THAT row (price_build_failed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdates.length = 0;
    googleIapDb.mockReturnValue(makeDb());
    buildRegionMapFromBasePrice.mockResolvedValue({
      regions: [{ region: "US", currency: "USD", priceMicros: "990000" }],
      regionsVersion: "2025/03",
    });
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
    lookupTemplateEntriesForIdentifier.mockImplementation(async ({ identifier }: { identifier: string }) =>
      identifier === "t_bad"
        ? [{ identifier, regionCode: "TW", currency: "TWD", priceMicros: "30500000" }]
        : [{ identifier, regionCode: "US", currency: "USD", priceMicros: "990000" }],
    );
  });

  it("the bad row is refused with its own kind and the thrown reason; the good row is sent; the batch closes", async () => {
    const res = await executeBulkImport({} as never, {
      appId: "app-1",
      accountId: "acct-1",
      packageName: "com.vng.guard",
      sourceFilename: "x.xlsx",
      actorEmail: null,
      pricingSource: "default_template",
      rows: [row(2, "gem.bad", "t_bad"), row(3, "gem.ok", "t_ok")],
    });
    expect(res.refusedRows).toEqual([
      expect.objectContaining({
        sku: "gem.bad",
        kind: "price_build_failed",
        reason: expect.stringMatching(/^Row 2 \(gem\.bad\): its prices could not be built — TWD only accepts whole numbers/),
      }),
    ]);
    expect(res.rowsCreated).toBe(1);
    expect(res.rowsRefused).toBe(1);
    // Counted as a PRICE refusal in the audit breakdown too.
    expect(res.priceRefusedRows).toBe(1);
    expect((appendAction.mock.calls.at(-1)?.[0]?.payload as Record<string, unknown>).price_refused_rows).toBe(1);
    expect(batchUpsertInAppProducts.mock.calls[0][2].map((i: { body: { sku: string } }) => i.body.sku)).toEqual(["gem.ok"]);
    expect(batchUpdates.at(-1)).toEqual(expect.objectContaining({ status: "FAILED", rows_failed: 1 }));
  });
});
