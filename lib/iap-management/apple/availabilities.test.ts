import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  __resetTerritoryCacheForTests,
  collectIncludedTerritoryIds,
  getAllTerritoryIds,
  getAvailabilityForIap,
  setAvailabilityToAllTerritories,
} from "./availabilities";

vi.mock("./fetch", () => ({
  iapFetch: vi.fn(),
}));

import { iapFetch } from "./fetch";
const mockedFetch = iapFetch as unknown as ReturnType<typeof vi.fn>;

const fakeCreds = {
  keyId: "k",
  issuerId: "i",
  privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
} as never;

beforeEach(() => {
  mockedFetch.mockReset();
  __resetTerritoryCacheForTests();
});

describe("getAllTerritoryIds", () => {
  it("returns the list pulled from /v1/territories", async () => {
    mockedFetch.mockResolvedValueOnce({
      data: [
        { type: "territories", id: "USA" },
        { type: "territories", id: "VNM" },
        { type: "territories", id: "JPN" },
      ],
    });
    const ids = await getAllTerritoryIds(fakeCreds);
    expect(ids).toEqual(["USA", "VNM", "JPN"]);
    expect(mockedFetch).toHaveBeenCalledWith(
      fakeCreds,
      "GET",
      "/v1/territories?limit=200",
    );
  });

  it("caches the list — second call inside the TTL avoids a second fetch", async () => {
    mockedFetch.mockResolvedValueOnce({
      data: [{ type: "territories", id: "USA" }],
    });
    await getAllTerritoryIds(fakeCreds);
    await getAllTerritoryIds(fakeCreds);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("setAvailabilityToAllTerritories", () => {
  it("POSTs availableInNewTerritories=true + the full territory list", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: [
          { type: "territories", id: "USA" },
          { type: "territories", id: "VNM" },
        ],
      })
      .mockResolvedValueOnce({
        data: {
          type: "inAppPurchaseAvailabilities",
          id: "avail-1",
          attributes: { availableInNewTerritories: true },
        },
      });

    const res = await setAvailabilityToAllTerritories(fakeCreds, "iap-42");

    expect(res.data.id).toBe("avail-1");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const postCall = mockedFetch.mock.calls[1];
    expect(postCall[1]).toBe("POST");
    expect(postCall[2]).toBe("/v1/inAppPurchaseAvailabilities");
    const body = postCall[3];
    expect(body.data.type).toBe("inAppPurchaseAvailabilities");
    expect(body.data.attributes.availableInNewTerritories).toBe(true);
    expect(body.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: "iap-42",
    });
    expect(body.data.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "USA" },
      { type: "territories", id: "VNM" },
    ]);
  });

  it("reuses cached territory ids on a second IAP within the same orchestration", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: [{ type: "territories", id: "USA" }],
      })
      .mockResolvedValueOnce({ data: { id: "av1" } })
      .mockResolvedValueOnce({ data: { id: "av2" } });

    await setAvailabilityToAllTerritories(fakeCreds, "iap-1");
    await setAvailabilityToAllTerritories(fakeCreds, "iap-2");

    // 1 territories fetch + 2 POSTs = 3 calls total (not 4).
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });
});

describe("getAvailabilityForIap", () => {
  it("returns availability with inlined territory ids when Apple responds 200", async () => {
    mockedFetch.mockResolvedValueOnce({
      data: {
        type: "inAppPurchaseAvailabilities",
        id: "avail-1",
        attributes: { availableInNewTerritories: true },
        relationships: {
          availableTerritories: { links: {} },
        },
      },
      included: [
        { type: "territories", id: "USA" },
        { type: "territories", id: "VNM" },
        { type: "apps", id: "should-be-filtered" },
      ],
    });
    const out = await getAvailabilityForIap(fakeCreds, "iap-1");
    expect(out).toEqual({
      availableInNewTerritories: true,
      territoryCount: 2,
      territoryIds: ["USA", "VNM"],
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      fakeCreds,
      "GET",
      "/v2/inAppPurchases/iap-1/inAppPurchaseAvailability?include=availableTerritories&limit[availableTerritories]=200",
    );
  });

  it("returns null when Apple responds 404 (no availability resource yet)", async () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    mockedFetch.mockRejectedValueOnce(err);
    const out = await getAvailabilityForIap(fakeCreds, "iap-1");
    expect(out).toBeNull();
  });

  it("propagates non-404 errors so the section can surface a friendly note", async () => {
    const err = Object.assign(new Error("Apple boom"), { status: 503 });
    mockedFetch.mockRejectedValueOnce(err);
    await expect(getAvailabilityForIap(fakeCreds, "iap-1")).rejects.toThrow(
      "Apple boom",
    );
  });

  it("returns availableInNewTerritories=false when Apple omits attributes", async () => {
    mockedFetch.mockResolvedValueOnce({
      data: {
        type: "inAppPurchaseAvailabilities",
        id: "avail-1",
      },
      included: [],
    });
    const out = await getAvailabilityForIap(fakeCreds, "iap-1");
    expect(out?.availableInNewTerritories).toBe(false);
    expect(out?.territoryCount).toBe(0);
  });
});

describe("collectIncludedTerritoryIds (pure helper)", () => {
  it("filters non-territory resources from included[]", () => {
    const ids = collectIncludedTerritoryIds({
      data: { type: "inAppPurchaseAvailabilities", id: "x" },
      included: [
        { type: "territories", id: "USA" },
        { type: "apps", id: "drop" },
        { type: "territories", id: "JPN" },
      ],
    } as never);
    expect(ids).toEqual(["USA", "JPN"]);
  });

  it("returns [] when included is missing entirely", () => {
    expect(
      collectIncludedTerritoryIds({
        data: { type: "inAppPurchaseAvailabilities", id: "x" },
      } as never),
    ).toEqual([]);
  });
});
