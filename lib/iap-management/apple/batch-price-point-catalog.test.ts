/**
 * Cycle 44 — batch-level price-point catalog.
 *
 * Proves the optimization's contract: fetch each (iapType, territory) ONCE
 * for the whole batch, derive each item's price-point id locally, and
 * auto-fall-back to per-item fetch if Apple's id encoding ever diverges.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AscCredentials } from "@/lib/asc-jwt";

const listPricePointsForIap = vi.hoisted(() => vi.fn());
vi.mock("./price-points", () => ({ listPricePointsForIap }));

import { createBatchPricePointCatalog } from "./batch-price-point-catalog";
import { encodePricePointId, decodePricePointId } from "./price-point-id";

const creds: AscCredentials = {
  id: "acct",
  name: "Acct",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

/** Realistic price points whose ids encode the requesting IAP (so the
 *  round-trip guard passes and derivation is meaningful). */
function validPoints(iap: string, territory: string) {
  return [
    {
      type: "inAppPurchasePricePoints",
      id: encodePricePointId({ s: iap, t: territory, p: "10000" }),
      attributes: { customerPrice: "0.99", proceeds: "0.70" },
    },
    {
      type: "inAppPurchasePricePoints",
      id: encodePricePointId({ s: iap, t: territory, p: "10001" }),
      attributes: { customerPrice: "1.99", proceeds: "1.40" },
    },
  ];
}

beforeEach(() => {
  listPricePointsForIap.mockReset();
});

describe("createBatchPricePointCatalog", () => {
  it("fetches each (type, territory) ONCE and reuses across items", async () => {
    listPricePointsForIap.mockImplementation((_c, iap, terr) =>
      Promise.resolve(validPoints(iap, terr)),
    );
    const cat = createBatchPricePointCatalog(creds);

    const a = await cat.territory("iap-A", "CONSUMABLE", "COL"); // warm
    const b = await cat.territory("iap-B", "CONSUMABLE", "COL"); // reuse

    expect(listPricePointsForIap).toHaveBeenCalledTimes(1);
    expect(cat.stats()).toEqual({
      territoriesWarmed: 1,
      fetches: 1,
      derivationEnabled: true,
    });
    // b reuses the warm list (ids encode iap-A); deriveId maps to iap-B.
    expect(decodePricePointId(b.points[0].id)?.s).toBe("iap-A");
    expect(decodePricePointId(b.deriveId(b.points[0].id))?.s).toBe("iap-B");
    // warm requester (A) gets identity-equivalent ids back.
    expect(a.deriveId(a.points[0].id)).toBe(a.points[0].id);
  });

  it("keys the cache by IAP type (different types fetch separately)", async () => {
    listPricePointsForIap.mockImplementation((_c, iap, terr) =>
      Promise.resolve(validPoints(iap, terr)),
    );
    const cat = createBatchPricePointCatalog(creds);

    await cat.territory("iap-A", "CONSUMABLE", "COL");
    await cat.territory("iap-A", "NON_CONSUMABLE", "COL");
    await cat.territory("iap-B", "CONSUMABLE", "COL"); // reuse CONSUMABLE::COL

    expect(listPricePointsForIap).toHaveBeenCalledTimes(2);
    expect(cat.stats().territoriesWarmed).toBe(2);
  });

  it("derived id is byte-equal to a real per-IAP fetch for the target IAP", async () => {
    listPricePointsForIap.mockImplementation((_c, iap, terr) =>
      Promise.resolve(validPoints(iap, terr)),
    );
    const cat = createBatchPricePointCatalog(creds);

    // Warm with iap-A, then resolve iap-B from the cache and derive ITS id.
    await cat.territory("iap-A", "CONSUMABLE", "JPN");
    const b = await cat.territory("iap-B", "CONSUMABLE", "JPN");
    const derived = b.deriveId(b.points[1].id);
    // What iap-B's own fetch would have returned for the same (territory, tier):
    const realForB = validPoints("iap-B", "JPN")[1].id;
    expect(derived).toBe(realForB);
    expect(listPricePointsForIap).toHaveBeenCalledTimes(1); // iap-B added no fetch
  });

  it("falls back to per-item fetch when Apple's id encoding diverges (guard fails)", async () => {
    // Apple returns an id that is NOT the {s,t,p} encoding → guard must trip.
    listPricePointsForIap.mockImplementation((_c, _iap, _terr) =>
      Promise.resolve([
        {
          type: "inAppPurchasePricePoints",
          id: "opaque-random-token-not-stp",
          attributes: { customerPrice: "0.99", proceeds: "0.70" },
        },
      ]),
    );
    const cat = createBatchPricePointCatalog(creds);

    const r1 = await cat.territory("iap-A", "CONSUMABLE", "COL");
    expect(cat.stats().derivationEnabled).toBe(false);
    // deriveId is identity in fallback (points already carry the requester's ids)
    expect(r1.deriveId("anything")).toBe("anything");

    const callsBefore = listPricePointsForIap.mock.calls.length;
    const r2 = await cat.territory("iap-B", "CONSUMABLE", "COL");
    // fallback = fresh fetch per item (no cross-item reuse), identity mapper
    expect(listPricePointsForIap.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(r2.deriveId("x")).toBe("x");
    expect(cat.stats().territoriesWarmed).toBe(0); // nothing cached under fallback
  });
});
