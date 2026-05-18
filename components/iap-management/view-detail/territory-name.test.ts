import { describe, it, expect } from "vitest";
import { territoryName } from "./territory-name";

describe("territoryName", () => {
  it("returns the mapped display name for known codes", () => {
    expect(territoryName("USA")).toBe("United States");
    expect(territoryName("VNM")).toBe("Vietnam");
    expect(territoryName("JPN")).toBe("Japan");
  });

  it("falls back to the raw code for unmapped territories", () => {
    expect(territoryName("ZZZ")).toBe("ZZZ");
    expect(territoryName("AFG")).toBe("AFG");
  });
});
