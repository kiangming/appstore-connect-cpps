/**
 * F-B / S3 — the snapshot is a product input now, so it gets product tests.
 *
 * ⚠ WHY ARITHMETIC AND NOT JUST A COUNT. `183 − 19 + 11 = 175` is the
 * relationship between the two lists, and it is the thing that caught a real
 * documentation error: TODO.md recorded "20 catalog entries Apple does not
 * sell to" and the sum came to 174, one short. The extra entry was Kosovo —
 * counted as Apple-doesn't-sell because whoever measured it compared alpha-2
 * catalog codes against alpha-3 Apple codes, before `territory-code-map`
 * existed to normalise `XKS`. A bare `expect(length).toBe(175)` would have
 * been just as green and would have taught nobody anything.
 */
import { describe, it, expect } from "vitest";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

import {
  APPLE_TERRITORIES,
  APPLE_TERRITORIES_ALPHA3,
  appleCurrencyFor,
  unknownAppleTerritories,
} from "./apple-territories.snapshot";
import { allExportTerritories } from "./export-territory-expansion";
import { toCatalogCode } from "./territory-code-map";
import { ALL_TERRITORY_CODES } from "@/lib/iap-management/territory-catalog";

countries.registerLocale(enLocale);

describe("the Apple territory snapshot", () => {
  it("holds exactly 175 alpha-3 codes — the 2026-08-27 measurement", () => {
    expect(APPLE_TERRITORIES_ALPHA3).toHaveLength(175);
  });

  it("has no duplicates, and every code is alpha-3 shaped", () => {
    expect(new Set(APPLE_TERRITORIES_ALPHA3).size).toBe(175);
    const wrongShape = APPLE_TERRITORIES_ALPHA3.filter((c) => !/^[A-Z]{3}$/.test(c));
    expect(wrongShape).toEqual([]);
  });

  it("⚠ still 175 DISTINCT codes after alpha-2 normalisation — no collisions", () => {
    // THE BUG THIS EXISTS FOR. A fixture in this same arc mixed alpha-2 and
    // alpha-3 and lost four territories to collisions (HK/HKG, ID/IDN,
    // MO/MAC, MY/MYS) — 171 columns where 175 were expected, and every name
    // still resolved so nothing looked wrong. Converting and re-counting is
    // the cheap check that would have caught it immediately.
    const alpha2 = APPLE_TERRITORIES_ALPHA3.map(toCatalogCode);
    expect(new Set(alpha2).size).toBe(175);
  });

  it("carries Kosovo as XKS — the one code ISO cannot convert", () => {
    expect(APPLE_TERRITORIES_ALPHA3).toContain("XKS");
    expect(toCatalogCode("XKS")).toBe("XK");
    // …and the ISO library genuinely cannot do it, which is why the map exists.
    expect(countries.alpha3ToAlpha2("XKS")).toBeUndefined();
  });

  it("⚠ every entry carries a NON-EMPTY currency — G1b mutation (f)", () => {
    // Apple returned one for all 175 (probe guard: "all 175 entries carry a
    // currency"). An entry that lost its currency would render the picker as
    // `US · ` — a label with nothing after the separator — and there is no
    // safe value to substitute, because the whole finding of G1b is that
    // currency CANNOT be derived from the country.
    const blank = APPLE_TERRITORIES.filter((t) => !t.currency?.trim());
    expect(blank.map((t) => t.code)).toEqual([]);
    expect(APPLE_TERRITORIES).toHaveLength(175);
  });

  it("every currency is a well-formed ISO-4217 code", () => {
    const bad = APPLE_TERRITORIES.filter((t) => !/^[A-Z]{3}$/.test(t.currency));
    expect(bad.map((t) => `${t.code}=${t.currency}`)).toEqual([]);
  });

  it("the codes array is DERIVED, not a second hand-kept list", () => {
    // Two lists that must agree are two lists that will not. This pins that
    // there is one source and the other is a projection of it.
    expect(APPLE_TERRITORIES_ALPHA3).toEqual(APPLE_TERRITORIES.map((t) => t.code));
  });

  it("⚠ Apple's currency is NOT the country's own, for most markets", () => {
    // The finding that made this field necessary, as an assertion rather than
    // a paragraph: if someone ever "fixes" these to local currencies, this
    // goes red and points at KB §4.19.
    expect(appleCurrencyFor("BGR")).toBe("EUR"); // not BGN
    expect(appleCurrencyFor("MAC")).toBe("USD"); // not MOP
    expect(appleCurrencyFor("ISL")).toBe("USD"); // not ISK
    expect(appleCurrencyFor("CYM")).toBe("USD"); // not KYD
    expect(appleCurrencyFor("BMU")).toBe("USD"); // not BMD
    // …and the ones Apple DOES bill locally still do.
    expect(appleCurrencyFor("JPN")).toBe("JPY");
    expect(appleCurrencyFor("RUS")).toBe("RUB");
  });

  it("appleCurrencyFor returns null for an unknown code — never a guess", () => {
    expect(appleCurrencyFor("ZZZ")).toBeNull();
  });

  it("names the measurement date and the refresh command in the file itself", async () => {
    // A snapshot whose provenance lives only in a commit message is a list of
    // strings nobody dares touch.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/iap-management/apple/apple-territories.snapshot.ts", "utf8"),
    );
    expect(src).toContain("2026-08-27");
    expect(src).toContain("probe-export-price-sources.mjs");
    expect(src).toMatch(/PHOTOGRAPH|snapshot/i);
  });
});

describe("⚠ the arithmetic between the two lists — 183 − 19 + 11 = 175", () => {
  const apple2 = new Set(APPLE_TERRITORIES_ALPHA3.map(toCatalogCode));
  const catalog = new Set(ALL_TERRITORY_CODES);

  it("the catalog holds 183 codes", () => {
    expect(catalog.size).toBe(183);
  });

  it("11 markets Apple sells to are MISSING from the catalog — Russia among them", () => {
    const appleOnly = [...apple2].filter((c) => !catalog.has(c)).sort();
    expect(appleOnly).toEqual(
      ["AI", "BM", "BY", "KY", "LY", "MS", "RU", "TC", "VG", "YE", "ZW"],
    );
    // Named explicitly: this is the commercially significant one, and the
    // reason `[EXPORT-catalog-missing-11]` is not a cosmetic backlog item.
    expect(appleOnly).toContain("RU");
  });

  it("19 catalog entries Apple does NOT sell to — and Kosovo is NOT one of them", () => {
    const catalogOnly = [...catalog].filter((c) => !apple2.has(c)).sort();
    expect(catalogOnly).toHaveLength(19);
    // ⚠ The correction. TODO.md said 20 and included XK; Apple does sell to
    // Kosovo (`XKS`), which is the entire premise of E2b.
    expect(catalogOnly).not.toContain("XK");
    expect(apple2.has("XK")).toBe(true);
  });

  it("the identity closes: 183 − 19 + 11 = 175", () => {
    const appleOnly = [...apple2].filter((c) => !catalog.has(c)).length;
    const catalogOnly = [...catalog].filter((c) => !apple2.has(c)).length;
    expect(catalog.size - catalogOnly + appleOnly).toBe(apple2.size);
    expect(apple2.size).toBe(175);
  });
});

describe("allExportTerritories — what 'all countries' expands to", () => {
  it("is the UNION of both lists: 194 columns", () => {
    expect(allExportTerritories()).toHaveLength(194);
  });

  it("⚠ contains Russia — the market the catalog alone cannot reach", () => {
    // MUTATION: expand from the catalog only → this fails, and it is the
    // whole reason the union was chosen over the picker's own list.
    expect(allExportTerritories()).toContain("RU");
  });

  it("⚠ keeps the 19 markets Apple does not sell to — they are tickable", () => {
    // MUTATION: expand from Apple's list only → these disappear, which is a
    // silent drop on countries the dialog offers.
    const apple2 = new Set(APPLE_TERRITORIES_ALPHA3.map(toCatalogCode));
    const catalogOnly = [...ALL_TERRITORY_CODES].filter((c) => !apple2.has(c));
    expect(catalogOnly).toHaveLength(19);
    for (const code of catalogOnly) {
      expect(allExportTerritories()).toContain(code);
    }
  });

  it("Kosovo appears ONCE, not twice — both sides normalise before meeting", () => {
    // XK from the catalog, XKS from Apple. Union them in the wrong alphabet
    // and the file grows two columns for one country.
    const all = allExportTerritories();
    expect(all.filter((c) => c === "XK")).toHaveLength(1);
    expect(all).not.toContain("XKS");
  });

  it("is sorted and duplicate-free, so column order is stable across runs", () => {
    const all = allExportTerritories();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(all);
  });
});

describe("unknownAppleTerritories — the runtime drift detector (b)", () => {
  it("is silent when Apple returns only known territories", () => {
    expect(unknownAppleTerritories(["USA", "VNM", "XKS"])).toEqual([]);
  });

  it("names a territory Apple added after the snapshot was taken", () => {
    expect(unknownAppleTerritories(["USA", "ZZZ"])).toEqual(["ZZZ"]);
  });

  it("dedupes — 500 rows in one unknown market is one warning, not 500", () => {
    expect(unknownAppleTerritories(["ZZZ", "ZZZ", "ZZZ", "USA"])).toEqual(["ZZZ"]);
  });

  it("⚠ CANNOT see a REMOVAL, by construction — that is the probe's job", () => {
    // Stated as a test so the limitation is impossible to forget: the input is
    // "what Apple returned", so a territory Apple dropped is simply absent and
    // there is nothing here to notice. Detector (a) compares whole lists.
    const appleDroppedVNM = ["USA", "THA"];
    expect(unknownAppleTerritories(appleDroppedVNM)).toEqual([]);
  });
});
