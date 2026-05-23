import { describe, it, expect } from "vitest";

import {
  getContinentForRegion,
  CONTINENTS,
  type Continent,
} from "./region-continent";

describe("getContinentForRegion", () => {
  it("buckets Asian markets including SEA + East Asia + Middle East", () => {
    expect(getContinentForRegion("VN")).toBe("Asia");
    expect(getContinentForRegion("JP")).toBe("Asia");
    expect(getContinentForRegion("KR")).toBe("Asia");
    expect(getContinentForRegion("CN")).toBe("Asia");
    expect(getContinentForRegion("TH")).toBe("Asia");
    expect(getContinentForRegion("AE")).toBe("Asia");
    expect(getContinentForRegion("SA")).toBe("Asia");
    expect(getContinentForRegion("TR")).toBe("Asia"); // Google Play groups TR with Asia per ISO
  });

  it("buckets European markets including Eurozone + UK + Eastern Europe", () => {
    expect(getContinentForRegion("DE")).toBe("Europe");
    expect(getContinentForRegion("FR")).toBe("Europe");
    expect(getContinentForRegion("GB")).toBe("Europe");
    expect(getContinentForRegion("IT")).toBe("Europe");
    expect(getContinentForRegion("RU")).toBe("Europe");
    expect(getContinentForRegion("AL")).toBe("Europe");
    expect(getContinentForRegion("PL")).toBe("Europe");
  });

  it("buckets the Americas (N + S + Caribbean)", () => {
    expect(getContinentForRegion("US")).toBe("Americas");
    expect(getContinentForRegion("CA")).toBe("Americas");
    expect(getContinentForRegion("MX")).toBe("Americas");
    expect(getContinentForRegion("BR")).toBe("Americas");
    expect(getContinentForRegion("AR")).toBe("Americas");
    expect(getContinentForRegion("JM")).toBe("Americas");
  });

  it("buckets African markets including North + Sub-Saharan", () => {
    expect(getContinentForRegion("ZA")).toBe("Africa");
    expect(getContinentForRegion("NG")).toBe("Africa");
    expect(getContinentForRegion("EG")).toBe("Africa");
    expect(getContinentForRegion("DZ")).toBe("Africa");
    expect(getContinentForRegion("AO")).toBe("Africa");
    expect(getContinentForRegion("KE")).toBe("Africa");
  });

  it("buckets Oceania including AU/NZ + Pacific islands", () => {
    expect(getContinentForRegion("AU")).toBe("Oceania");
    expect(getContinentForRegion("NZ")).toBe("Oceania");
    expect(getContinentForRegion("FJ")).toBe("Oceania");
    expect(getContinentForRegion("PG")).toBe("Oceania");
  });

  it("normalises lowercase input", () => {
    expect(getContinentForRegion("vn")).toBe("Asia");
    expect(getContinentForRegion("us")).toBe("Americas");
  });

  it("returns null for unrecognised codes (e.g. Antarctica or private-use)", () => {
    expect(getContinentForRegion("AQ")).toBeNull();
    expect(getContinentForRegion("ZZ")).toBeNull();
    expect(getContinentForRegion("")).toBeNull();
  });

  it("Manager Image 2 reference set is buckable", () => {
    // Same set referenced by Hotfix 21 region-name.test.ts.
    const samples: Array<[string, Continent]> = [
      ["AL", "Europe"],
      ["DZ", "Africa"],
      ["AO", "Africa"],
      ["AR", "Americas"],
      ["AE", "Asia"],
    ];
    for (const [code, expected] of samples) {
      expect(getContinentForRegion(code)).toBe(expected);
    }
  });
});

describe("CONTINENTS", () => {
  it("exposes the 5-bucket ordered list used by the filter UI", () => {
    expect(CONTINENTS).toEqual([
      "Asia",
      "Europe",
      "Americas",
      "Africa",
      "Oceania",
    ]);
  });
});
