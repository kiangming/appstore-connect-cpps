import { describe, it, expect, vi, beforeEach } from "vitest";

const listPricePointsForIap = vi.hoisted(() => vi.fn());
vi.mock("./price-points", async () => {
  const actual = await vi.importActual<typeof import("./price-points")>(
    "./price-points",
  );
  return {
    ...actual,
    listPricePointsForIap,
  };
});

import { createTerritoryPricePointsCache } from "./territory-price-points-cache";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

const samplePoint = (id: string) => ({
  type: "inAppPurchasePricePoints" as const,
  id,
  attributes: { customerPrice: "1.99", proceeds: "1.40" },
});

describe("createTerritoryPricePointsCache (IAP.p1.e)", () => {
  beforeEach(() => listPricePointsForIap.mockReset());

  it("fetches a territory once, then caches subsequent reads", async () => {
    listPricePointsForIap.mockResolvedValueOnce([samplePoint("pp-vnm-1")]);
    const cache = createTerritoryPricePointsCache(creds, "iap-1");
    const a = await cache.get("VNM");
    const b = await cache.get("VNM");
    expect(a).toBe(b);
    expect(listPricePointsForIap).toHaveBeenCalledTimes(1);
    expect(listPricePointsForIap).toHaveBeenCalledWith(creds, "iap-1", "VNM");
    expect(cache.size()).toBe(1);
  });

  it("dedupes concurrent fetches for the same territory", async () => {
    let resolveFn: ((v: unknown) => void) | null = null;
    listPricePointsForIap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve as (v: unknown) => void;
        }),
    );
    const cache = createTerritoryPricePointsCache(creds, "iap-1");
    const p1 = cache.get("VNM");
    const p2 = cache.get("VNM");
    expect(listPricePointsForIap).toHaveBeenCalledTimes(1);
    resolveFn!([samplePoint("pp-vnm-1")]);
    expect(await p1).toBe(await p2);
  });

  it("primed entries are served without an Apple fetch", async () => {
    const cache = createTerritoryPricePointsCache(creds, "iap-1");
    cache.prime("USA", [samplePoint("pp-usa-099")]);
    const usa = await cache.get("USA");
    expect(usa[0].id).toBe("pp-usa-099");
    expect(listPricePointsForIap).not.toHaveBeenCalled();
  });

  it("propagates fetch errors and releases the in-flight slot", async () => {
    listPricePointsForIap.mockRejectedValueOnce(new Error("Apple 500"));
    const cache = createTerritoryPricePointsCache(creds, "iap-1");
    await expect(cache.get("VNM")).rejects.toThrow("Apple 500");
    // Retry should fire a fresh fetch — old in-flight cleared.
    listPricePointsForIap.mockResolvedValueOnce([samplePoint("pp-vnm-1")]);
    const points = await cache.get("VNM");
    expect(points[0].id).toBe("pp-vnm-1");
    expect(listPricePointsForIap).toHaveBeenCalledTimes(2);
  });
});
