import { describe, it, expect } from "vitest";

import { regionNameFromCode, getAllRegions } from "./region-name";

describe("regionNameFromCode", () => {
  it("resolves Google Play override codes to short names matching the Console UI", () => {
    expect(regionNameFromCode("US")).toBe("United States");
    expect(regionNameFromCode("GB")).toBe("United Kingdom");
    expect(regionNameFromCode("KR")).toBe("South Korea");
    expect(regionNameFromCode("VN")).toBe("Vietnam");
    expect(regionNameFromCode("RU")).toBe("Russia");
    expect(regionNameFromCode("TW")).toBe("Taiwan");
    expect(regionNameFromCode("MO")).toBe("Macau");
  });

  it("resolves regions previously falling back to 'US — United States' (the Cycle 35 bug)", () => {
    // Manager reference Image 2 — these are the rows that pre-Hotfix 21
    // rendered as 'US — United States' because they fell outside the
    // 30-entry COMMON_REGIONS list.
    expect(regionNameFromCode("AL")).toBe("Albania");
    expect(regionNameFromCode("DZ")).toBe("Algeria");
    expect(regionNameFromCode("AO")).toBe("Angola");
    expect(regionNameFromCode("AR")).toBe("Argentina");
    expect(regionNameFromCode("AE")).toBe("United Arab Emirates");
  });

  it("accepts lowercase input and normalizes to uppercase", () => {
    expect(regionNameFromCode("us")).toBe("United States");
    expect(regionNameFromCode("vn")).toBe("Vietnam");
  });

  it("returns the raw code if i18n-iso-countries has no entry (defensive fallback)", () => {
    expect(regionNameFromCode("ZZ")).toBe("ZZ");
    expect(regionNameFromCode("XX")).toBe("XX");
  });

  it("returns the input unchanged for empty/falsy codes", () => {
    expect(regionNameFromCode("")).toBe("");
  });
});

describe("getAllRegions", () => {
  it("returns the full ISO 3166-1 alpha-2 list (well above the 30-entry COMMON_REGIONS pre-Hotfix 21)", () => {
    const list = getAllRegions();
    expect(list.length).toBeGreaterThan(200);
  });

  it("includes every region from Manager Image 2 that previously fell through", () => {
    const list = getAllRegions();
    const codes = new Set(list.map((r) => r.code));
    expect(codes.has("AL")).toBe(true); // Albania
    expect(codes.has("DZ")).toBe(true); // Algeria
    expect(codes.has("AO")).toBe(true); // Angola
    expect(codes.has("AR")).toBe(true); // Argentina
  });

  it("sorts entries alphabetically by display name", () => {
    const list = getAllRegions();
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i - 1].name.localeCompare(list[i].name)).toBeLessThanOrEqual(0);
    }
  });

  it("uses Google override labels in the sorted output", () => {
    const list = getAllRegions();
    const us = list.find((r) => r.code === "US");
    const vn = list.find((r) => r.code === "VN");
    expect(us?.name).toBe("United States");
    expect(vn?.name).toBe("Vietnam");
  });

  it("returns the same cached reference across calls (no recompute per render)", () => {
    const a = getAllRegions();
    const b = getAllRegions();
    expect(a).toBe(b);
  });
});
