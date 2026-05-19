import { describe, it, expect } from "vitest";
import { territoryName } from "./territory-name";

describe("territoryName", () => {
  it("resolves common ISO 3166-1 alpha-3 codes via i18n-iso-countries", () => {
    expect(territoryName("VNM")).toBe("Vietnam");
    expect(territoryName("JPN")).toBe("Japan");
    expect(territoryName("KOR")).toBe("South Korea");
    expect(territoryName("SGP")).toBe("Singapore");
    expect(territoryName("PHL")).toBe("Philippines");
    expect(territoryName("MYS")).toBe("Malaysia");
    expect(territoryName("THA")).toBe("Thailand");
    expect(territoryName("IDN")).toBe("Indonesia");
  });

  // IAP.p2.l: Manager UAT MV30 flagged these codes as unmapped — pin them
  // explicitly so a future regression to the hand-curated dict trips a test.
  it("resolves the codes Manager flagged at MV30 UAT", () => {
    expect(territoryName("HKG")).toBe("Hong Kong");
    expect(territoryName("MAC")).toBe("Macau");
    expect(territoryName("MMR")).toBe("Myanmar");
    expect(territoryName("KHM")).toBe("Cambodia");
  });

  it("applies Apple-Connect overrides for divergent ISO names", () => {
    // ISO would return "United States of America"; Apple uses the short form.
    expect(territoryName("USA")).toBe("United States");
    // ISO returns "Taiwan, Province of China"; Apple uses short form.
    expect(territoryName("TWN")).toBe("Taiwan");
    // ISO returns "People's Republic of China"; Apple disambiguates the
    // mainland from HK / MAC / TWN.
    expect(territoryName("CHN")).toBe("China mainland");
    // ISO returns "Macao"; Apple uses Portuguese-influenced "Macau".
    expect(territoryName("MAC")).toBe("Macau");
    // ISO returns "Russian Federation" / "Islamic Republic of Iran"; Apple short form.
    expect(territoryName("RUS")).toBe("Russia");
    expect(territoryName("IRN")).toBe("Iran");
    expect(territoryName("LAO")).toBe("Laos");
  });

  it("falls back to the raw code for truly unknown territories", () => {
    expect(territoryName("ZZZ")).toBe("ZZZ");
  });
});
