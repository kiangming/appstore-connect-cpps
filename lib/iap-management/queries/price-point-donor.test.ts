/**
 * Donor-IAP resolution (gate G2 / J-1).
 *
 * The property that matters most is a NEGATIVE one: with no synced IAP there is
 * NO fallback to `price_tier_territories`. That CSV is Manager-uploaded, carries
 * ~96 prices per territory against Apple's ~600, and can name prices Apple has
 * no point for — a picker built on it would offer choices guaranteed to fail at
 * submit. `null` here is the honest dead-end the design chose.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ iapDb: () => ({ from: fromMock }) }));

import { findPricePointDonor, resolvePricePointSource } from "./price-point-donor";

interface Row {
  id: string;
  apple_iap_id: string | null;
  type: string | null;
}

function harness(rows: Row[], error?: { message: string }) {
  const tables: string[] = [];
  fromMock.mockImplementation((table: string) => {
    tables.push(table);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    b.not = chain;
    b.order = () => Promise.resolve({ data: rows, error: error ?? null });
    return b;
  });
  return { tables };
}

beforeEach(() => fromMock.mockReset());

describe("findPricePointDonor", () => {
  it("returns null when the app has no synced IAP", async () => {
    harness([]);
    expect(await findPricePointDonor({ appId: "app-1" })).toBeNull();
  });

  it("⚠ never reads price_tier_territories — no CSV fallback exists", async () => {
    const { tables } = harness([]);
    await findPricePointDonor({ appId: "app-1" });
    expect(
      tables,
      "A fallback to the Manager-uploaded CSV would offer prices Apple may have " +
        "no point for, i.e. a picker whose choices are guaranteed to fail at submit.",
    ).toEqual(["iaps"]);
    expect(tables).not.toContain("price_tier_territories");
  });

  it("prefers a donor of the same IAP type", async () => {
    harness([
      { id: "a", apple_iap_id: "apple-a", type: "NON_CONSUMABLE" },
      { id: "b", apple_iap_id: "apple-b", type: "CONSUMABLE" },
    ]);
    const donor = await findPricePointDonor({ appId: "app-1", type: "CONSUMABLE" });
    expect(donor).toEqual({ appleIapId: "apple-b", iapId: "b", sameType: true });
  });

  it("falls back to any synced IAP when no type matches, and flags sameType=false", async () => {
    // Defensive rather than proven: batch-price-point-catalog.ts:29-31 states the
    // per-type catalog difference cannot be proven either way.
    harness([{ id: "a", apple_iap_id: "apple-a", type: "NON_CONSUMABLE" }]);
    const donor = await findPricePointDonor({
      appId: "app-1",
      type: "CONSUMABLE",
    });
    expect(donor).toEqual({ appleIapId: "apple-a", iapId: "a", sameType: false });
  });

  it("excludes the IAP being edited", async () => {
    harness([{ id: "self", apple_iap_id: "apple-self", type: "CONSUMABLE" }]);
    expect(
      await findPricePointDonor({ appId: "app-1", excludeIapId: "self" }),
    ).toBeNull();
  });

  it("skips rows whose apple_iap_id is null", async () => {
    harness([{ id: "a", apple_iap_id: null, type: "CONSUMABLE" }]);
    expect(await findPricePointDonor({ appId: "app-1" })).toBeNull();
  });

  it("throws with the app id on a lookup failure", async () => {
    harness([], { message: "boom" });
    await expect(findPricePointDonor({ appId: "app-1" })).rejects.toThrow(
      /app-1.*boom/,
    );
  });
});

describe("resolvePricePointSource", () => {
  it("uses the IAP itself when it is already synced — no donor query at all", async () => {
    const { tables } = harness([]);
    const source = await resolvePricePointSource({
      iapId: "iap-1",
      appId: "app-1",
      appleIapId: "apple-1",
    });
    expect(source).toEqual({
      appleIapId: "apple-1",
      iapId: "iap-1",
      sameType: true,
    });
    expect(tables).toEqual([]);
  });

  it("falls back to a donor for an unsynced draft", async () => {
    harness([{ id: "other", apple_iap_id: "apple-other", type: "CONSUMABLE" }]);
    const source = await resolvePricePointSource({
      iapId: "iap-draft",
      appId: "app-1",
      appleIapId: null,
      type: "CONSUMABLE",
    });
    expect(source?.appleIapId).toBe("apple-other");
  });

  it("null for an unsynced draft in an app with nothing on Apple (the J-1 state)", async () => {
    harness([]);
    expect(
      await resolvePricePointSource({
        iapId: "iap-draft",
        appId: "app-1",
        appleIapId: null,
      }),
    ).toBeNull();
  });
});

describe("the picker route offers prices, never price-point ids (gate G2)", () => {
  it("the response shape carries no id field", () => {
    // A structural read: handing an id to the client invites storing it, and a
    // stored id goes stale the moment Apple withdraws that point.
    const src = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "app/api/iap-management/apps/[appId]/iaps/[iapId]/price-points/route.ts",
      ),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/prices:\s*number\[\]/);
    expect(/pricePointId|price_point_id/.test(src)).toBe(false);
    // Reuses the orchestrator's own fetcher, so the client's option list and the
    // server's match list can never come from different sources (§I.5).
    expect(src).toContain("listPricePointsForIap");
  });
});
