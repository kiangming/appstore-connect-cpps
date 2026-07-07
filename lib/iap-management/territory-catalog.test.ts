import { describe, it, expect } from "vitest";

import {
  TERRITORY_CATALOG,
  TERRITORY_REGIONS,
  ALL_TERRITORY_CODES,
  currencyForTerritory,
} from "./territory-catalog";

describe("TERRITORY_CATALOG — shape", () => {
  it("every entry has a code, name, currency, and a region from TERRITORY_REGIONS", () => {
    expect(TERRITORY_CATALOG.length).toBeGreaterThan(150);
    for (const t of TERRITORY_CATALOG) {
      expect(t.code).toMatch(/^[A-Z]{2}$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.currency).toMatch(/^[A-Z]{3}$/);
      expect(TERRITORY_REGIONS).toContain(t.region);
    }
  });

  it("has no duplicate codes", () => {
    const codes = TERRITORY_CATALOG.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("ALL_TERRITORY_CODES matches the catalog 1:1", () => {
    expect(ALL_TERRITORY_CODES).toEqual(TERRITORY_CATALOG.map((t) => t.code));
  });

  it("covers all 6 approved-mockup regions with at least one entry each", () => {
    for (const region of TERRITORY_REGIONS) {
      const count = TERRITORY_CATALOG.filter((t) => t.region === region).length;
      expect(count).toBeGreaterThan(0);
    }
  });
});

describe("TERRITORY_CATALOG — shared-currency countries map correctly", () => {
  it("EUR is shared by multiple distinct European countries", () => {
    const eur = TERRITORY_CATALOG.filter((t) => t.currency === "EUR").map((t) => t.code);
    expect(eur).toEqual(expect.arrayContaining(["DE", "FR", "IT", "ES", "NL"]));
    expect(eur.length).toBeGreaterThanOrEqual(5);
  });

  it("XOF (West African CFA franc) is shared by Senegal and Côte d'Ivoire", () => {
    expect(currencyForTerritory("SN")).toBe("XOF");
    expect(currencyForTerritory("CI")).toBe("XOF");
  });

  it("XCD (East Caribbean dollar) is shared across several small Americas states", () => {
    const xcd = TERRITORY_CATALOG.filter((t) => t.currency === "XCD").map((t) => t.code);
    expect(xcd.length).toBeGreaterThanOrEqual(4);
  });

  it("distinct countries can share a currency without sharing a country", () => {
    // US and Ecuador both use USD — confirms 1-country:1-currency but
    // many-countries:1-shared-currency is representable.
    expect(currencyForTerritory("US")).toBe("USD");
    expect(currencyForTerritory("EC")).toBe("USD");
  });
});

describe("currencyForTerritory", () => {
  it("is case-insensitive and returns null for unknown codes", () => {
    expect(currencyForTerritory("vn")).toBe("VND");
    expect(currencyForTerritory("ZZ")).toBeNull();
  });
});

describe("TERRITORY_CATALOG — grouping order", () => {
  it("is grouped by region in TERRITORY_REGIONS order (no interleaving)", () => {
    const seenRegions: string[] = [];
    for (const t of TERRITORY_CATALOG) {
      if (seenRegions[seenRegions.length - 1] !== t.region) {
        expect(seenRegions).not.toContain(t.region); // a region shouldn't reappear later
        seenRegions.push(t.region);
      }
    }
    expect(seenRegions).toEqual(TERRITORY_REGIONS);
  });

  it("is sorted alphabetically by name within each region", () => {
    for (const region of TERRITORY_REGIONS) {
      const names = TERRITORY_CATALOG.filter((t) => t.region === region).map((t) => t.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    }
  });
});
