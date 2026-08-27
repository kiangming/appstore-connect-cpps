/**
 * E3.1 — column order, and E3.2's rule for what the fill may claim.
 *
 * MUTATION (c): shuffling manual-first must FAIL.
 * MUTATION (i), column half: classifying a column from anything other than
 * `manual === true` on some row must FAIL.
 */
import { describe, it, expect } from "vitest";
import { toCatalogCode } from "./apple/territory-code-map";
import {
  orderTerritoryColumns,
  columnDisplayName,
  columnHeaderLabel,
  type ColumnOrderRow,
} from "./export-column-order";

const row = (
  base: string | null,
  prices: Record<string, boolean | null>,
): ColumnOrderRow => ({
  baseTerritory: base,
  prices: Object.fromEntries(
    Object.entries(prices).map(([k, manual]) => [k, { manual }]),
  ),
});

const codes = (rows: ColumnOrderRow[], t: string[]) =>
  orderTerritoryColumns(rows, t).map((c) => c.code);

describe("⚠ MUTATION (c) — manual columns come first, auto after", () => {
  it("splits the two groups and keeps manual on the left", () => {
    const rows = [row("US", { US: true, TH: true, JP: false, DE: false })];
    // US first (base, manual) · Thailand (manual) · then the auto pair,
    // alphabetical by NAME: Germany, Japan.
    expect(codes(rows, ["DE", "JP", "TH", "US"])).toEqual(["US", "TH", "DE", "JP"]);
  });

  it("the base territory heads the manual group even when its name sorts last", () => {
    // "United States" sorts after "Thailand" alphabetically. Base wins anyway:
    // it is the price every other territory is equalized FROM.
    const rows = [row("US", { US: true, TH: true, AU: true })];
    expect(codes(rows, ["AU", "TH", "US"])).toEqual(["US", "AU", "TH"]);
  });

  it("⚠ sorts by DISPLAY NAME, not by code", () => {
    // By code: TH < TW. By name: Taiwan < Thailand. The header shows names, so
    // a code sort renders as visibly out of order.
    expect(columnDisplayName("TW")).toBe("Taiwan");
    expect(columnDisplayName("TH")).toBe("Thailand");
    const rows = [row(null, { TH: true, TW: true })];
    expect(codes(rows, ["TH", "TW"])).toEqual(["TW", "TH"]);
  });

  it("auto columns are alphabetical by name among themselves", () => {
    const rows = [row("US", { US: true, VN: false, TH: false, JP: false })];
    expect(codes(rows, ["JP", "TH", "US", "VN"])).toEqual(["US", "JP", "TH", "VN"]);
  });
});

describe("⚠ RULE α — one manual item is enough to make the column manual", () => {
  it("a column manual on ONE item of many is in the manual group", () => {
    // The mixed case the fill exists for. The column is navigation; the cells
    // still tell the truth individually.
    const rows = [
      row("US", { US: true, TH: false }),
      row("US", { US: true, TH: true }), // only this item priced TH by hand
      row("US", { US: true, TH: false }),
    ];
    expect(codes(rows, ["TH", "US"])).toEqual(["US", "TH"]);
  });

  it("⚠ NOT first-item: reordering the rows does not move a column", () => {
    // first-item is a sample of n=1 and depends on row order, so the same app
    // exported twice with a different sort could group columns differently —
    // two files of one dataset that cannot be compared.
    const a = row("US", { US: true, TH: false });
    const b = row("US", { US: true, TH: true });
    expect(codes([a, b], ["TH", "US"])).toEqual(codes([b, a], ["TH", "US"]));
  });

  it("⚠ NOT majority: one manual item out of twenty still counts", () => {
    const rows = [
      row("US", { US: true, TH: true }),
      ...Array.from({ length: 19 }, () => row("US", { US: true, TH: false })),
    ];
    expect(codes(rows, ["TH", "US"])).toEqual(["US", "TH"]);
  });

  it("⚠ `null` does NOT promote a column into the manual group", () => {
    // Apple said nothing. That is not "a human chose this".
    const rows = [row(null, { TH: null, US: null })];
    expect(orderTerritoryColumns(rows, ["TH", "US"]).map((c) => c.group)).toEqual([
      "auto",
      "auto",
    ]);
  });

  it("a column NOBODY prices lands in the auto group, and still exists", () => {
    // The Manager selected a country Apple does not sell in. Nobody set it by
    // hand, so it is not manual; its cells will read "—" (E5).
    const rows = [row("US", { US: true })];
    const cols = orderTerritoryColumns(rows, ["US", "ZW"]);
    expect(cols.map((c) => c.code)).toEqual(["US", "ZW"]);
    expect(cols[1].group).toBe("auto");
  });
});

describe("the order is TOTAL — never left to row order", () => {
  it("two unnameable codes still sort deterministically, by code", () => {
    // Both fall back to their raw code as a name, so the name comparison ties
    // and the code tiebreak decides. Without it the engine's sort stability
    // would hand the decision back to input order — the instability α exists
    // to remove.
    const rows = [row(null, { ZZA: false, ZZB: false })];
    expect(codes(rows, ["ZZB", "ZZA"])).toEqual(["ZZA", "ZZB"]);
    expect(codes(rows, ["ZZA", "ZZB"])).toEqual(["ZZA", "ZZB"]);
  });

  it("multiple base territories all sit at the head of the manual group", () => {
    // Rows can disagree about their base; both are still the number a reader
    // checks first for their own item.
    const rows = [
      row("US", { US: true, JP: true, TH: true }),
      row("JP", { US: true, JP: true, TH: true }),
    ];
    const cols = orderTerritoryColumns(rows, ["JP", "TH", "US"]);
    expect(cols.slice(0, 2).map((c) => c.code)).toEqual(["JP", "US"]);
    expect(cols[2].code).toBe("TH");
  });

  it("Kosovo resolves through the Apple-code map for its name", () => {
    // The column is XK; only XKS can be looked up. Without the reverse map the
    // header would sort and render under a bare code.
    expect(columnDisplayName("US")).toBe("United States");
    expect(columnDisplayName("XK")).toBe("XKS");
  });
});

// ─── E4 — the header label ─────────────────────────────────────────────────

/** Apple's live territory list, 2026-08-27 probe (`/v1/territories`, 175). */
const APPLE_TERRITORIES = `AFG AGO AIA ALB ARE ARG ARM ATG AUS AUT AZE BEL BEN
BFA BGR BHR BHS BIH BLR BLZ BMU BOL BRA BRB BRN BTN BWA CAN CHE CHL CHN CIV CMR
COD COG COL CPV CRI CYM CYP CZE DEU DMA DNK DOM DZA ECU EGY ESP EST FIN FJI FRA
FSM GAB GBR GEO GHA GMB GNB GRC GRD GTM GUY HKG HND HRV HUN IDN IND IRL IRQ ISL
ISR ITA JAM JOR JPN KAZ KEN KGZ KHM KNA KOR KWT LAO LBN LBR LBY LCA LKA LTU LUX
LVA MAC MAR MDA MDG MDV MEX MKD MLI MLT MMR MNE MNG MOZ MRT MSR MUS MWI MYS NAM
NER NGA NIC NLD NOR NPL NRU NZL OMN PAK PAN PER PHL PLW PNG POL PRT PRY QAT ROU
RUS RWA SAU SEN SGP SLB SLE SLV SRB STP SUR SVK SVN SWE SWZ SYC TCA TCD THA TJK
TKM TON TTO TUN TUR TWN TZA UGA UKR URY USA UZB VCT VEN VGB VNM VUT XKS YEM ZAF
ZMB ZWE`
  .split(/\s+/)
  .filter(Boolean);

describe("⚠ MUTATION (d) — the header carries the FULL MARKET NAME", () => {
  it.each([
    ["TH", "Price in Thailand (TH)"],
    ["US", "Price in United States (US)"],
    // ⚠ "Vietnam", one word — the library's spelling, not the ISO long form
    // "Viet Nam". Written from memory first and caught here, which is P27 in
    // miniature: an expectation about a label is a claim about a source.
    ["VN", "Price in Vietnam (VN)"],
    ["MO", "Price in Macau (MO)"],
    ["TW", "Price in Taiwan (TW)"],
    ["CN", "Price in China mainland (CN)"],
  ])("%s → %s", (code, expected) => {
    // A bare "Price in TH" is the regression: the Manager reads market names,
    // not two-letter codes, and the code alone is what this replaced.
    expect(columnHeaderLabel(code)).toBe(expected);
  });

  it("⚠ the Apple-Connect overrides win over the ISO wording", () => {
    // territoryName's first tier. "Macao"/"Taiwan, Province of China" are what
    // ISO says; Apple's own pricing UI says otherwise, and the Manager is
    // comparing against Apple's UI.
    expect(columnHeaderLabel("MO")).toContain("Macau");
    expect(columnHeaderLabel("TW")).toContain("Taiwan (");
  });
});

describe("⚠ MUTATION — an unnameable territory must not repeat a code", () => {
  it("Kosovo renders `Price in XKS`, never `XKS (XK)` and never `XK (XK)`", () => {
    // ⚠ THE CHECK MUST COMPARE AGAINST BOTH CODES. Kosovo's column code is XK
    // while the fallback name is Apple's XKS: a naive `name === code` test
    // sees two different strings and lets "XKS" through as though it were a
    // name. Sweeping all 175 with that naive rule found ZERO shortened
    // headers — including this one.
    const label = columnHeaderLabel("XK");
    expect(label).toBe("Price in XKS");
    expect(label).not.toContain("(");
  });

  it("a wholly unknown code renders once, not twice", () => {
    expect(columnHeaderLabel("ZZZ")).toBe("Price in ZZZ");
  });

  it("⚠ EXACTLY ONE of Apple's 175 territories lacks a name", () => {
    // The sweep, pinned. If this ever reports more than Kosovo, territoryName
    // has a coverage hole that arrived with an Apple change — and the headers
    // for those markets silently became codes.
    const shortened = APPLE_TERRITORIES.map(toCatalogCode).filter(
      (c) => !columnHeaderLabel(c).includes("("),
    );
    expect(shortened).toEqual(["XK"]);
  });

  it("every one of the 175 produces a non-empty header", () => {
    for (const code of APPLE_TERRITORIES.map(toCatalogCode)) {
      expect(columnHeaderLabel(code).length).toBeGreaterThan("Price in ".length);
    }
  });
});
