/**
 * X1 (R3) — the territory column header in the item-list export.
 *
 * `Price in VN` became `Price in Vietnam (VN)`. Three separate claims are
 * pinned here, and they fail for three different reasons on purpose:
 *
 *   1. THE FORMAT — name, then the code in parentheses.
 *   2. THE FALLBACK — when there is no name, the parenthetical is DROPPED,
 *      never `Price in ZZ (ZZ)`.
 *   3. THE TRIPWIRE — how many of Google's REAL region codes take the
 *      fallback. Today: zero. A `toBeLessThan` here would let that rot
 *      silently, so the count is pinned exactly.
 *
 * ⚠ WHY A COUNT AND NOT JUST A SPOT CHECK. The fallback is invisible in a
 * finished file: `Price in XY` reads like a deliberate choice, not like a
 * name lookup that came back empty. Nobody would open a 173-column
 * spreadsheet and notice one header lost its country. The count is the only
 * thing that notices.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import * as XLSX from "xlsx";

import {
  buildExportPlan,
  buildExportWorkbook,
  territoryColumnHeader,
} from "./xlsx-export";
import { regionNameFromCode } from "./region-name";

/**
 * ⚠ THE 173 REGIONS GOOGLE PLAY ACTUALLY SELLS IN — measured, not invented.
 *
 * Provenance, so the next person can re-derive rather than trust:
 *   • Measurement M1, run by the Manager 2026-09-01 against production:
 *     `GET /api/google-iap-management/regions/catalog?packageName=<cached>`
 *     → 173 `{regionCode, currency}` entries, `regionsVersion: "2025/03"`.
 *     That route makes exactly one `monetization.convertRegionPrices` call
 *     (`google/regions-helper.ts:85`), which is Google's own canonical
 *     "every supported region" answer.
 *   • Census Q7 over `google_iap_mgmt.iap_prices` (308,933 price rows,
 *     1,794 IAPs) returned 173 distinct codes — and the two sets match
 *     100%, 0 codes differing in either direction.
 *   • Reconstructed here from the census arithmetic, which closes exactly:
 *     183 shared-catalog codes − 25 catalog-only + 15 Google-only = 173,
 *     and 158 + 25 = 183, 158 + 15 = 173.
 *
 * ⚠ THIS IS A TEST FIXTURE, NOT THE PRODUCTION CATALOG. It carries codes
 * only — M1 also returned a currency per region, which this chunk does not
 * need. Chunk X4 promotes the measurement to a real pinned snapshot module
 * (codes + currency + `regionsVersion` + the refresh command). When it does,
 * THIS ARRAY MUST BE DELETED and the snapshot imported instead — two copies
 * of a measured set is exactly the drift this arc exists to remove.
 *
 * ⚠ 183 IS NOT THIS LIST AND MUST NOT BE USED HERE. `TERRITORY_CATALOG`
 * (`lib/iap-management/territory-catalog.ts`) is a hand-typed constant in the
 * APPLE module; the Google export dialog reaches it only through an
 * unpassed default parameter, which is the R2 defect X4 removes.
 */
const GOOGLE_REGIONS_173: readonly string[] = [
  "AE", "AG", "AL", "AM", "AO", "AR", "AT", "AU", "AW", "AZ", "BA", "BD",
  "BE", "BF", "BG", "BH", "BJ", "BM", "BO", "BR", "BS", "BW", "BY", "BZ",
  "CA", "CD", "CF", "CG", "CH", "CI", "CL", "CM", "CO", "CR", "CV", "CY",
  "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "ER", "ES",
  "FI", "FJ", "FM", "FR", "GA", "GB", "GD", "GE", "GH", "GI", "GM", "GN",
  "GR", "GT", "GW", "HK", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IN",
  "IQ", "IS", "IT", "JM", "JO", "JP", "KE", "KG", "KH", "KM", "KN", "KR",
  "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LT", "LU", "LV",
  "LY", "MA", "MC", "MD", "MK", "ML", "MM", "MN", "MO", "MT", "MU", "MV",
  "MX", "MY", "MZ", "NA", "NE", "NG", "NI", "NL", "NO", "NP", "NZ", "OM",
  "PA", "PE", "PG", "PH", "PK", "PL", "PT", "PY", "QA", "RO", "RS", "RU",
  "RW", "SA", "SB", "SC", "SE", "SG", "SI", "SK", "SL", "SM", "SN", "SO",
  "SR", "SV", "TC", "TD", "TG", "TH", "TJ", "TM", "TN", "TO", "TR", "TT",
  "TW", "TZ", "UA", "UG", "US", "UY", "UZ", "VA", "VE", "VG", "VN", "VU",
  "WS", "YE", "ZA", "ZM", "ZW",
];

describe("GOOGLE_REGIONS_173 — the fixture is the measured set", () => {
  it("holds exactly 173 distinct codes", () => {
    // Guards a paste error in the array above. A fixture that quietly lost a
    // code would make the tripwire below pass while covering less.
    expect(GOOGLE_REGIONS_173).toHaveLength(173);
    expect(new Set(GOOGLE_REGIONS_173).size).toBe(173);
  });

  it("is entirely alpha-2 — the premise census Q2b confirmed on real rows", () => {
    // If this ever fails, `territoryColumnHeader`'s single-comparison
    // fallback is no longer sound and Apple's two-code check becomes the
    // right shape after all. See the docblock on that function.
    for (const code of GOOGLE_REGIONS_173) {
      expect(code, `${code} is not alpha-2`).toMatch(/^[A-Z]{2}$/);
    }
  });
});

describe("territoryColumnHeader — the format", () => {
  it.each([
    ["VN", "Price in Vietnam (VN)"],
    ["US", "Price in United States (US)"],
    ["KR", "Price in South Korea (KR)"],
    ["TW", "Price in Taiwan (TW)"],
    ["MO", "Price in Macau (MO)"],
    ["RU", "Price in Russia (RU)"],
  ])("%s renders %s", (code, expected) => {
    // The first five ride `region-name.ts`'s override map, which exists to
    // match the labels Play Console renders (ISO would say "United States of
    // America", "Korea, Republic of", "Taiwan, Province of China", "Macao").
    // RU is one of the 15 markets Google sells in that the Apple-module
    // catalog never carried at all.
    expect(territoryColumnHeader(code)).toBe(expected);
  });

  it("a bare code is the regression this replaced", () => {
    // `Price in VN` is what the file said before R3, and it is what a revert
    // would silently restore.
    expect(territoryColumnHeader("VN")).not.toBe("Price in VN");
  });
});

describe("⚠ ISO names that read awkwardly — pinned as DELIBERATE, not overlooked", () => {
  // Q-R3.2: the Manager accepted ISO names, because Google publishes no
  // country-name list of its own — `convertRegionPrices` returns
  // `regionCode` and a price, nothing else. These four are what that
  // decision actually looks like in the file, so they are written down
  // rather than discovered by a Manager opening the spreadsheet.
  //
  // ⚠ THE FIX FOR ANY OF THESE IS AN OVERRIDE IN `region-name.ts`, AND ONLY
  // ON A LABEL SOMEONE HAS READ IN PLAY CONSOLE. The 18 overrides that
  // already exist were verified against a Manager screenshot; inventing a
  // nineteenth from taste would put a name in the file that Google does not
  // use, which is worse than an ugly name that is correct.
  it.each([
    // Parentheses INSIDE the name, so the header carries two of them. Ugly,
    // and still the honest render of the rule.
    ["VA", "Price in Holy See (Vatican City State) (VA)"],
    // ISO's inverted forms — the comma is the package's, not ours.
    ["VG", "Price in Virgin Islands, British (VG)"],
    ["FM", "Price in Micronesia, Federated States of (FM)"],
    // No diacritic: i18n-iso-countries' `en` name is plain ASCII here.
    ["CI", "Price in Cote d'Ivoire (CI)"],
  ])("%s renders %s", (code, expected) => {
    expect(territoryColumnHeader(code)).toBe(expected);
  });

  it("all four are markets Google actually sells in", () => {
    // Otherwise this block would be pinning strings no file can contain.
    for (const code of ["VA", "VG", "FM", "CI"]) {
      expect(GOOGLE_REGIONS_173, code).toContain(code);
    }
  });
});

describe("territoryColumnHeader — the fallback", () => {
  it("drops the parenthetical when there is no name — never `Price in ZZ (ZZ)`", () => {
    // ZZ is user-assigned in ISO 3166-1 and has no name, so
    // `regionNameFromCode` hands back the code (region-name.ts:67-68).
    expect(regionNameFromCode("ZZ")).toBe("ZZ");
    expect(territoryColumnHeader("ZZ")).toBe("Price in ZZ");
    expect(territoryColumnHeader("ZZ")).not.toBe("Price in ZZ (ZZ)");
  });

  it("holds for a second unnameable code, so the first is not a special case", () => {
    expect(territoryColumnHeader("QQ")).toBe("Price in QQ");
  });

  it("⚠ ZERO of Google's 173 real regions take the fallback today", () => {
    // THE TRIPWIRE. Pinned to the exact number, not a bound: the day Google
    // adds a market `i18n-iso-countries` has no entry for, this fails and
    // names it, instead of one header quietly shipping as a bare code inside
    // a 173-column file where nobody would spot it.
    //
    // ⚠ IF THIS FAILS, THE FIX IS AN OVERRIDE IN `region-name.ts`, NOT A
    // BUMPED NUMBER. Raising the count to make it green is how the defect
    // ships.
    const shortened = GOOGLE_REGIONS_173.filter(
      (code) => regionNameFromCode(code) === code,
    );
    expect(shortened, `codes with no name: ${shortened.join(" ")}`).toEqual([]);
  });

  it("every one of the 173 therefore ends in ` (CC)`", () => {
    // The positive statement of the same fact, so a fallback cannot hide
    // behind a filter bug in the test above.
    for (const code of GOOGLE_REGIONS_173) {
      expect(territoryColumnHeader(code), code).toBe(
        `Price in ${regionNameFromCode(code)} (${code})`,
      );
    }
  });
});

describe("⚠ the header got ~3x longer; the geometry must not have moved", () => {
  it("column widths are still one per COLUMN, not one per character", () => {
    // THE FRAGILE PART OF R3. `!cols` is built by counting columns
    // (`territories.flatMap(() => [{wch:10},{wch:10}])`, xlsx-export.ts), and
    // "Price in United States (US)" is nearly three times the width of the
    // old "Price in US". A builder that sized columns from header TEXT would
    // drift here and produce a file that opens fine and is subtly wrong.
    //
    // ⚠ 10 IS DELIBERATE, NOT AN OVERSIGHT. The label spans a merged PAIR,
    // and the same decision is pinned on the Apple side after the identical
    // change (`export-workbook-file.test.ts`: "column widths are still one
    // per column, not one per character", also 10). Widening for the label
    // would widen every price and currency cell in the file.
    const plan = buildExportPlan([
      {
        sku: "sku-1",
        status: "active",
        listings: { "en-US": { title: "Item One", description: "Desc" } },
        prices: {
          US: { currency: "USD", priceMicros: "1990000" },
          VN: { currency: "VND", priceMicros: "49000000000" },
        },
      } as unknown as Parameters<typeof buildExportPlan>[0][number],
    ]);
    const ws = buildExportWorkbook(plan).Sheets["IAP Export"];
    const cols = ws["!cols"] ?? [];
    // 3 fixed + 2 territories x 2 + 1 localization group x 2 = 9.
    expect(cols).toHaveLength(9);
    expect(cols.slice(3, 7)).toEqual([
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
    ]);
  });

  it("the two header rows still line up: long label above Price/Currency", () => {
    const plan = buildExportPlan([
      {
        sku: "sku-1",
        status: "active",
        listings: {},
        prices: { VN: { currency: "VND", priceMicros: "49000000000" } },
      } as unknown as Parameters<typeof buildExportPlan>[0][number],
    ]);
    const ws = buildExportWorkbook(plan).Sheets["IAP Export"];
    const aoa = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
    }) as unknown[][];
    expect(aoa[0][3]).toBe("Price in Vietnam (VN)");
    expect(aoa[0][4]).toBeNull();
    expect(aoa[1][3]).toBe("Price");
    expect(aoa[1][4]).toBe("Currency");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * STRUCTURAL — one composer, not two.
 * ──────────────────────────────────────────────────────────────────────── */

/** Every non-test `.ts`/`.tsx` under the Google IAP module's three trees. */
function googleModuleSources(): string[] {
  const roots = [
    join(__dirname),
    join(__dirname, "..", "..", "components", "google-iap-management"),
    join(__dirname, "..", "..", "app", "api", "google-iap-management"),
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

describe("⚠ structural — the header string is composed in exactly one place", () => {
  it("only `xlsx-export.ts` builds a `Price in …` label", () => {
    // THE MUTATION THIS EXISTS FOR: a second writer (or a "quick fix" in a
    // route) re-templating the header inline. Two composers means the
    // fallback rule is enforced in one of them and forgotten in the other,
    // and the forgotten one is the one that ships `Price in ZZ (ZZ)`.
    //
    // ⚠ SCOPED TO THE GOOGLE MODULE ONLY. Apple has its own composer
    // (`lib/iap-management/export-column-order.ts:91`) for its own file, and
    // that is correct — the two stores do not share a header builder any
    // more than they share a territory list.
    const offenders = googleModuleSources().filter((f) => {
      if (f.endsWith(join("google-iap-management", "xlsx-export.ts"))) return false;
      return /Price in /.test(readFileSync(f, "utf8"));
    });
    expect(offenders, `unexpected composers: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the name is resolved by the shared resolver, not re-derived", () => {
    // `xlsx-export.ts` must reach `regionNameFromCode`. Inlining
    // `countries.getName` here would drop the 18 Play-Console overrides and
    // the file would start disagreeing with the screen about country names.
    //
    // ⚠ THE SECOND ASSERTION MATCHES AN IMPORT STATEMENT, NOT THE PACKAGE
    // NAME. A bare `/i18n-iso-countries/` also matches the prose in this
    // file's own docblock, which names the package while explaining why it
    // is reached through `region-name.ts` — the check would fail on a
    // correct file for citing its own reasoning. Caught by this test failing
    // the first time it ran.
    const src = readFileSync(join(__dirname, "xlsx-export.ts"), "utf8");
    expect(src).toMatch(/import \{ regionNameFromCode \} from "\.\/region-name";/);
    expect(src).not.toMatch(/from ["']i18n-iso-countries/);
  });
});
