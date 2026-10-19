/**
 * H4.2 — the orchestrator's price refusals: the file-price pre-pass, Manager
 * Q7, and the price-refusal counter.
 *
 * Q7: the conversion anchor is the FILE's price. When the file price is not
 * in USD and Google's conversion fails, or returns no US price, the row is
 * REFUSED (`conversion_failed`) — the v3 body would otherwise stamp a TWD /
 * VND amount on the US store, or leave the unlisted countries unpriced. A
 * USD file price IS a correct US price: that row is still sent.
 *
 * T1 covers only one Q7 branch (a TWD file whose conversion throws). The
 * other two — "USD + conversion fails ⇒ sent" and "non-USD + no US in the
 * conversion ⇒ refused" — are pinned here, together with `priceRefusedRows`,
 * the count the execute route adds to `failed` for the Hub status (P5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const batchUpsertInAppProducts = vi.hoisted(() => vi.fn());
vi.mock("../google/publisher-client", () => ({ batchUpsertInAppProducts }));

const buildRegionMapFromBasePrice = vi.hoisted(() => vi.fn());
vi.mock("../google/regions-helper", () => ({ buildRegionMapFromBasePrice }));

const syncIapFromGoogle = vi.hoisted(() => vi.fn());
vi.mock("../repository/iaps", () => ({ syncIapFromGoogle }));

const appendAction = vi.hoisted(() => vi.fn());
vi.mock("../repository/actions-log", () => ({ appendAction }));

const lookupTemplateEntriesForIdentifier = vi.hoisted(() => vi.fn());
const templateExists = vi.hoisted(() => vi.fn());
const findTemplateId = vi.hoisted(() => vi.fn());
vi.mock("../queries/templates", () => ({
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice: vi.fn(async () => []),
  templateExists,
  findTemplateId,
}));

const batchUpdates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const googleIapDb = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb }));

import { executeBulkImport, type BulkImportRow } from "./bulk-import";

function makeDb() {
  return {
    from: () => ({
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => {
        batchUpdates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
}

function row(over: Partial<BulkImportRow>): BulkImportRow {
  return {
    rowNumber: 2,
    sku: "gem.a",
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    regionOverrides: [],
    listings: [{ locale: "en-US", title: "Gem", description: "d" }],
    priceHeaderSource: "explicit",
    decision: "create",
    ...over,
  } as BulkImportRow;
}

const INPUT = {
  appId: "app-1",
  accountId: "acct-1",
  packageName: "com.vng.q7probe",
  sourceFilename: "iaps.xlsx",
  actorEmail: "manager@vng.com.vn",
};

const CONVERTED_WITH_US = {
  regions: [
    { region: "US", currency: "USD", priceMicros: "990000" },
    { region: "TW", currency: "TWD", priceMicros: "30000000" },
  ],
  regionsVersion: "2025/03",
};
const CONVERTED_WITHOUT_US = {
  regions: [{ region: "TW", currency: "TWD", priceMicros: "30000000" }],
  regionsVersion: "2025/03",
};

function sentBodies() {
  return (batchUpsertInAppProducts.mock.calls.at(-1)?.[2] ?? []) as Array<{
    body: { sku: string; defaultPrice?: { currency: string; priceMicros: string }; prices?: Record<string, { currency: string; priceMicros: string }> };
  }>;
}

describe("H4.2 / Q7 — a failed conversion refuses a non-USD row, never a USD one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdates.length = 0;
    googleIapDb.mockReturnValue(makeDb());
    templateExists.mockResolvedValue(true);
    findTemplateId.mockResolvedValue("tpl-1");
    syncIapFromGoogle.mockResolvedValue(undefined);
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
  });

  it("a USD file + conversion FAILS ⇒ the row is still SENT, defaultPrice = the file's USD price, nothing refused", async () => {
    buildRegionMapFromBasePrice.mockRejectedValue(new Error("convert down"));
    const res = await executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row({})] });
    expect(res.refusedRows).toEqual([]);
    expect(res.priceRefusedRows).toBe(0);
    expect(res.rowsCreated).toBe(1);
    const [sent] = sentBodies();
    expect(sent.body.defaultPrice).toEqual({ currency: "USD", priceMicros: "990000" });
    // Nothing else invented a US price.
    expect(sent.body.prices?.US).toBeUndefined();
  });

  it("a TWD file + conversion OK but WITHOUT a US price ⇒ refused conversion_failed ('returned no US price'), nothing sent", async () => {
    buildRegionMapFromBasePrice.mockResolvedValue(CONVERTED_WITHOUT_US);
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [row({ baseCurrency: "TWD", basePriceDecimal: "30" })],
    });
    expect(res.refusedRows).toEqual([
      expect.objectContaining({ sku: "gem.a", kind: "conversion_failed", reason: expect.stringContaining("returned no US price") }),
    ]);
    expect(res.priceRefusedRows).toBe(1);
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  it("a TWD file + conversion FAILS ⇒ refused, and the reason says the conversion failed (not 'no US price')", async () => {
    buildRegionMapFromBasePrice.mockRejectedValue(new Error("convert down"));
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [row({ baseCurrency: "TWD", basePriceDecimal: "30" })],
    });
    expect(res.refusedRows).toHaveLength(1);
    expect(res.refusedRows[0].kind).toBe("conversion_failed");
    expect(res.refusedRows[0].reason).toMatch(/TWD 30 failed\. A row whose price is not in USD is not sent without it/);
    expect(res.refusedRows[0].reason).not.toMatch(/no correct US price/);
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  it("Q7 as decided: a TWD row whose TIER lists US is refused too when the conversion fails (no catalog version, unlisted countries unpriced)", async () => {
    buildRegionMapFromBasePrice.mockRejectedValue(new Error("convert down"));
    lookupTemplateEntriesForIdentifier.mockResolvedValue([
      { identifier: "tier_1", regionCode: "US", currency: "USD", priceMicros: "990000" },
      { identifier: "tier_1", regionCode: "TW", currency: "TWD", priceMicros: "30000000" },
    ]);
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "default_template",
      rows: [row({ baseCurrency: "TWD", basePriceDecimal: "30", chosenTierIdentifier: "tier_1", defaultTierIdentifier: "tier_1", tierCandidateCount: 1 })],
    });
    expect(res.refusedRows.map((r) => r.kind)).toEqual(["conversion_failed"]);
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });
});

describe("H4.2 — the file-price pre-pass refuses the ROW (main price AND GT), never the batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdates.length = 0;
    googleIapDb.mockReturnValue(makeDb());
    syncIapFromGoogle.mockResolvedValue(undefined);
    buildRegionMapFromBasePrice.mockResolvedValue(CONVERTED_WITH_US);
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
  });

  it("a GT the file states in a way that cannot be sent (VN '26.000' as text) refuses THAT row; the neighbour is sent", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [
        row({ rowNumber: 2, sku: "gem.gt", regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "26.000" }] }),
        row({ rowNumber: 3, sku: "gem.ok" }),
      ],
    });
    expect(res.refusedRows).toEqual([
      expect.objectContaining({ sku: "gem.gt", kind: "file_price_invalid", reason: expect.stringContaining('GT VN "26.000" VND') }),
    ]);
    expect(res.priceRefusedRows).toBe(1);
    expect(sentBodies().map((b) => b.body.sku)).toEqual(["gem.ok"]);
  });
});

describe("H4.2 / P5 — priceRefusedRows counts EVERY price refusal; import_batches agrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdates.length = 0;
    googleIapDb.mockReturnValue(makeDb());
    syncIapFromGoogle.mockResolvedValue(undefined);
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
  });

  it("one file_price_invalid + one conversion_failed + one sent ⇒ priceRefusedRows 2, created 1; the batch row is FAILED with rows_failed 2", async () => {
    // Anchor-dependent conversion: the TWD row gets no US; the USD row does.
    buildRegionMapFromBasePrice.mockImplementation(async (_jwt: unknown, _pkg: string, _micros: string, currency: string) =>
      currency === "TWD" ? CONVERTED_WITHOUT_US : CONVERTED_WITH_US,
    );
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [
        row({ rowNumber: 2, sku: "gem.zero", basePriceDecimal: "0" }),
        row({ rowNumber: 3, sku: "gem.twd", baseCurrency: "TWD", basePriceDecimal: "30" }),
        row({ rowNumber: 4, sku: "gem.ok" }),
      ],
    });
    expect(res.refusedRows.map((r) => [r.sku, r.kind])).toEqual([
      ["gem.zero", "file_price_invalid"],
      ["gem.twd", "conversion_failed"],
    ]);
    expect(res.priceRefusedRows).toBe(2);
    expect(res.rowsCreated).toBe(1);
    expect(sentBodies().map((b) => b.body.sku)).toEqual(["gem.ok"]);
    // The push branch writes the same rule as the no-push and catch branches.
    expect(batchUpdates.at(-1)).toEqual(expect.objectContaining({ status: "FAILED", rows_success: 1, rows_failed: 2 }));
  });

  it("a clean batch still closes COMPLETE with rows_failed 0", async () => {
    buildRegionMapFromBasePrice.mockResolvedValue(CONVERTED_WITH_US);
    const res = await executeBulkImport({} as never, { ...INPUT, pricingSource: "google_default", rows: [row({})] });
    expect(res.priceRefusedRows).toBe(0);
    expect(batchUpdates.at(-1)).toEqual(expect.objectContaining({ status: "COMPLETE", rows_success: 1, rows_failed: 0 }));
  });
});
