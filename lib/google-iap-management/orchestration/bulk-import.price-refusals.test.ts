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
const findCandidateTiersForCurrencyPrice = vi.hoisted(() => vi.fn(async () => [] as Array<{ identifier: string }>));
const templateExists = vi.hoisted(() => vi.fn());
const findTemplateId = vi.hoisted(() => vi.fn());
vi.mock("../queries/templates", () => ({
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice,
  templateExists,
  findTemplateId,
}));

const batchUpdates = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const batchInserts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const googleIapDb = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb }));

import { executeBulkImport, type BulkImportRow } from "./bulk-import";

function makeDb() {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        batchInserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) };
      },
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
    // H4.3 (Manager 2026-10-19): it SAYS temporary, run the row again later.
    expect(res.refusedRows[0].reason).toBe(
      "Row 2 (gem.a): Google's price conversion failed temporarily (convert down) — this is not a problem with the row's data: run this row again later. A row whose price is not in USD is not sent without Google's conversion. Row not sent.",
    );
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  const httpErr = (status: number, message: string, gStatus?: string) =>
    Object.assign(new Error(message), {
      code: status,
      response: { status, data: { error: { code: status, message, ...(gStatus ? { status: gStatus } : {}) } } },
    });
  it.each([
    ["HTTP 503", httpErr(503, "Service unavailable", "UNAVAILABLE"), "temporary"],
    ["HTTP 429", httpErr(429, "Quota", "RESOURCE_EXHAUSTED"), "temporary"],
    ["HTTP 408", httpErr(408, "Request timeout"), "temporary"],
    ["a network error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "temporary"],
    ["HTTP 400 INVALID_ARGUMENT (Google says the price is invalid)", httpErr(400, "Price too low", "INVALID_ARGUMENT"), "price"],
    ["HTTP 403 PERMISSION_DENIED", httpErr(403, "The caller does not have permission", "PERMISSION_DENIED"), "access"],
    ["HTTP 401", httpErr(401, "Request had invalid authentication credentials", "UNAUTHENTICATED"), "access"],
    ["HTTP 400 invalid_grant (no INVALID_ARGUMENT)", httpErr(400, "invalid_grant"), "access"],
  ])("H4.3: %s ⇒ %s — 'temporary' / 'check the price' / 'access' only where true", async (_label, err, kind) => {
    buildRegionMapFromBasePrice.mockRejectedValue(err);
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [row({ baseCurrency: "TWD", basePriceDecimal: "30" })],
    });
    expect(res.refusedRows.map((r) => r.kind)).toEqual(["conversion_failed"]);
    const reason = res.refusedRows[0].reason;
    if (kind === "temporary") {
      expect(reason).toMatch(/failed temporarily .* this is not a problem with the row's data: run this row again later/);
    } else if (kind === "price") {
      expect(reason).toMatch(/Google rejected the file price TWD 30 as invalid \(HTTP 400 INVALID_ARGUMENT: Price too low\)\. This is not a temporary failure — check the price\./);
    } else {
      expect(reason).toMatch(/Google refused the conversion request \(HTTP 4\d\d.*\) — an access, account or app problem, not the row's data, and not temporary/);
      expect(reason).not.toMatch(/check the price|temporarily/);
    }
  });

  it("Q7 as decided: a TWD row whose CUSTOM set lists US is refused too when the conversion fails", async () => {
    buildRegionMapFromBasePrice.mockRejectedValue(new Error("convert down"));
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [
        row({
          baseCurrency: "TWD",
          basePriceDecimal: "30",
          customPrices: {
            entries: [
              { region: "US", currency: "USD", priceDecimal: "0.99" },
              { region: "TW", currency: "TWD", priceDecimal: "30" },
            ],
            baselineTier: null,
            editedAt: null,
          },
        }),
      ],
    });
    expect(res.refusedRows.map((r) => r.kind)).toEqual(["conversion_failed"]);
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

describe("H4.3 — a pricing-template tier with a price that cannot be sent refuses THAT ROW, never the batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdates.length = 0;
    batchInserts.length = 0;
    googleIapDb.mockReturnValue(makeDb());
    templateExists.mockResolvedValue(true);
    findTemplateId.mockResolvedValue("tpl-1");
    findCandidateTiersForCurrencyPrice.mockResolvedValue([]);
    syncIapFromGoogle.mockResolvedValue(undefined);
    buildRegionMapFromBasePrice.mockResolvedValue(CONVERTED_WITH_US);
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
    lookupTemplateEntriesForIdentifier.mockImplementation(async ({ identifier }: { identifier: string }) =>
      identifier === "t_bad"
        ? [
            { identifier: "t_bad", regionCode: "US", currency: "USD", priceMicros: "990000" },
            { identifier: "t_bad", regionCode: "TW", currency: "TWD", priceMicros: "30500000" },
          ]
        : identifier === "t_zero"
          ? [{ identifier: "t_zero", regionCode: "VN", currency: "VND", priceMicros: "0" }]
          : [
              { identifier: "t_ok", regionCode: "US", currency: "USD", priceMicros: "990000" },
              { identifier: "t_ok", regionCode: "VN", currency: "VND", priceMicros: "26000000000" },
            ],
    );
  });

  const tierRow = (rowNumber: number, sku: string, tier: string) =>
    row({ rowNumber, sku, chosenTierIdentifier: tier, defaultTierIdentifier: tier, tierCandidateCount: 1 });

  it("TWD 30.5 in the tier ⇒ that row refused (tier_price_invalid, naming tier + entry + where to fix); the neighbour IS sent; the batch closes FAILED, not stuck", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "default_template",
      rows: [tierRow(2, "gem.bad", "t_bad"), tierRow(3, "gem.ok", "t_ok")],
    });
    expect(res.refusedRows).toEqual([
      {
        sku: "gem.bad",
        rowNumber: 2,
        kind: "tier_price_invalid",
        reason:
          'Row 2 (gem.bad): pricing-template tier "t_bad" holds a price that cannot be sent — TW TWD: TWD only accepts whole numbers (got "30.5"). Google rejects fractional values for this currency. Fix the tier in Settings → Pricing Templates, then import this row again. Row not sent.',
      },
    ]);
    expect(res.rowsCreated).toBe(1);
    expect(sentBodies().map((b) => b.body.sku)).toEqual(["gem.ok"]);
    // VND 26000 stored as "26000.000000" is NOT a thousands separator.
    expect(sentBodies()[0].body.prices?.VN).toEqual({ currency: "VND", priceMicros: "26000000000" });
    expect(batchUpdates.at(-1)).toEqual(expect.objectContaining({ status: "FAILED", rows_success: 1, rows_failed: 1 }));
  });

  it.each([
    ["the SKU-named tier (no tier chosen in the preview)", "sku"],
    ["the single currency-price candidate (no tier chosen in the preview)", "probe"],
  ])("the check covers %s too: a 0 / TWD 30.5 entry refuses the row, nothing is sent", async (_label, path) => {
    lookupTemplateEntriesForIdentifier.mockImplementation(async ({ identifier }: { identifier: string }) =>
      (path === "sku" && identifier === "gem.legacy") || (path === "probe" && identifier === "t_probe")
        ? [
            { identifier, regionCode: "VN", currency: "VND", priceMicros: "0" },
            { identifier, regionCode: "TW", currency: "TWD", priceMicros: "30500000" },
          ]
        : [],
    );
    findCandidateTiersForCurrencyPrice.mockResolvedValue(path === "probe" ? [{ identifier: "t_probe" }] : []);
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "default_template",
      rows: [row({ rowNumber: 2, sku: "gem.legacy", chosenTierIdentifier: null, tierCandidateCount: 0 })],
    });
    expect(res.refusedRows.map((r) => r.kind)).toEqual(["tier_price_invalid"]);
    expect(res.refusedRows[0].reason).toMatch(/VN VND: the price is 0 .* TW TWD: TWD only accepts whole numbers/);
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  it("a 0 in the tier is refused too (rule b — never sent)", async () => {
    const res = await executeBulkImport({} as never, { ...INPUT, pricingSource: "default_template", rows: [tierRow(2, "gem.z", "t_zero")] });
    expect(res.refusedRows.map((r) => r.kind)).toEqual(["tier_price_invalid"]);
    expect(res.refusedRows[0].reason).toMatch(/VN VND: the price is 0/);
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  it("the audit's selection counters do not count the refused row", async () => {
    await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "default_template",
      rows: [tierRow(2, "gem.bad", "t_bad"), tierRow(3, "gem.ok", "t_ok")],
    });
    const payload = appendAction.mock.calls.at(-1)?.[0]?.payload as Record<string, unknown>;
    expect(payload.single_match_rows).toBe(1);
    expect(payload.price_refused_rows).toBe(1);
  });
});

describe("H4.3 — custom prices: the server re-check is statedPriceOf (a), precision, (b); the route's own reason is kept", () => {
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

  const custom = (entries: Array<{ region: string; currency: string; priceDecimal: string }>) => ({
    customPrices: { entries, baselineTier: null, editedAt: null },
  });

  it("'26.000' VND and '0' JPY ⇒ that row refused, EVERY bad entry named; a clean custom row is sent", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [
        row({ rowNumber: 2, sku: "gem.bad", ...custom([{ region: "VN", currency: "VND", priceDecimal: "26.000" }, { region: "JP", currency: "JPY", priceDecimal: "0" }]) }),
        row({ rowNumber: 3, sku: "gem.ok", ...custom([{ region: "VN", currency: "VND", priceDecimal: "26000" }]) }),
      ],
    });
    expect(res.refusedRows).toEqual([
      {
        sku: "gem.bad",
        rowNumber: 2,
        kind: "custom_invalid_price",
        reason:
          'Row 2 (gem.bad): custom price VN "26.000" VND — "26.000" has a "." but VND has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000. custom price JP "0" JPY — the price is 0 — a 0 price is not accepted; enter the real price. Row not sent.',
      },
    ]);
    expect(sentBodies().map((b) => b.body.sku)).toEqual(["gem.ok"]);
    expect(sentBodies()[0].body.prices?.VN).toEqual({ currency: "VND", priceMicros: "26000000000" });
  });

  it("a refusal the ROUTE already made keeps ITS reason (it was overwritten with 'no country prices were supplied')", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [
        row({
          rowNumber: 2,
          sku: "gem.r",
          ...custom([]),
          customPriceRefusal: { kind: "custom_invalid_price", reason: "Row 2 (gem.r): a custom price entry is missing its country, currency or amount. Row not sent." },
        }),
      ],
    });
    expect(res.refusedRows.map((r) => r.reason)).toEqual([
      "Row 2 (gem.r): a custom price entry is missing its country, currency or amount. Row not sent.",
    ]);
    expect(res.customRefusedRows).toBe(1);
  });
});

describe("H4.3 — rows dropped in the file are rows of the batch: counted, listed, never sent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchUpdates.length = 0;
    batchInserts.length = 0;
    googleIapDb.mockReturnValue(makeDb());
    syncIapFromGoogle.mockResolvedValue(undefined);
    buildRegionMapFromBasePrice.mockResolvedValue(CONVERTED_WITH_US);
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
  });

  it("1 sent + 1 dropped ⇒ rowsTotal 2, rowsRefused 1 (kind refused_in_file, in file order), import_batches total 2 / FAILED / rows_failed 1, audit counts it", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [row({ rowNumber: 3, sku: "gem.ok" })],
      droppedRows: [{ rowNumber: 2, sku: "gem.empty", reason: '"Price (USD)" is empty — fill in the price.' }],
    });
    expect(res.rowsTotal).toBe(2);
    expect(res.rowsCreated).toBe(1);
    expect(res.rowsRefused).toBe(1);
    expect(res.droppedRows).toBe(1);
    expect(res.refusedRows).toEqual([
      {
        sku: "gem.empty",
        rowNumber: 2,
        kind: "refused_in_file",
        reason: 'Row 2 (gem.empty): "Price (USD)" is empty — fill in the price. Not imported — refused in the file, left out when you pushed.',
      },
    ]);
    expect(sentBodies().map((b) => b.body.sku)).toEqual(["gem.ok"]);
    expect(batchInserts.at(-1)).toEqual(expect.objectContaining({ rows_total: 2 }));
    expect(batchUpdates.at(-1)).toEqual(expect.objectContaining({ status: "FAILED", rows_success: 1, rows_failed: 1 }));
    const payload = appendAction.mock.calls.at(-1)?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ rows_total: 2, rows_refused: 1, dropped_in_file_rows: 1 });
  });

  it("NOTHING to push (the only row set to Skip) + 2 dropped ⇒ import_batches FAILED with rows_failed 2, rowsTotal 3 — never COMPLETE", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [row({ rowNumber: 2, sku: "gem.skip", decision: "skip" })],
      droppedRows: [
        { rowNumber: 3, sku: "a", reason: "x." },
        { rowNumber: 4, sku: "b", reason: "y." },
      ],
    });
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
    expect(res.rowsTotal).toBe(3);
    expect(res.rowsSkipped).toBe(1);
    expect(res.rowsRefused).toBe(2);
    expect(batchUpdates.at(-1)).toEqual(expect.objectContaining({ status: "FAILED", rows_failed: 2 }));
  });

  it("refused rows are ONE list in file order — dropped and refused-at-push interleaved by row number", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT,
      pricingSource: "google_default",
      rows: [row({ rowNumber: 3, sku: "gem.zero", basePriceDecimal: "0" }), row({ rowNumber: 5, sku: "gem.ok" })],
      droppedRows: [
        { rowNumber: 2, sku: "d2", reason: "x." },
        { rowNumber: 4, sku: "d4", reason: "y." },
      ],
    });
    expect(res.refusedRows.map((r) => [r.rowNumber, r.kind])).toEqual([
      [2, "refused_in_file"],
      [3, "file_price_invalid"],
      [4, "refused_in_file"],
    ]);
  });
});
