/**
 * SC4 acceptance — per-item custom prices through the orchestrator.
 *
 * THE LOAD-BEARING TEST is "custom prices reach the Google payload
 * UNCHANGED under a template source". It exists to pin the guard at the
 * top of the template-resolution loop:
 *
 *   if (row.crossCurrencyRefusal || row.resolvedDefaultPrice || row.customPrices)
 *
 * Without `|| row.customPrices`, the loop below reassigns
 * `row.regionOverrides = entries.map(...)` from the matched tier and the
 * Manager's typed prices are SILENTLY REPLACED BY TEMPLATE PRICES on the
 * way to a live store. Mutation-checked: deleting that clause makes this
 * test fail with the template's numbers in the payload.
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
const findCandidateTiersForCurrencyPrice = vi.hoisted(() => vi.fn());
const templateExists = vi.hoisted(() => vi.fn());
const findTemplateId = vi.hoisted(() => vi.fn());
vi.mock("../queries/templates", () => ({
  lookupTemplateEntriesForIdentifier,
  findCandidateTiersForCurrencyPrice,
  templateExists,
  findTemplateId,
}));

const googleIapDb = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ googleIapDb }));

import { executeBulkImport, type BulkImportRow } from "./bulk-import";

/** Minimal Supabase-ish chain: insert().select().single() then update().eq(). */
function makeDb() {
  return {
    from: () => ({
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
}

const TEMPLATE_ENTRIES = [
  { identifier: "tier_999", regionCode: "US", currency: "USD", priceMicros: "9990000" },
  { identifier: "tier_999", regionCode: "VN", currency: "VND", priceMicros: "249000000000" },
];

function customRow(over: Partial<BulkImportRow> = {}): BulkImportRow {
  return {
    rowNumber: 2,
    sku: "gem_pack_large",
    baseCurrency: "USD",
    basePriceDecimal: "9.99",
    regionOverrides: [],
    listings: [{ locale: "en-US", title: "Gem Pack", description: "d" }],
    priceHeaderSource: "explicit",
    decision: "create",
    chosenTierIdentifier: "tier_999",
    defaultTierIdentifier: "tier_999",
    tierCandidateCount: 1,
    customPrices: {
      entries: [
        { region: "US", currency: "USD", priceDecimal: "12.34" },
        { region: "VN", currency: "VND", priceDecimal: "199000" },
      ],
      baselineTier: "tier_999",
      editedAt: "2026-08-07T10:00:00.000Z",
    },
    ...over,
  } as BulkImportRow;
}

const INPUT_BASE = {
  appId: "app-1",
  packageName: "com.vng.cashknight",
  sourceFilename: "iaps.xlsx",
  actorEmail: "manager@vng.com.vn",
  appDefaultCurrency: "VND",
};

function lastUpsertInputs() {
  return batchUpsertInAppProducts.mock.calls.at(-1)?.[2] as Array<{
    body: { prices?: Record<string, { currency: string; priceMicros: string }>; defaultPrice?: { currency: string; priceMicros: string } };
  }>;
}

describe("executeBulkImport — per-item custom prices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleIapDb.mockReturnValue(makeDb());
    templateExists.mockResolvedValue(true);
    findTemplateId.mockResolvedValue("tpl-1");
    lookupTemplateEntriesForIdentifier.mockResolvedValue(TEMPLATE_ENTRIES);
    findCandidateTiersForCurrencyPrice.mockResolvedValue([]);
    // No extra regions from the bootstrap, so the assertions see exactly
    // what the row itself contributed.
    buildRegionMapFromBasePrice.mockResolvedValue({ regions: [], regionsVersion: "2024/02" });
    syncIapFromGoogle.mockResolvedValue(undefined);
    batchUpsertInAppProducts.mockImplementation(async (_jwt, _pkg, inputs) =>
      inputs.map((i: { body: { sku: string } }) => ({ sku: i.body.sku })),
    );
  });

  it("MUTATION-CHECK ANCHOR: custom prices reach the Google payload UNCHANGED under a template source", async () => {
    const row = customRow();
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [row],
    });

    const body = lastUpsertInputs()[0].body;
    // The Manager's numbers, NOT the template's (9.99 / 249000).
    expect(body.prices).toMatchObject({
      US: { currency: "USD", priceMicros: "12340000" },
      VN: { currency: "VND", priceMicros: "199000000000" },
    });
    // Q6 UNDER A TEMPLATE SOURCE: the custom set replaces the whole
    // price set, so defaultPrice must come from its app-currency (VND)
    // entry. Under Google Conversion the rule does NOT apply — see the
    // sparse-overlay tests below.
    expect(body.defaultPrice).toEqual({
      currency: "VND",
      priceMicros: "199000000000",
    });
  });

  it("does not consult the template at all for a custom row", async () => {
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [customRow()],
    });
    expect(lookupTemplateEntriesForIdentifier).not.toHaveBeenCalled();
  });

  it("a NON-custom row in the same batch still gets template prices", async () => {
    const plain = customRow({
      rowNumber: 3,
      sku: "coin_pack",
      customPrices: null,
      baseCurrency: "VND",
      basePriceDecimal: "249000",
    });
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [customRow(), plain],
    });
    const inputs = lastUpsertInputs();
    expect(inputs[0].body.prices!.VN.priceMicros).toBe("199000000000"); // custom
    expect(inputs[1].body.prices!.VN.priceMicros).toBe("249000000000"); // template
  });

  it("custom WINS over cross-currency: no conversion is attempted", async () => {
    // USD price in a VND app would normally trigger the cross-currency
    // pre-pass; the custom set is absolute, so there is nothing to convert.
    const row = customRow({ baseCurrency: "USD", basePriceDecimal: "9.99" });
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [row],
    });
    expect(res.rowsRefused).toBe(0);
    expect(res.customPricedRows).toBe(1);
    expect(lastUpsertInputs()[0].body.defaultPrice!.currency).toBe("VND");
  });

  it("REFUSES (never falls back to template) when no entry carries the app currency", async () => {
    const row = customRow({
      customPrices: {
        entries: [{ region: "US", currency: "USD", priceDecimal: "12.34" }],
        baselineTier: "tier_999",
        editedAt: null,
      },
    });
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [row],
    });
    expect(res.customRefusedRows).toBe(1);
    expect(res.refusedRows[0].kind).toBe("custom_no_app_currency_entry");
    expect(res.refusedRows[0].reason).toContain("no VND entry");
    // Nothing was sent — the row did NOT quietly ship template prices.
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  it("REFUSES an invalid price with a message naming row, SKU, value and reason", async () => {
    const row = customRow({
      customPrices: {
        entries: [
          { region: "VN", currency: "VND", priceDecimal: "199000.55" }, // VND = 0 decimals
        ],
        baselineTier: null,
        editedAt: null,
      },
    });
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [row],
    });
    expect(res.refusedRows[0].kind).toBe("custom_invalid_price");
    expect(res.refusedRows[0].reason).toContain("Row 2");
    expect(res.refusedRows[0].reason).toContain("gem_pack_large");
    expect(res.refusedRows[0].reason).toContain("199000.55");
    expect(res.refusedRows[0].reason).toContain("VND");
    expect(res.refusedRows[0].reason).toContain("Row not sent");
  });

  it("one malformed custom row refuses ONLY that row — the rest of the batch proceeds", async () => {
    const bad = customRow({
      rowNumber: 2,
      sku: "bad_row",
      customPrices: {
        entries: [{ region: "VN", currency: "VND", priceDecimal: "1.5" }],
        baselineTier: null,
        editedAt: null,
      },
    });
    const good = customRow({ rowNumber: 3, sku: "good_row" });
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [bad, good],
    });
    expect(res.customRefusedRows).toBe(1);
    expect(res.rowsCreated).toBe(1);
    expect(lastUpsertInputs()).toHaveLength(1);
    expect(lastUpsertInputs()[0].body).toMatchObject({ sku: "good_row" });
  });

  it("INVERTED: custom prices APPLY under Google Conversion (was: refused as custom_source_mismatch)", async () => {
    // The old restriction assumed the template clobber could reach this
    // path. It cannot: the template-resolution loop is gated on
    // `pricingSource !== "google_default"`, so regionOverrides flows
    // straight through to buildProduct. Per-country overrides have always
    // worked here via the file's GT-Price column; this raises the ceiling
    // from one country to ~170.
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "google_default",
      rows: [customRow()],
    });
    expect(res.customRefusedRows).toBe(0);
    expect(res.customPricedRows).toBe(1);
    const prices = lastUpsertInputs()[0].body.prices!;
    expect(prices.VN.priceMicros).toBe("199000000000");
    expect(prices.US.priceMicros).toBe("12340000");
  });

  /**
   * THE S0.2 REGRESSION, in test form — the single most important new case.
   *
   * The app-currency requirement is correct under a TEMPLATE source, where
   * the custom set replaces the whole ~170-country set and is therefore the
   * only possible source of defaultPrice. Under Google Conversion the set
   * is a SPARSE OVERLAY and defaultPrice legitimately comes from the file's
   * base price. Applying the template rule here would refuse a user who
   * overrode three countries, none of them the app's own — something
   * entirely legitimate.
   */
  it("S0.2: sparse custom under Google Conversion with NO app-currency entry is applied, not refused", async () => {
    buildRegionMapFromBasePrice.mockResolvedValue({
      regions: [
        { region: "TH", currency: "THB", priceMicros: "350000000" },
        { region: "VN", currency: "VND", priceMicros: "249000000000" },
      ],
      regionsVersion: "2024/02",
    });
    const row = customRow({
      // App currency is VND; none of these three are VND.
      customPrices: {
        entries: [
          { region: "US", currency: "USD", priceDecimal: "12.34" },
          { region: "JP", currency: "JPY", priceDecimal: "1500" },
          { region: "KR", currency: "KRW", priceDecimal: "15000" },
        ],
        baselineTier: null,
        editedAt: null,
      },
    });
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "google_default",
      rows: [row],
    });

    expect(res.customRefusedRows).toBe(0);
    expect(res.rowsCreated).toBe(1);

    const body = lastUpsertInputs()[0].body;
    // The three overrides reach the payload...
    expect(body.prices!.US.priceMicros).toBe("12340000");
    expect(body.prices!.JP.priceMicros).toBe("1500000000");
    expect(body.prices!.KR.priceMicros).toBe("15000000000");
    // ...every other country still comes from Google's bootstrap...
    expect(body.prices!.TH).toEqual({ currency: "THB", priceMicros: "350000000" });
    // ...and defaultPrice comes from the FILE'S BASE PRICE, untouched.
    expect(body.defaultPrice).toEqual({ currency: "USD", priceMicros: "9990000" });
  });

  it("an app-currency entry set under Google Conversion WINS as defaultPrice (explicit beats base price)", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "google_default",
      rows: [customRow()], // carries a VND entry; app currency is VND
    });
    expect(res.customRefusedRows).toBe(0);
    expect(lastUpsertInputs()[0].body.defaultPrice).toEqual({
      currency: "VND",
      priceMicros: "199000000000",
    });
  });

  it("UNCHANGED under a TEMPLATE source: a missing app-currency entry still refuses", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [
        customRow({
          customPrices: {
            entries: [{ region: "US", currency: "USD", priceDecimal: "12.34" }],
            baselineTier: "tier_999",
            editedAt: null,
          },
        }),
      ],
    });
    expect(res.customRefusedRows).toBe(1);
    expect(res.refusedRows[0].kind).toBe("custom_no_app_currency_entry");
  });

  it("B6: perRowDiagnostic records provenance for a custom row under Google Conversion", async () => {
    // The custom diagnostic loop sits ABOVE the `pricingSource !==
    // "google_default"` branch, so it runs here too. Pinned, because this
    // is exactly the path where an audit trail would go missing.
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "google_default",
      rows: [customRow()],
    });
    const payload = appendAction.mock.calls.at(-1)![0].payload;
    expect(payload.custom_priced_rows).toBe(1);
    const diag = payload.per_row_diagnostic.find(
      (d: { sku: string }) => d.sku === "gem_pack_large",
    );
    expect(diag).toMatchObject({
      price_provenance: "custom",
      custom_entry_count: 2,
    });
  });

  it("a skipped row's custom prices are never sent", async () => {
    const res = await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [customRow({ decision: "skip" })],
    });
    expect(res.rowsSkipped).toBe(1);
    expect(res.customPricedRows).toBe(0);
    expect(batchUpsertInAppProducts).not.toHaveBeenCalled();
  });

  it("countries the custom set omits are still filled by Google's conversion (bootstrap intact)", async () => {
    buildRegionMapFromBasePrice.mockResolvedValue({
      regions: [{ region: "TH", currency: "THB", priceMicros: "350000000" }],
      regionsVersion: "2024/02",
    });
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [customRow()],
    });
    const prices = lastUpsertInputs()[0].body.prices!;
    expect(prices.TH).toEqual({ currency: "THB", priceMicros: "350000000" });
    // ...and the custom values were not displaced by the bootstrap.
    expect(prices.VN.priceMicros).toBe("199000000000");
    // The bootstrap ran, so regionsVersion is available to pin (Hotfix 9).
    expect(buildRegionMapFromBasePrice).toHaveBeenCalled();
  });

  it("records per-item provenance in the audit payload", async () => {
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [customRow()],
    });
    const payload = appendAction.mock.calls.at(-1)![0].payload;
    expect(payload.custom_priced_rows).toBe(1);
    expect(payload.custom_refused_rows).toBe(0);
    const diag = payload.per_row_diagnostic.find(
      (d: { sku: string }) => d.sku === "gem_pack_large",
    );
    expect(diag).toMatchObject({
      price_provenance: "custom",
      custom_entry_count: 2,
      custom_baseline_tier: "tier_999",
      custom_edited_at: "2026-08-07T10:00:00.000Z",
    });
  });

  /**
   * Pins the `|| row.customPrices` clause specifically.
   *
   * The anchor test above does NOT pin it — on the success path
   * `resolvedDefaultPrice` is already set by the custom pre-pass, which
   * makes the guard's earlier clause do the skipping. (Verified by
   * mutation: deleting `|| row.customPrices` leaves the anchor green;
   * deleting the resolvedDefaultPrice stamp turns it red.)
   *
   * Where the clause DOES earn its place is a REFUSED custom row: it has
   * no resolvedDefaultPrice, so without this clause it falls into the
   * template loop, gets `row.regionOverrides` overwritten with template
   * entries, and emits a SECOND diagnostic claiming provenance
   * "template". The audit would then show a row the Manager marked
   * Custom as template-priced — a false provenance record, and a latent
   * hazard the moment a refactor stops excluding refused rows.
   */
  it("a REFUSED custom row never acquires template provenance (pins the customPrices guard clause)", async () => {
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [
        customRow({
          customPrices: {
            entries: [{ region: "US", currency: "USD", priceDecimal: "12.34" }],
            baselineTier: "tier_999",
            editedAt: null,
          },
        }),
      ],
    });
    const payload = appendAction.mock.calls.at(-1)![0].payload;
    const forSku = payload.per_row_diagnostic.filter(
      (d: { sku: string }) => d.sku === "gem_pack_large",
    );
    // Exactly one record, and it says the row was refused — not a second
    // one claiming the template supplied its price.
    expect(forSku).toHaveLength(1);
    expect(forSku[0].price_provenance).toBe("custom_refused");
    expect(
      forSku.some((d: { price_provenance: string }) => d.price_provenance === "template"),
    ).toBe(false);
  });

  it("records a refused custom row's attempt in the audit, not silence", async () => {
    await executeBulkImport({} as never, {
      ...INPUT_BASE,
      pricingSource: "default_template",
      rows: [
        customRow({
          customPrices: {
            entries: [{ region: "US", currency: "USD", priceDecimal: "12.34" }],
            baselineTier: "tier_999",
            editedAt: null,
          },
        }),
      ],
    });
    const payload = appendAction.mock.calls.at(-1)![0].payload;
    const diag = payload.per_row_diagnostic.find(
      (d: { sku: string }) => d.sku === "gem_pack_large",
    );
    expect(diag.price_provenance).toBe("custom_refused");
  });
});
