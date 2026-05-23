import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  __resetTerritoryCacheForTests,
  getAllTerritoryIds,
  getAvailabilityForIap,
  nextCursorFrom,
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

describe("getAvailabilityForIap (Hotfix 22 — V1 sub-resource pattern)", () => {
  it("issues the V2 metadata GET first, then the V1 sub-resource GET", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: {
          type: "inAppPurchaseAvailabilities",
          id: "avail-42",
          attributes: { availableInNewTerritories: true },
        },
      })
      .mockResolvedValueOnce({
        data: [
          { type: "territories", id: "USA" },
          { type: "territories", id: "VNM" },
        ],
        links: { next: null },
      });

    const out = await getAvailabilityForIap(fakeCreds, "iap-1");

    expect(out).toEqual({
      availableInNewTerritories: true,
      territoryCount: 2,
      territoryIds: ["USA", "VNM"],
    });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls[0][2]).toBe(
      "/v2/inAppPurchases/iap-1/inAppPurchaseAvailability",
    );
    // The sub-resource path uses the V1 endpoint with limit=200 (the
    // main-resource limit Apple's V1 endpoint honours — the bug fixed
    // by Hotfix 22 was requesting limit=200 on the V2 ?include path,
    // where Apple caps it at 50).
    expect(mockedFetch.mock.calls[1][2]).toBe(
      "/v1/inAppPurchaseAvailabilities/avail-42/availableTerritories?limit=200",
    );
  });

  it("walks links.next when the territory list spans multiple pages (cursor pagination)", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: {
          type: "inAppPurchaseAvailabilities",
          id: "avail-42",
          attributes: { availableInNewTerritories: true },
        },
      })
      .mockResolvedValueOnce({
        data: [
          { type: "territories", id: "USA" },
          { type: "territories", id: "VNM" },
        ],
        links: {
          next:
            "https://api.appstoreconnect.apple.com/v1/inAppPurchaseAvailabilities/avail-42/availableTerritories?limit=200&cursor=page2",
        },
      })
      .mockResolvedValueOnce({
        data: [{ type: "territories", id: "JPN" }],
        links: { next: null },
      });

    const out = await getAvailabilityForIap(fakeCreds, "iap-1");

    expect(out?.territoryIds).toEqual(["USA", "VNM", "JPN"]);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    // Page-2 cursor should arrive at the wrapper as a relative path.
    expect(mockedFetch.mock.calls[2][2]).toBe(
      "/v1/inAppPurchaseAvailabilities/avail-42/availableTerritories?limit=200&cursor=page2",
    );
  });

  it("returns null when Apple responds 404 to the metadata call (no availability resource)", async () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    mockedFetch.mockRejectedValueOnce(err);
    const out = await getAvailabilityForIap(fakeCreds, "iap-1");
    expect(out).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("propagates non-404 errors from the metadata call so the section can surface them", async () => {
    const err = Object.assign(new Error("Apple boom"), { status: 503 });
    mockedFetch.mockRejectedValueOnce(err);
    await expect(getAvailabilityForIap(fakeCreds, "iap-1")).rejects.toThrow(
      "Apple boom",
    );
  });

  it("falls back to an empty territory list when the metadata succeeds but the sub-resource fetch fails", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: {
          type: "inAppPurchaseAvailabilities",
          id: "avail-42",
          attributes: { availableInNewTerritories: false },
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("Sub-resource boom"), { status: 500 }),
      );

    const out = await getAvailabilityForIap(fakeCreds, "iap-1");
    expect(out).toEqual({
      availableInNewTerritories: false,
      territoryCount: 0,
      territoryIds: [],
    });
  });

  it("returns availableInNewTerritories=false when Apple omits the attributes block", async () => {
    mockedFetch
      .mockResolvedValueOnce({
        data: { type: "inAppPurchaseAvailabilities", id: "avail-42" },
      })
      .mockResolvedValueOnce({ data: [], links: { next: null } });
    const out = await getAvailabilityForIap(fakeCreds, "iap-1");
    expect(out).toEqual({
      availableInNewTerritories: false,
      territoryCount: 0,
      territoryIds: [],
    });
  });
});

describe("nextCursorFrom (pure cursor extractor)", () => {
  it("strips the host from Apple's absolute next-URL so iapFetch receives a relative path", () => {
    expect(
      nextCursorFrom({
        data: [],
        links: {
          next:
            "https://api.appstoreconnect.apple.com/v1/inAppPurchaseAvailabilities/x/availableTerritories?cursor=2",
        },
      }),
    ).toBe("/v1/inAppPurchaseAvailabilities/x/availableTerritories?cursor=2");
  });

  it("returns null when links.next is absent", () => {
    expect(nextCursorFrom({ data: [], links: {} })).toBeNull();
    expect(nextCursorFrom({ data: [] })).toBeNull();
  });

  it("passes through an already-relative cursor unchanged (defensive)", () => {
    expect(
      nextCursorFrom({ data: [], links: { next: "/v1/foo?cursor=2" } }),
    ).toBe("/v1/foo?cursor=2");
  });
});
