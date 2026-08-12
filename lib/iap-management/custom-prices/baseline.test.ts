/**
 * Baseline table assembly — the ~175-row table, built from data we already have.
 *
 * The properties worth protecting:
 *   · the G4 startDate filter (a future change must never read as current)
 *   · provenance precedence, including the two weak claims
 *   · auto rows carry NO number — the tool cannot compute Apple's equalisation
 *   · J-6 import produces Apple's current value verbatim
 */
import { describe, it, expect } from "vitest";
import {
  assembleBaselineRows,
  baselineCounts,
  effectiveNowManualPrices,
  importableManualRows,
  manualRowToCustomEntry,
  matchesBaselineQuery,
  provenanceLabel,
  EXISTING_MANUAL_WARNING,
} from "./baseline";

const TERRITORIES = [
  { code: "USA", name: "United States", currency: "USD" },
  { code: "VNM", name: "Vietnam", currency: "VND" },
  { code: "JPN", name: "Japan", currency: "JPY" },
  { code: "BRA", name: "Brazil", currency: "BRL" },
  { code: "KAZ", name: "Kazakhstan", currency: "KZT" },
];

function assemble(over: Partial<Parameters<typeof assembleBaselineRows>[0]> = {}) {
  return assembleBaselineRows({
    territories: TERRITORIES,
    baseTerritory: "USA",
    basePrice: 9.99,
    templateEntries: [
      { territory_code: "VNM", customer_price: 24000, currency_code: "VND" },
      { territory_code: "JPN", customer_price: 1500, currency_code: "JPY" },
    ],
    existingManual: [
      { territory: "BRA", customerPrice: 29.9, currency: "BRL" },
    ],
    customPrices: [],
    ...over,
  });
}

// ─── The G4 filter ───────────────────────────────────────────────────────────

describe("effectiveNowManualPrices — the G4 startDate filter", () => {
  it("⚠ drops future-dated entries: a scheduled change must NOT read as current", () => {
    // Without this, J-6's import would adopt tomorrow's price as today's custom
    // and ship it to a live store from a read that looked correct.
    const out = effectiveNowManualPrices([
      { territory: "VNM", startDate: null },
      { territory: "JPN", startDate: "2026-12-01" },
    ]);
    expect(out.map((e) => e.territory)).toEqual(["VNM"]);
  });

  it("keeps the first effective-now entry per territory", () => {
    const out = effectiveNowManualPrices([
      { territory: "VNM", startDate: null },
      { territory: "VNM", startDate: null },
    ]);
    expect(out).toHaveLength(1);
  });

  it("a schedule of only future changes yields nothing current", () => {
    expect(
      effectiveNowManualPrices([{ territory: "VNM", startDate: "2027-01-01" }]),
    ).toEqual([]);
  });

  it("assembled rows never show a future-dated price as current", () => {
    const manual = effectiveNowManualPrices([
      { territory: "VNM", startDate: "2026-12-01", customerPrice: 99000, currency: "VND" },
    ]).map((e) => ({
      territory: e.territory,
      customerPrice: e.customerPrice,
      currency: e.currency,
    }));
    const rows = assemble({ existingManual: manual });
    const vnm = rows.find((r) => r.territory_code === "VNM")!;
    // Falls through to the template, NOT to the future price.
    expect(vnm.provenance).toBe("template");
    expect(vnm.current_price).toBe(24000);
  });
});

// ─── Provenance ──────────────────────────────────────────────────────────────

describe("provenance precedence", () => {
  const rows = assemble();
  const byCode = (c: string) => rows.find((r) => r.territory_code === c)!;

  it("base territory → base, read-only, and never carries a custom", () => {
    const usa = byCode("USA");
    expect(usa.provenance).toBe("base");
    expect(usa.is_base).toBe(true);
    expect(usa.current_price).toBe(9.99);
    expect(usa.custom_price).toBeNull();
  });

  it("a live Apple price outranks the template — it is what Apple charges today", () => {
    expect(byCode("BRA").provenance).toBe("existing-manual");
    expect(byCode("BRA").current_price).toBe(29.9);
  });

  it("a template entry → template (a CLAIM, so labelled unverified)", () => {
    expect(byCode("VNM").provenance).toBe("template");
    expect(provenanceLabel("template")).toBe("template · unverified");
  });

  it("⚠ an auto territory carries NO number — the tool cannot compute Apple's equalisation", () => {
    const kaz = byCode("KAZ");
    expect(kaz.provenance).toBe("auto");
    expect(kaz.current_price).toBeNull();
  });

  it("even a base row with no known base price shows null, not a guess", () => {
    const rows2 = assemble({ basePrice: null });
    expect(rows2.find((r) => r.territory_code === "USA")!.current_price).toBeNull();
  });

  it("a custom does not change the row's provenance — the dialog shows both", () => {
    const rows2 = assemble({
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });
    const vnm = rows2.find((r) => r.territory_code === "VNM")!;
    expect(vnm.provenance).toBe("template");
    expect(vnm.current_price).toBe(24000);
    expect(vnm.custom_price).toBe(25000);
  });

  it("emits one row per Apple territory", () => {
    expect(assemble()).toHaveLength(TERRITORIES.length);
  });

  it("currency falls back template → manual → catalog, and stays null when unknown", () => {
    const rows2 = assembleBaselineRows({
      territories: [{ code: "XXX", name: "Nowhere", currency: null }],
      baseTerritory: "USA",
      templateEntries: [],
      existingManual: [],
      customPrices: [],
    });
    expect(rows2[0].currency_code).toBeNull();
  });
});

// ─── J-6 import ──────────────────────────────────────────────────────────────

describe("J-6 — importing existing Apple prices as customs", () => {
  it("importable = effective-now manual rows without a custom, excluding base", () => {
    const rows = assemble();
    expect(importableManualRows(rows).map((r) => r.territory_code)).toEqual(["BRA"]);
  });

  it("a row that already has a custom is not importable again", () => {
    const rows = assemble({
      customPrices: [
        { territory_code: "BRA", customer_price: 24.9, currency_code: "BRL" },
      ],
    });
    expect(importableManualRows(rows)).toEqual([]);
  });

  it("the imported value is Apple's CURRENT price verbatim", () => {
    // Changing it would defeat the purpose: the point is that the price the
    // store charges today survives the replace-all push.
    const rows = assemble();
    const entry = manualRowToCustomEntry(rows.find((r) => r.territory_code === "BRA")!);
    expect(entry).toEqual({
      territory_code: "BRA",
      customer_price: 29.9,
      currency_code: "BRL",
    });
  });

  it("refuses to import a template row, an auto row, or the base row", () => {
    const rows = assemble();
    expect(manualRowToCustomEntry(rows.find((r) => r.territory_code === "VNM")!)).toBeNull();
    expect(manualRowToCustomEntry(rows.find((r) => r.territory_code === "KAZ")!)).toBeNull();
    expect(manualRowToCustomEntry(rows.find((r) => r.territory_code === "USA")!)).toBeNull();
  });

  it("refuses rather than inventing a currency when none is known", () => {
    const rows = assembleBaselineRows({
      territories: [{ code: "BRA", name: "Brazil", currency: null }],
      baseTerritory: "USA",
      templateEntries: [],
      existingManual: [{ territory: "BRA", customerPrice: 29.9, currency: null }],
      customPrices: [],
    });
    expect(manualRowToCustomEntry(rows[0])).toBeNull();
  });

  it("states the replace-all consequence in the warning the row renders", () => {
    // The wording is asserted because it is the single most important sentence
    // the dialog says (§G5): without it, showing the price would imply it is safe.
    expect(EXISTING_MANUAL_WARNING).toMatch(/revert to auto/i);
    expect(EXISTING_MANUAL_WARNING).toMatch(/next push/i);
    expect(EXISTING_MANUAL_WARNING).toMatch(/custom/i);
  });
});

// ─── §I.3 withdrawn price points ─────────────────────────────────────────────

describe("§I.3 — a stored custom Apple no longer offers", () => {
  it("flags only territories that were actually checked", () => {
    const rows = assemble({
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
        { territory_code: "JPN", customer_price: 1200, currency_code: "JPY" },
      ],
      unavailableCustomTerritories: ["VNM"],
    });
    expect(rows.find((r) => r.territory_code === "VNM")!.custom_unavailable).toBe(true);
    // Never claims a clean bill of health for an unchecked row.
    expect(rows.find((r) => r.territory_code === "JPN")!.custom_unavailable).toBe(false);
  });

  it("does not flag a territory with no custom", () => {
    const rows = assemble({ unavailableCustomTerritories: ["KAZ"] });
    expect(rows.find((r) => r.territory_code === "KAZ")!.custom_unavailable).toBe(false);
  });
});

// ─── Filtering + counts ──────────────────────────────────────────────────────

describe("search + counts", () => {
  const rows = assemble({
    customPrices: [
      { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
    ],
  });

  it("matches on name, alpha-3 code and currency", () => {
    const vnm = rows.find((r) => r.territory_code === "VNM")!;
    expect(matchesBaselineQuery(vnm, "viet")).toBe(true);
    expect(matchesBaselineQuery(vnm, "vnm")).toBe(true);
    expect(matchesBaselineQuery(vnm, "vnd")).toBe(true);
    expect(matchesBaselineQuery(vnm, "japan")).toBe(false);
    expect(matchesBaselineQuery(vnm, "  ")).toBe(true);
  });

  it("counts customised / importable / unavailable", () => {
    expect(baselineCounts(rows)).toEqual({
      total: 5,
      customised: 1,
      importable: 1,
      unavailable: 0,
    });
  });
});
