/**
 * G2 — the Apple picker list: 175 markets, Apple's currency, six buckets.
 *
 * ⚠ The load-bearing test in this file is the LAST one. Everything else checks
 * that the list is well-formed; that one checks it is reading the RIGHT SOURCE
 * for currency, which is the only field where the two available sources
 * disagree — and they disagree on 96 of 164 codes, so reading the wrong one
 * would look completely normal.
 */
import { describe, it, expect } from "vitest";

import {
  APPLE_TERRITORY_CATALOG,
  APPLE_TERRITORY_CODES,
} from "./apple-territory-catalog";
import { APPLE_TERRITORIES } from "./apple-territories.snapshot";
// ⚠ THE REAL CONVERTER, not a hand-rolled `code === "XKS" ? …`. The first
// draft of this file open-coded the Kosovo case and left every other alpha-3
// untouched, so the comparison was alpha-3 against alpha-2 and failed for 174
// codes. Third time this arc that an ad-hoc alphabet conversion has bitten
// (P27 #4) — the converter exists; use it.
import { toCatalogCode } from "./territory-code-map";
import {
  TERRITORY_CATALOG,
  TERRITORY_REGIONS,
} from "@/lib/iap-management/territory-catalog";

/** The markets Apple sells to that the shared catalog has never carried. */
const APPLE_ONLY = ["AI", "BM", "BY", "KY", "LY", "MS", "RU", "TC", "VG", "YE", "ZW"];

describe("APPLE_TERRITORY_CATALOG — shape", () => {
  it("has exactly 175 entries — one per Apple market, no more", () => {
    expect(APPLE_TERRITORY_CATALOG).toHaveLength(175);
    expect(new Set(APPLE_TERRITORY_CODES).size).toBe(175);
  });

  it("is derived from the snapshot — same codes, nothing invented, nothing dropped", () => {
    // ⚠ This is what "one source" means operationally: the picker cannot
    // contain a market the snapshot does not, or omit one it does.
    const fromSnapshot = new Set(APPLE_TERRITORIES.map((t) => toCatalogCode(t.code)));
    const derived = new Set(APPLE_TERRITORY_CODES);
    expect(derived.size).toBe(fromSnapshot.size);
    expect([...derived].sort()).toEqual([...fromSnapshot].sort());
  });

  it("every entry carries all four fields the picker renders", () => {
    // code · name · currency · region — the picker uses all four
    // (ExportOptionsDialog.tsx:213/216 render, :55-57 search, :86 grouping).
    const incomplete = APPLE_TERRITORY_CATALOG.filter(
      (t) => !t.code || !t.name || !t.currency || !t.region,
    );
    expect(incomplete.map((t) => t.code)).toEqual([]);
  });

  it("no entry falls back to showing a bare code as its name", () => {
    const unnamed = APPLE_TERRITORY_CATALOG.filter((t) => t.name === t.code);
    expect(unnamed.map((t) => t.code)).toEqual([]);
  });

  it("Kosovo appears once, as XK — Apple's XKS normalised at the boundary", () => {
    expect(APPLE_TERRITORY_CODES.filter((c) => c === "XK")).toHaveLength(1);
    expect(APPLE_TERRITORY_CODES).not.toContain("XKS");
  });

  it("drops the 19 markets Apple does not sell to", () => {
    const appleCodes = new Set(APPLE_TERRITORY_CODES);
    const dropped = TERRITORY_CATALOG.filter((t) => !appleCodes.has(t.code));
    expect(dropped).toHaveLength(19);
    // …and they really are absent, not merely fewer.
    expect(appleCodes.has("AD")).toBe(false); // Andorra
    expect(appleCodes.has("MC")).toBe(false); // Monaco
  });

  it("groups into the SIX buckets, in the picker's order", () => {
    const seen = APPLE_TERRITORY_CATALOG.map((t) => t.region);
    const order = [...new Set(seen)];
    expect(order).toEqual(
      TERRITORY_REGIONS.filter((r) => seen.includes(r)),
    );
    // every bucket is populated — a 6-bucket UI with an empty column is a bug
    expect(order).toHaveLength(6);
  });

  it("sorts alphabetically by name inside each bucket, like the shared catalog", () => {
    for (const region of TERRITORY_REGIONS) {
      const names = APPLE_TERRITORY_CATALOG.filter((t) => t.region === region).map(
        (t) => t.name,
      );
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    }
  });
});

describe("APPLE_TERRITORY_CATALOG — the 11 markets the shared catalog never had", () => {
  const byCode = new Map(APPLE_TERRITORY_CATALOG.map((t) => [t.code, t]));

  it("all 11 are present and fully populated", () => {
    for (const code of APPLE_ONLY) {
      const e = byCode.get(code);
      expect(e, `${code} missing from the Apple picker`).toBeDefined();
      expect(e!.name).not.toBe(code);
      expect(e!.currency).toMatch(/^[A-Z]{3}$/);
      expect(TERRITORY_REGIONS).toContain(e!.region);
    }
  });

  it("⚠ Russia reads `Russia · RU · RUB` — the market the shared catalog cannot reach", () => {
    // The headline of [Q-EXPORT.apple-only-picker]: RU becomes tickable
    // without touching TERRITORY_CATALOG, so P8 is never engaged.
    expect(byCode.get("RU")).toEqual({
      code: "RU",
      name: "Russia",
      // ⚠ RUB, not USD. Apple bills most of the world in USD — Russia is one
      // of the ~68 markets it really does bill locally, which is why the
      // "collapse to USD" observation can never become a rule (KB §4.19).
      currency: "RUB",
      region: "Europe",
    });
  });

  it("the three ISO long-forms are overridden to what a Manager searches for", () => {
    expect(byCode.get("VG")!.name).toBe("British Virgin Islands"); // ISO: "Virgin Islands, British"
    expect(byCode.get("TC")!.name).toBe("Turks & Caicos"); // ISO: "Turks and Caicos Islands"
    expect(byCode.get("RU")!.name).toBe("Russia"); // ISO: "Russian Federation"
  });

  it("the other eight resolve straight from i18n-iso-countries, no override needed", () => {
    expect(byCode.get("AI")!.name).toBe("Anguilla");
    expect(byCode.get("BM")!.name).toBe("Bermuda");
    expect(byCode.get("BY")!.name).toBe("Belarus");
    expect(byCode.get("KY")!.name).toBe("Cayman Islands");
    expect(byCode.get("LY")!.name).toBe("Libya");
    expect(byCode.get("MS")!.name).toBe("Montserrat");
    expect(byCode.get("YE")!.name).toBe("Yemen");
    expect(byCode.get("ZW")!.name).toBe("Zimbabwe");
  });

  it("⚠ Yemen is MIDDLE EAST — the row that forced the hand-assignment", () => {
    // `region-continent.ts` carries all 11 but on a 5-bucket scheme that folds
    // the Middle East into Asia. Importing it mechanically files Yemen wrong.
    expect(byCode.get("YE")!.region).toBe("Middle East");
    expect(byCode.get("YE")!.region).not.toBe("Asia");
  });

  it("the six Caribbean/Atlantic territories are Americas, and the rest land right", () => {
    for (const code of ["AI", "BM", "KY", "MS", "TC", "VG"]) {
      expect(byCode.get(code)!.region, code).toBe("Americas");
    }
    expect(byCode.get("BY")!.region).toBe("Europe");
    expect(byCode.get("LY")!.region).toBe("Africa");
    expect(byCode.get("ZW")!.region).toBe("Africa");
  });
});

describe("⚠ MUTATION — currency comes from the SNAPSHOT, not the catalog", () => {
  const byCode = new Map(APPLE_TERRITORY_CATALOG.map((t) => [t.code, t]));
  const catalogByCode = new Map(TERRITORY_CATALOG.map((t) => [t.code, t]));

  it("Bulgaria is EUR here and BGN in the shared catalog — the picker shows EUR", () => {
    // THE FIXTURE THAT DECIDES THE SOURCE. Swap `decorate` to read
    // `CATALOG_BY_CODE.get(code).currency` and this is the assertion that goes
    // red. Chosen because §4.19 already pins BGR→EUR, so the two tests fail
    // together and name the same rule.
    expect(catalogByCode.get("BG")!.currency).toBe("BGN");
    expect(byCode.get("BG")!.currency).toBe("EUR");
  });

  it("⚠ and it is not one country — 96 of the 164 shared codes disagree", () => {
    // A single-country assertion could pass on a fluke or a special case. This
    // one states the scale, so a change of source cannot be mistaken for a
    // rounding difference.
    const shared = APPLE_TERRITORY_CATALOG.filter((t) => catalogByCode.has(t.code));
    expect(shared).toHaveLength(164);
    const disagree = shared.filter(
      (t) => catalogByCode.get(t.code)!.currency !== t.currency,
    );
    expect(disagree).toHaveLength(96);
    // …and the picker sides with Apple on every one of them.
    const snapshotByCode = new Map(
      APPLE_TERRITORIES.map((t) => [toCatalogCode(t.code), t.currency]),
    );
    for (const t of disagree) {
      expect(t.currency, t.code).toBe(snapshotByCode.get(t.code));
    }
  });

  it("the 68 that agree still agree — this is a source change, not a rewrite", () => {
    const shared = APPLE_TERRITORY_CATALOG.filter((t) => catalogByCode.has(t.code));
    const agree = shared.filter(
      (t) => catalogByCode.get(t.code)!.currency === t.currency,
    );
    expect(agree).toHaveLength(68);
    expect(byCode.get("JP")!.currency).toBe("JPY");
    expect(byCode.get("VN")!.currency).toBe("VND");
  });
});
