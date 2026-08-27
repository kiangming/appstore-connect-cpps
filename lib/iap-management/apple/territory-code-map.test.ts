/**
 * E2b — Kosovo, and the boundary that makes it work.
 *
 * The defect: Apple prices Kosovo under `XKS`; the shared territory picker
 * calls it `XK` (Play Console's code, and the one `TERRITORY_CATALOG`
 * carries). `alpha3ToAlpha2("XKS")` is undefined — ISO 3166-1 has no Kosovo
 * assignment at all — so the shipped fallback kept `"XKS"` as the price key
 * while the Manager's selection said `"XK"`. Tickable in the dialog, never a
 * column, whatever Apple charged there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  toAppleCode,
  toCatalogCode,
  __APPLE_CODE_OVERRIDES,
} from "./territory-code-map";
import { buildExportPlan, type ExportSource } from "@/lib/iap-management/xlsx-export";
import type { PriceScheduleEntry } from "@/lib/iap-management/queries/iap-detail";

describe("⚠ Kosovo crosses the boundary in both directions", () => {
  it("Apple's XKS becomes the catalog's XK", () => {
    expect(toCatalogCode("XKS")).toBe("XK");
  });

  it("and XK goes back to XKS — the header needs Apple's code to find a name", () => {
    expect(toAppleCode("XK")).toBe("XKS");
  });

  it("the round trip is stable in both directions", () => {
    expect(toAppleCode(toCatalogCode("XKS"))).toBe("XKS");
    expect(toCatalogCode(toAppleCode("XK"))).toBe("XK");
  });
});

describe("no other territory is disturbed", () => {
  it.each([
    ["USA", "US"],
    ["VNM", "VN"],
    ["THA", "TH"],
    ["HKG", "HK"],
    ["TWN", "TW"],
    ["MAC", "MO"],
    ["DEU", "DE"],
    ["GBR", "GB"],
  ])("%s → %s", (apple, catalog) => {
    expect(toCatalogCode(apple)).toBe(catalog);
    expect(toAppleCode(catalog)).toBe(apple);
  });

  it("⚠ ALL 175 of Apple's codes convert to 175 DISTINCT codes", () => {
    // A collision would silently merge two markets into one column — the same
    // class of loss as the drop this module fixes, arriving as a wrong number
    // instead of a missing one.
    const APPLE = APPLE_TERRITORIES;
    const mapped = APPLE.map(toCatalogCode);
    expect(new Set(mapped).size).toBe(APPLE.length);
  });

  it("⚠ every one of the 175 produces a NON-EMPTY code", () => {
    for (const code of APPLE_TERRITORIES) {
      expect(toCatalogCode(code), `${code} mapped to empty`).toBeTruthy();
    }
  });

  it("an unknown code keeps itself rather than vanishing", () => {
    // A market we cannot name is still a market with a price.
    expect(toCatalogCode("ZZZ")).toBe("ZZZ");
    expect(toAppleCode("ZZ")).toBe("ZZ");
  });

  it("⚠ the override table stays tiny — one entry, and it is Kosovo", () => {
    // The guard against this becoming a dumping ground for naming preferences.
    // A second entry is legitimate only if ISO has no assignment for it either.
    expect(Object.keys(__APPLE_CODE_OVERRIDES)).toEqual(["XKS"]);
  });
});

// ─── The defect, end to end through buildExportPlan ────────────────────────

const entry = (over: Partial<PriceScheduleEntry>): PriceScheduleEntry => ({
  priceId: "p",
  startDate: null,
  endDate: null,
  territory: "USA",
  customerPrice: "0.99",
  currency: "USD",
  manual: true,
  ...over,
});

const source = (entries: PriceScheduleEntry[]): ExportSource =>
  ({
    productId: "sku-1",
    skuName: "Item One",
    status: "APPROVED",
    localizations: [],
    priceSchedule: { baseTerritory: "USA", basePrice: null, entries },
  }) as unknown as ExportSource;

describe("⚠ MUTATION — drop the normalization and Kosovo disappears again", () => {
  const sources = [
    source([
      entry({ territory: "USA", customerPrice: "0.99" }),
      // Apple prices Kosovo under XKS.
      entry({ priceId: "p2", territory: "XKS", customerPrice: "0.99", currency: "EUR" }),
    ]),
  ];

  it("selecting Kosovo (XK) yields a Kosovo COLUMN carrying Apple's XKS price", () => {
    const plan = buildExportPlan(sources, ["US", "XK"]);
    expect(plan.territories).toEqual(["US", "XK"]);
    // ⚠ The price must have landed under the SAME key the selection used —
    // this is the assertion the un-normalized code fails, because the price
    // sits under "XKS" and the column looks for "XK".
    expect(plan.rows[0].prices["XK"]).toEqual({ price: "0.99", currency: "EUR" });
  });

  it("Kosovo's price is not left stranded under the raw Apple code", () => {
    const plan = buildExportPlan(sources, ["US", "XK"]);
    expect(plan.rows[0].prices["XKS"]).toBeUndefined();
  });

  it("with no selection at all, Kosovo still appears under the catalog code", () => {
    const plan = buildExportPlan(sources);
    expect(plan.territories).toEqual(["US", "XK"]);
  });
});

// ─── The fence: Apple-only, never imported by Google ───────────────────────

describe("⚠ this map belongs to the Apple boundary alone", () => {
  it("no file under google-iap-management imports it", () => {
    // The whole reason the map exists is that Google needs XK while Apple
    // needs XKS. A Google file importing this would be translating Kosovo out
    // of the code Play Console actually wants.
    const root = process.cwd();
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir))) {
        const rel = `${dir}/${e}`;
        if (statSync(join(root, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(e)) continue;
        if (readFileSync(join(root, rel), "utf8").includes("territory-code-map")) {
          hits.push(rel);
        }
      }
    };
    for (const top of [
      "lib/google-iap-management",
      "app/api/google-iap-management",
      "components/google-iap-management",
    ]) {
      try {
        walk(top);
      } catch {
        /* optional */
      }
    }
    expect(hits).toEqual([]);
  });

  it("TERRITORY_CATALOG still carries XK, untouched", () => {
    // Google's region bucketing (region-continent.ts) lists XK. If a later
    // change "fixes" the catalog to XKS to suit Apple, this fails — and that
    // is the point: the catalog is shared, the mismatch is Apple's alone.
    const catalog = readFileSync(
      join(process.cwd(), "lib/iap-management/territory-catalog.ts"),
      "utf8",
    );
    expect(catalog).toContain('code: "XK"');
    expect(catalog).not.toContain('code: "XKS"');
  });
});

/** Apple's live territory list, 2026-08-27 probe (`/v1/territories`, 175). */
const APPLE_TERRITORIES = `AFG AGO AIA ALB ARE ARG ARM ATG AUS AUT AZE BEL BEN BFA BGR BHR BHS BIH BLR
BLZ BMU BOL BRA BRB BRN BTN BWA CAN CHE CHL CHN CIV CMR COD COG COL CPV CRI CYM
CYP CZE DEU DMA DNK DOM DZA ECU EGY ESP EST FIN FJI FRA FSM GAB GBR GEO GHA GMB
GNB GRC GRD GTM GUY HKG HND HRV HUN IDN IND IRL IRQ ISL ISR ITA JAM JOR JPN KAZ
KEN KGZ KHM KNA KOR KWT LAO LBN LBR LBY LCA LKA LTU LUX LVA MAC MAR MDA MDG MDV
MEX MKD MLI MLT MMR MNE MNG MOZ MRT MSR MUS MWI MYS NAM NER NGA NIC NLD NOR NPL
NRU NZL OMN PAK PAN PER PHL PLW PNG POL PRT PRY QAT ROU RUS RWA SAU SEN SGP SLB
SLE SLV SRB STP SUR SVK SVN SWE SWZ SYC TCA TCD THA TJK TKM TON TTO TUN TUR TWN
TZA UGA UKR URY USA UZB VCT VEN VGB VNM VUT XKS YEM ZAF ZMB ZWE`
  .split(/\s+/)
  .filter(Boolean);
