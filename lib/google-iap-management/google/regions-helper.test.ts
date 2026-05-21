import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the publisher-client's convertRegionPrices export. The
// regions-helper imports it via the publisher-client surface so we
// don't have to mock the whole googleapis SDK. Use vi.hoisted because
// vi.mock factories are hoisted above imports — a plain const isn't
// in scope yet at hoist time.
const { convertSpy } = vi.hoisted(() => ({
  convertSpy: vi.fn(),
}));
vi.mock("./publisher-client", () => ({
  convertRegionPrices: convertSpy,
}));

import {
  buildRegionMapFromBasePrice,
  mergeRegionMaps,
} from "./regions-helper";

beforeEach(() => {
  convertSpy.mockReset();
});

describe("buildRegionMapFromBasePrice", () => {
  it("calls convertRegionPrices with the base price as Money + returns Money map as micros", async () => {
    convertSpy.mockResolvedValueOnce({
      convertedRegionPrices: {
        US: {
          regionCode: "US",
          price: { currencyCode: "USD", units: "1", nanos: 990_000_000 },
        },
        VN: {
          regionCode: "VN",
          price: { currencyCode: "VND", units: "25000", nanos: 0 },
        },
        JP: {
          regionCode: "JP",
          price: { currencyCode: "JPY", units: "300", nanos: 0 },
        },
      },
      regionVersion: { version: "2022/02" },
    });

    const out = await buildRegionMapFromBasePrice(
      {} as never, // mocked JWT — not used by the spy
      "com.example.app",
      "1990000",
      "USD",
    );

    // Spy received the price in Money form (units + nanos)
    expect(convertSpy).toHaveBeenCalledTimes(1);
    const arg = convertSpy.mock.calls[0][2];
    expect(arg).toEqual({
      price: { currencyCode: "USD", units: "1", nanos: 990_000_000 },
    });

    // Output sorted by region; Money round-tripped back to micros.
    expect(out.regions).toEqual([
      { region: "JP", currency: "JPY", priceMicros: "300000000" },
      { region: "US", currency: "USD", priceMicros: "1990000" },
      { region: "VN", currency: "VND", priceMicros: "25000000000" },
    ]);
    expect(out.regionsVersion).toBe("2022/02");
  });

  it("skips entries with missing currencyCode or price", async () => {
    convertSpy.mockResolvedValueOnce({
      convertedRegionPrices: {
        US: {
          regionCode: "US",
          price: { currencyCode: "USD", units: "1", nanos: 990_000_000 },
        },
        XX: { regionCode: "XX" }, // no price → skipped
        YY: { regionCode: "YY", price: { units: "10", nanos: 0 } }, // no currency → skipped
      },
    });
    const out = await buildRegionMapFromBasePrice(
      {} as never,
      "com.example.app",
      "1990000",
      "USD",
    );
    expect(out.regions.map((r) => r.region)).toEqual(["US"]);
  });

  it("returns empty array when the response carries no converted prices", async () => {
    convertSpy.mockResolvedValueOnce({ convertedRegionPrices: {} });
    const out = await buildRegionMapFromBasePrice(
      {} as never,
      "com.example.app",
      "1990000",
      "USD",
    );
    expect(out.regions).toEqual([]);
  });

  it("propagates errors from convertRegionPrices unchanged", async () => {
    convertSpy.mockRejectedValueOnce(new Error("403 SCOPE_MISSING"));
    await expect(
      buildRegionMapFromBasePrice(
        {} as never,
        "com.example.app",
        "1990000",
        "USD",
      ),
    ).rejects.toThrow(/SCOPE_MISSING/);
  });

  // Hotfix 9: the response's regionVersion identifies which catalog
  // Google used for the conversion. Callers MUST forward this value to
  // the subsequent monetization.onetimeproducts.patch call so currencies
  // stay consistent (e.g. BG = EUR in current catalog vs BGN in older
  // pinned versions). Helper exposes the field so orchestrators can
  // thread it through.
  it("captures regionVersion.version from the response (Hotfix 9 — BG/Eurozone trap)", async () => {
    convertSpy.mockResolvedValueOnce({
      convertedRegionPrices: {
        BG: {
          regionCode: "BG",
          price: { currencyCode: "EUR", units: "1", nanos: 990_000_000 },
        },
      },
      regionVersion: { version: "2026/01" },
    });
    const out = await buildRegionMapFromBasePrice(
      {} as never,
      "com.example.app",
      "1990000",
      "EUR",
    );
    expect(out.regionsVersion).toBe("2026/01");
    expect(out.regions).toEqual([
      { region: "BG", currency: "EUR", priceMicros: "1990000" },
    ]);
  });

  it("returns regionsVersion: null when the response omits regionVersion", async () => {
    convertSpy.mockResolvedValueOnce({ convertedRegionPrices: {} });
    const out = await buildRegionMapFromBasePrice(
      {} as never,
      "com.example.app",
      "1990000",
      "USD",
    );
    expect(out.regionsVersion).toBeNull();
  });
});

describe("mergeRegionMaps", () => {
  it("preserves auto entries when no explicit override exists", () => {
    const auto = [
      { region: "US", currency: "USD", priceMicros: "1990000" },
      { region: "VN", currency: "VND", priceMicros: "25000000000" },
    ];
    expect(mergeRegionMaps(auto, [])).toEqual(auto);
  });

  it("explicit overrides win on duplicate region", () => {
    const auto = [
      { region: "US", currency: "USD", priceMicros: "1990000" },
      { region: "VN", currency: "VND", priceMicros: "25000000000" },
    ];
    const explicit = [
      { region: "US", currency: "USD", priceMicros: "990000" }, // Manager overrides to $0.99
    ];
    const merged = mergeRegionMaps(auto, explicit);
    expect(merged.find((r) => r.region === "US")?.priceMicros).toBe("990000");
    expect(merged.find((r) => r.region === "VN")?.priceMicros).toBe("25000000000");
  });

  it("includes explicit regions even when auto map doesn't have them", () => {
    const auto = [{ region: "US", currency: "USD", priceMicros: "1990000" }];
    const explicit = [
      { region: "BR", currency: "BRL", priceMicros: "9990000" },
    ];
    const merged = mergeRegionMaps(auto, explicit);
    expect(merged.map((r) => r.region).sort()).toEqual(["BR", "US"]);
  });

  it("output is sorted by region", () => {
    const auto = [
      { region: "VN", currency: "VND", priceMicros: "1" },
      { region: "JP", currency: "JPY", priceMicros: "2" },
    ];
    const explicit = [{ region: "US", currency: "USD", priceMicros: "3" }];
    expect(mergeRegionMaps(auto, explicit).map((r) => r.region)).toEqual([
      "JP",
      "US",
      "VN",
    ]);
  });
});
