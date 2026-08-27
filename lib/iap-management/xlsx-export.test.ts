import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import { buildExportPlan, buildExportWorkbook, xlsxExportFilename,
  buildFailureRows,
} from "./xlsx-export";
import type { ExportSource } from "./xlsx-export";
import type { PriceScheduleView, PriceScheduleEntry } from "./queries/iap-detail";

function entry(overrides: Partial<PriceScheduleEntry>): PriceScheduleEntry {
  return {
    priceId: "price-1",
    startDate: null,
    endDate: null,
    territory: "USA",
    customerPrice: "0.99",
    // E1 — the field is REQUIRED on purpose: it decides whether the export
    // shades a cell, so every fixture must state what it claims. `null` =
    // "Apple did not say", which is what this fixture claimed before it
    // existed. NO assertion in this file changed.
    manual: null,
    currency: "USD",
    ...overrides,
  };
}

function schedule(entries: PriceScheduleEntry[], baseTerritory = "USA"): PriceScheduleView {
  const basePrice = entries.find((e) => e.territory === baseTerritory && e.startDate === null) ?? null;
  return { baseTerritory, basePrice, entries };
}

function source(overrides: Partial<ExportSource>): ExportSource {
  return {
    appleIapId: "apple-1",
    productId: "com.example.item",
    skuName: "Item",
    status: "APPROVED",
    priceSchedule: null,
    priceReadFailure: null,
    localizations: [],
    ...overrides,
  };
}

describe("buildExportPlan — territory columns", () => {
  it("is the sorted (alpha-2) union of territories-with-a-price across all rows", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: schedule([entry({ territory: "USA" })]) }),
      source({
        priceSchedule: schedule(
          [
            entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
            entry({ territory: "JPN", customerPrice: "160", currency: "JPY" }),
          ],
          "VNM",
        ),
      }),
    ]);
    expect(plan.territories).toEqual(["JP", "US", "VN"]);
  });

  it("leaves a row's missing territory blank when it has no effective-now price there", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: schedule([entry({ territory: "USA" })]) }),
      source({
        priceSchedule: schedule([entry({ territory: "VNM", customerPrice: "24000", currency: "VND" })], "VNM"),
      }),
    ]);
    expect(plan.rows[0].prices.VN).toBeUndefined();
    expect(plan.rows[1].prices.US).toBeUndefined();
  });

  it("excludes future-dated (upcoming-change) entries from the price columns", () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: schedule([
          entry({ territory: "USA", customerPrice: "0.99" }),
          entry({ territory: "USA", customerPrice: "1.99", startDate: "2026-12-01", priceId: "price-2" }),
        ]),
      }),
    ]);
    expect(plan.rows[0].prices.US).toEqual({ price: "0.99", currency: "USD" });
  });

  it("uses Apple's customerPrice/currency verbatim — no re-conversion (already currency-correct)", () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: schedule(
          [
            entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
            entry({ territory: "JPN", customerPrice: "160", currency: "JPY" }),
            entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
          ],
          "USA",
        ),
      }),
    ]);
    const row = plan.rows[0];
    expect(row.prices.US).toEqual({ price: "0.99", currency: "USD" });
    expect(row.prices.JP).toEqual({ price: "160", currency: "JPY" });
    expect(row.prices.VN).toEqual({ price: "24000", currency: "VND" });
  });

  it("leaves baseTerritory + all prices blank when there's no schedule at all", () => {
    const plan = buildExportPlan([source({ priceSchedule: null })]);
    expect(plan.rows[0].baseTerritory).toBeNull();
    expect(plan.rows[0].prices).toEqual({});
    expect(plan.territories).toEqual([]);
  });

  it("converts Base Country from alpha-3 to alpha-2", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: schedule([entry({ territory: "USA" })], "USA") }),
    ]);
    expect(plan.rows[0].baseTerritory).toBe("US");
  });
});

describe("buildExportPlan — territory selection (Export options dialog)", () => {
  const twoTerritorySources = [
    source({
      priceSchedule: schedule(
        [
          entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
          entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
        ],
        "USA",
      ),
    }),
  ];

  it("no selection (absent) → unchanged: every priced territory", () => {
    const plan = buildExportPlan(twoTerritorySources);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("empty selection ([]) is treated as 'no filter' too", () => {
    const plan = buildExportPlan(twoTerritorySources, []);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("a subset selection (alpha-2 codes) narrows to exactly the intersection", () => {
    const plan = buildExportPlan(twoTerritorySources, ["US"]);
    expect(plan.territories).toEqual(["US"]);
  });

  /**
   * ⚠ THIS TEST WAS INVERTED BY [Q-EXPORT.all-selected-territories], and it is
   * the one place in this file where an assertion changed rather than a
   * fixture.
   *
   * It used to read "a selected territory no item actually has a price for →
   * no column, no crash" and assert `["US"]` — pinning the behaviour the
   * Manager reported as the bug. A country asked about in Step 2 vanished from
   * the file instead of being answered, and nothing said it had.
   *
   * The old name shows how the defect stayed invisible: dropping the column
   * genuinely does not crash, so "no crash" read as the desirable half and
   * "no column" travelled along as though it were the same finding.
   */
  it("⚠ MUTATION (e) — a selected territory with no price still gets a COLUMN", () => {
    const plan = buildExportPlan(twoTerritorySources, ["US", "DE"]);
    // DE is in the ask, so DE is in the answer. What goes in the cell is E5's
    // job ("—" for "Apple does not sell here"); what matters here is that the
    // question is not silently deleted.
    expect(plan.territories).toEqual(["DE", "US"]);
  });

  it("⚠ MUTATION (e) — the selection is the column set, even when NOTHING is priced", () => {
    // The degenerate case the intersection made unreachable: pick three
    // countries none of which has a price and the old code produced an export
    // with no price columns at all.
    const plan = buildExportPlan(twoTerritorySources, ["FR", "DE", "JP"]);
    expect(plan.territories).toEqual(["DE", "FR", "JP"]);
  });

  it("a duplicated code in the request body renders one column, not two", () => {
    // The selection now flows through to the columns directly, so a client
    // sending the same code twice would have rendered it twice.
    const plan = buildExportPlan(twoTerritorySources, ["US", "US", "DE"]);
    expect(plan.territories).toEqual(["DE", "US"]);
  });

  it("does not affect Base Country, localization groups, or fixed columns", () => {
    const withLoc = [
      source({
        productId: "sku-1",
        skuName: "Item One",
        status: "APPROVED",
        priceSchedule: schedule(
          [
            entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
            entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
          ],
          "USA",
        ),
        localizations: [{ locale: "en-US", displayName: "Item One", description: "Desc" }],
      }),
    ];
    const unfiltered = buildExportPlan(withLoc);
    const filtered = buildExportPlan(withLoc, ["US"]);
    expect(filtered.localizationGroupCount).toBe(unfiltered.localizationGroupCount);
    expect(filtered.rows[0].productId).toBe(unfiltered.rows[0].productId);
    expect(filtered.rows[0].skuName).toBe(unfiltered.rows[0].skuName);
    expect(filtered.rows[0].status).toBe(unfiltered.rows[0].status);
    expect(filtered.rows[0].baseTerritory).toBe(unfiltered.rows[0].baseTerritory);
    expect(filtered.rows[0].localizations).toEqual(unfiltered.rows[0].localizations);
    expect(filtered.rows[0].prices).toEqual(unfiltered.rows[0].prices);
  });
});

describe("buildExportPlan — localization groups", () => {
  it("group count is the max localization count across all rows", () => {
    const plan = buildExportPlan([
      source({
        localizations: [
          { locale: "en-US", displayName: "A", description: "Desc A" },
          { locale: "ja", displayName: "A ja", description: "Desc ja" },
        ],
      }),
      source({ localizations: [{ locale: "en-US", displayName: "B", description: "Desc B" }] }),
    ]);
    expect(plan.localizationGroupCount).toBe(2);
  });

  it("fills each row's localizations left-to-right, positionally", () => {
    const plan = buildExportPlan([
      source({
        localizations: [
          { locale: "en-US", displayName: "A", description: "Desc A" },
          { locale: "vi", displayName: "A vi", description: "Mo ta" },
        ],
      }),
    ]);
    expect(plan.rows[0].localizations).toEqual([
      { locale: "en-US", displayName: "A", description: "Desc A" },
      { locale: "vi", displayName: "A vi", description: "Mo ta" },
    ]);
  });
});

describe("buildExportPlan — fixed columns", () => {
  it("SKU Name is the reference name, not a localized display name", () => {
    const plan = buildExportPlan([
      source({
        skuName: "Internal Reference Name",
        localizations: [{ locale: "en-US", displayName: "Storefront Display Name", description: "" }],
      }),
    ]);
    expect(plan.rows[0].skuName).toBe("Internal Reference Name");
  });

  it("Status is the raw Apple state string — no 2-state collapse", () => {
    const plan = buildExportPlan([
      source({ status: "MISSING_METADATA" }),
      source({ status: "REMOVED_FROM_SALE" }),
      source({ status: "APPROVED" }),
    ]);
    expect(plan.rows.map((r) => r.status)).toEqual([
      "MISSING_METADATA",
      "REMOVED_FROM_SALE",
      "APPROVED",
    ]);
  });
});

describe("buildExportWorkbook — file structure", () => {
  it("emits a two-row merged header (4 fixed cols) + one data row per IAP", () => {
    const plan = buildExportPlan([
      source({
        productId: "sku-1",
        skuName: "Item One",
        status: "APPROVED",
        priceSchedule: schedule([entry({ territory: "USA", customerPrice: "0.99", currency: "USD" })], "USA"),
        localizations: [{ locale: "en-US", displayName: "Item One", description: "Desc" }],
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];

    expect(aoa[0]).toEqual(["Product ID", "SKU Name", "Status", "Base Country", "Price in US", null, "Localization 1", null, null]);
    expect(aoa[1]).toEqual([null, null, null, null, "Price", "Currency", "Locale", "Display Name", "Description"]);
    expect(aoa.length).toBe(3); // 2 header rows + 1 data row
    expect(aoa[2]).toEqual(["sku-1", "Item One", "APPROVED", "US", "0.99", "USD", "en-US", "Item One", "Desc"]);
  });

  it("merges the 4 fixed columns vertically, territory groups 2-wide, localization groups 3-wide", () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: schedule(
          [
            entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
            entry({ territory: "JPN", customerPrice: "160", currency: "JPY" }),
          ],
          "USA",
        ),
        localizations: [{ locale: "en-US", displayName: "A", description: "Desc" }],
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const merges = ws["!merges"] ?? [];

    // Fixed columns: A1:A2 .. D1:D2.
    for (let c = 0; c < 4; c += 1) {
      expect(merges).toContainEqual({ s: { r: 0, c }, e: { r: 1, c } });
    }
    // Territory group headers: E1:F1 (JP), G1:H1 (US) — alphabetical.
    expect(merges).toContainEqual({ s: { r: 0, c: 4 }, e: { r: 0, c: 5 } });
    expect(merges).toContainEqual({ s: { r: 0, c: 6 }, e: { r: 0, c: 7 } });
    // Localization group header (3-wide): I1:K1.
    expect(merges).toContainEqual({ s: { r: 0, c: 8 }, e: { r: 0, c: 10 } });
  });

  it("leaves unused territory/localization slots blank on a given row", () => {
    const plan = buildExportPlan([
      source({
        productId: "a",
        priceSchedule: schedule([entry({ territory: "USA", customerPrice: "0.99", currency: "USD" })], "USA"),
        localizations: [{ locale: "en-US", displayName: "A", description: "Desc" }],
      }),
      source({ productId: "b", status: "MISSING_METADATA", priceSchedule: null, localizations: [] }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];
    const rowB = aoa[3];
    expect(rowB).toEqual(["b", "Item", "MISSING_METADATA", null, null, null, null, null, null]);
  });

  it("handles an empty IAP list (no territories, no localization groups)", () => {
    const plan = buildExportPlan([]);
    expect(plan.territories).toEqual([]);
    expect(plan.localizationGroupCount).toBe(0);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
    expect(aoa[0]).toEqual(["Product ID", "SKU Name", "Status", "Base Country"]);
    expect(aoa.length).toBe(2);
  });
});

describe("xlsxExportFilename", () => {
  it("emits the Apple-IAP-export-<appRef>-<YYYYMMDD> convention", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    expect(xlsxExportFilename("1234567890", now)).toBe("Apple-IAP-export-1234567890-20260706.xlsx");
  });

  it("sanitises unsafe filename characters", () => {
    const now = new Date(2026, 6, 6);
    expect(xlsxExportFilename("com/bad name", now)).toMatch(/^Apple-IAP-export-com_bad_name-20260706\.xlsx$/);
  });
});

/**
 * The failure sheet, and the promise that a clean export is unchanged.
 */
describe("buildExportWorkbook — the Export Failures sheet", () => {
  const partial = (kind: "RATE_LIMITED" | "APPLE_ERROR" | "UNKNOWN", status?: number) =>
    source({
      appleIapId: "apple-p",
      productId: "com.x.partial",
      priceReadFailure: { kind, status, message: "boom" },
    });

  it("⚠ a CLEAN export is a ONE-SHEET workbook — unchanged from before this feature", () => {
    const wb = buildExportWorkbook(buildExportPlan([source({})]));
    expect(wb.SheetNames).toEqual(["Apple IAP Export"]);
  });

  it("a clean export has NO note row — the header is still the first row", () => {
    const wb = buildExportWorkbook(buildExportPlan([source({})]));
    const ws = wb.Sheets["Apple IAP Export"];
    // A1 is the first fixed column header, exactly as before.
    expect(ws["A1"].v).toBe("Product ID");
    // and the two-row header merge still starts at row 0
    expect(ws["!merges"]?.[0]).toEqual({ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } });
  });

  it("the failure sheet appears only when there is something to report", () => {
    const wb = buildExportWorkbook(buildExportPlan([partial("RATE_LIMITED", 429)]));
    expect(wb.SheetNames).toEqual(["Apple IAP Export", "Export Failures"]);
  });

  it("a PARTIAL row is in BOTH sheets — it exported, and its blanks have a reason", () => {
    const plan = buildExportPlan([partial("RATE_LIMITED", 429)]);
    const rows = buildFailureRows(plan.rows, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: "com.x.partial",
      appleIapId: "apple-p",
      status: "PARTIAL",
      kind: "RATE_LIMITED",
    });
    // and it is still a data row in the main sheet
    expect(plan.rows.map((r) => r.productId)).toContain("com.x.partial");
  });

  it("⚠ RATE_LIMITED and APPLE_ERROR never share wording", () => {
    const rl = buildFailureRows([], [
      { productId: "p1", appleIapId: "a1", kind: "RATE_LIMITED", error: "429: slow" },
    ])[0];
    const ae = buildFailureRows([], [
      { productId: "p2", appleIapId: "a2", kind: "APPLE_ERROR", error: "404: gone" },
    ])[0];
    expect(rl.kind).not.toBe(ae.kind);
    expect(rl.detail).not.toBe(ae.detail);
    expect(rl.detail).toContain("rate-limited");
    expect(ae.detail).not.toContain("rate-limited");
  });

  it("NOT_ATTEMPTED says it is safe to re-export — the only bucket for which that is true", () => {
    const [row] = buildFailureRows([], [
      { productId: "p3", appleIapId: "a3", kind: "NOT_ATTEMPTED", error: "stopped" },
    ]);
    expect(row.status).toBe("NOT_ATTEMPTED");
    expect(row.detail).toContain("Safe to re-export");
    // and no other kind claims that
    const [rl] = buildFailureRows([], [
      { productId: "p4", appleIapId: "a4", kind: "RATE_LIMITED", error: "429" },
    ]);
    expect(rl.detail).not.toContain("Safe to re-export");
  });

  it("the failure sheet counts NOT_ATTEMPTED rows one per real item — no theoretical estimates", () => {
    const failures = ["a", "b", "c"].map((id) => ({
      productId: `com.x.${id}`,
      appleIapId: id,
      kind: "NOT_ATTEMPTED" as const,
      error: "stopped",
    }));
    const wb = buildExportWorkbook(buildExportPlan([source({})]), failures);
    const ws = wb.Sheets["Export Failures"];
    // header + 3 rows
    expect(ws["!ref"]).toBeDefined();
    expect(XLSX.utils.sheet_to_json(ws, { header: 1 })).toHaveLength(4);
  });

  it("the main sheet gains a note row ONLY when a PARTIAL row exists, and merges shift with it", () => {
    const wb = buildExportWorkbook(buildExportPlan([partial("RATE_LIMITED", 429)]));
    const ws = wb.Sheets["Apple IAP Export"];
    expect(String(ws["A1"].v)).toContain("incomplete");
    expect(String(ws["A1"].v)).toContain("Export Failures");
    // header moved down one row, and the merge moved with it
    expect(ws["A2"].v).toBe("Product ID");
    expect(ws["!merges"]?.[0]).toEqual({ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } });
  });

  it("INCOMPLETE_PRICES renders its own reason, distinct from every other kind", () => {
    const rows = buildFailureRows(
      buildExportPlan([
        source({
          appleIapId: "apple-i",
          productId: "com.x.incomplete",
          priceReadFailure: {
            kind: "INCOMPLETE_PRICES",
            incompleteReason: "COUNT_MISMATCH",
            message: "collected 170 of 175 prices",
          },
        }),
      ]).rows,
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PARTIAL", kind: "INCOMPLETE_PRICES" });
    expect(rows[0].detail).toContain("COUNT_MISMATCH");
    expect(rows[0].detail).toContain("170 of 175");
    // ⚠ and it never borrows another kind's wording
    expect(rows[0].detail).not.toContain("rate-limited");
    expect(rows[0].detail).not.toContain("Apple returned");
  });

  it("PAGE_CAP and COUNT_MISMATCH are told apart in the sheet", () => {
    const mk = (reason: "PAGE_CAP" | "COUNT_MISMATCH") =>
      buildFailureRows(
        buildExportPlan([
          source({
            priceReadFailure: { kind: "INCOMPLETE_PRICES", incompleteReason: reason, message: "m" },
          }),
        ]).rows,
        [],
      )[0];
    expect(mk("PAGE_CAP").detail).toContain("PAGE_CAP");
    expect(mk("COUNT_MISMATCH").detail).toContain("COUNT_MISMATCH");
    expect(mk("PAGE_CAP").detail).not.toBe(mk("COUNT_MISMATCH").detail);
  });

  it("a FAILED-only export gets the failure sheet but NO note row (no partial rows)", () => {
    const wb = buildExportWorkbook(buildExportPlan([source({})]), [
      { productId: "p", appleIapId: "a", kind: "APPLE_ERROR", error: "404: gone" },
    ]);
    expect(wb.SheetNames).toEqual(["Apple IAP Export", "Export Failures"]);
    expect(wb.Sheets["Apple IAP Export"]["A1"].v).toBe("Product ID");
  });
});
