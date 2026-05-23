import { describe, it, expect } from "vitest";

import {
  APPLE_CONTINENTS,
  getContinentForTerritory,
} from "./territory-continent";

describe("getContinentForTerritory", () => {
  it("buckets Asian territories (alpha-3) including SEA + East Asia + Middle East", () => {
    expect(getContinentForTerritory("VNM")).toBe("Asia");
    expect(getContinentForTerritory("JPN")).toBe("Asia");
    expect(getContinentForTerritory("KOR")).toBe("Asia");
    expect(getContinentForTerritory("CHN")).toBe("Asia");
    expect(getContinentForTerritory("THA")).toBe("Asia");
    expect(getContinentForTerritory("ARE")).toBe("Asia");
    expect(getContinentForTerritory("TUR")).toBe("Asia");
  });

  it("buckets European territories including Eurozone + UK + Eastern Europe", () => {
    expect(getContinentForTerritory("DEU")).toBe("Europe");
    expect(getContinentForTerritory("FRA")).toBe("Europe");
    expect(getContinentForTerritory("GBR")).toBe("Europe");
    expect(getContinentForTerritory("ITA")).toBe("Europe");
    expect(getContinentForTerritory("RUS")).toBe("Europe");
    expect(getContinentForTerritory("ALB")).toBe("Europe");
    expect(getContinentForTerritory("POL")).toBe("Europe");
  });

  it("buckets the Americas including Caribbean", () => {
    expect(getContinentForTerritory("USA")).toBe("Americas");
    expect(getContinentForTerritory("CAN")).toBe("Americas");
    expect(getContinentForTerritory("MEX")).toBe("Americas");
    expect(getContinentForTerritory("BRA")).toBe("Americas");
    expect(getContinentForTerritory("ARG")).toBe("Americas");
    expect(getContinentForTerritory("JAM")).toBe("Americas");
  });

  it("buckets African territories", () => {
    expect(getContinentForTerritory("ZAF")).toBe("Africa");
    expect(getContinentForTerritory("NGA")).toBe("Africa");
    expect(getContinentForTerritory("EGY")).toBe("Africa");
    expect(getContinentForTerritory("DZA")).toBe("Africa");
    expect(getContinentForTerritory("KEN")).toBe("Africa");
  });

  it("buckets Oceania including AU/NZ + Pacific islands", () => {
    expect(getContinentForTerritory("AUS")).toBe("Oceania");
    expect(getContinentForTerritory("NZL")).toBe("Oceania");
    expect(getContinentForTerritory("FJI")).toBe("Oceania");
    expect(getContinentForTerritory("PNG")).toBe("Oceania");
  });

  it("normalises lowercase input", () => {
    expect(getContinentForTerritory("vnm")).toBe("Asia");
    expect(getContinentForTerritory("usa")).toBe("Americas");
  });

  it("returns null for unrecognised codes (Antarctica, private-use)", () => {
    expect(getContinentForTerritory("ATA")).toBeNull();
    expect(getContinentForTerritory("XXX")).toBeNull();
    expect(getContinentForTerritory("")).toBeNull();
  });

  it("exposes the 5-bucket ordered list used by the filter UI", () => {
    expect(APPLE_CONTINENTS).toEqual([
      "Asia",
      "Europe",
      "Americas",
      "Africa",
      "Oceania",
    ]);
  });
});
