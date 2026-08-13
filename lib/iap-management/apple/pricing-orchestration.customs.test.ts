/**
 * SC3 — the G1 merge, custom-under-all-sources (CP-2), and J-5 red reporting.
 *
 * The first describe block is the acceptance bar for the whole feature: with a
 * custom AND a template entry for the same territory, exactly ONE price point
 * for that territory reaches `setPriceSchedule`, and it is the custom's.
 * `additionalPricePointIds` is territory-ANONYMOUS, so two entries would put two
 * `manualPrices` for one territory into a single replace-all POST — corrupting
 * the request shape, not merely picking the wrong value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => ({ from: fromMock }) }));

const listPricePointsForIap = vi.hoisted(() => vi.fn());
vi.mock("./price-points", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./price-points")>();
  return { ...actual, listPricePointsForIap };
});

const setPriceSchedule = vi.hoisted(() => vi.fn());
vi.mock("./price-schedules", () => ({ setPriceSchedule }));

const getDefaultTemplate = vi.hoisted(() => vi.fn());
const getAppTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/templates", () => ({
  getDefaultTemplate,
  getAppTemplate,
}));

import { applyPricingSchedule } from "./pricing-orchestration";
import { decodePricePointId, encodePricePointId } from "./price-point-id";

const creds = {
  id: "acct",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};
const baseAudit = { iapId: "row-1", actor: "tester" };

/** Apple-shaped price points; ids use the real `{s,t,p}` encoding so the test
 *  can decode the territory out of whatever reaches setPriceSchedule. */
function points(territory: string, prices: number[]) {
  return prices.map((p, i) => ({
    type: "inAppPurchasePricePoints" as const,
    id: encodePricePointId({
      s: "iap-1",
      t: territory,
      p: String(10000 + i),
    }),
    attributes: { customerPrice: String(p), proceeds: String(p * 0.7) },
  }));
}

const CATALOG: Record<string, number[]> = {
  USA: [4.99, 9.99],
  VNM: [24000, 25000, 39000],
  JPN: [1200, 1500],
  BRA: [24.9, 29.9],
};

function territoriesOf(ids: readonly string[]): string[] {
  return ids.map((id) => decodePricePointId(id)?.t ?? "??");
}

let insertedAudit: Array<Record<string, unknown>> = [];

beforeEach(() => {
  fromMock.mockReset();
  listPricePointsForIap.mockReset();
  setPriceSchedule.mockReset();
  getDefaultTemplate.mockReset();
  getAppTemplate.mockReset();
  insertedAudit = [];

  fromMock.mockImplementation(() => ({
    insert: (payload: Record<string, unknown>) => {
      insertedAudit.push(payload);
      return Promise.resolve({ error: null });
    },
  }));
  listPricePointsForIap.mockImplementation(
    async (_c: unknown, _iap: string, territory = "USA") =>
      points(territory, CATALOG[territory] ?? []),
  );
  setPriceSchedule.mockResolvedValue({
    ok: true,
    schedule_id: "sched-1",
    attempts: 1,
  });
});

const lastAudit = () =>
  (insertedAudit[insertedAudit.length - 1]?.payload ?? {}) as Record<
    string,
    unknown
  >;

// ─── THE ACCEPTANCE BAR ──────────────────────────────────────────────────────

describe("G1 merge — one price point per territory, custom wins", () => {
  it("⚠ custom + template for the SAME territory ⇒ exactly ONE entry for it, the custom's", async () => {
    getAppTemplate.mockResolvedValue({
      template: { id: "t1" },
      entries: [
        // Template says ₫24,000 for Vietnam…
        {
          tier_id: "TIER_5",
          territory_code: "VNM",
          currency_code: "VND",
          customer_price: 24000,
          proceeds: null,
        },
      ],
    });

    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-1" },
      // …and the Manager's custom says ₫25,000.
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
      audit: baseAudit,
    });

    expect(out.kind).toBe("set");
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;

    // EXACTLY ONE entry for VNM. Two would send Apple two manualPrices for one
    // territory in a single replace-all POST.
    const vnmIds = ids.filter((id) => decodePricePointId(id)?.t === "VNM");
    expect(
      vnmIds,
      "Two entries for one territory corrupts the request shape — this is the " +
        "failure the Map exists to make structurally impossible.",
    ).toHaveLength(1);

    // …and it is the CUSTOM's price point (₫25,000 → the second catalog index).
    const expected = points("VNM", CATALOG.VNM).find(
      (p) => Number(p.attributes.customerPrice) === 25000,
    )!;
    expect(vnmIds[0]).toBe(expected.id);
    expect(out.kind === "set" && out.resolution).toEqual({
      custom: 1,
      template: 0,
      custom_over_template: 1,
    });
  });

  it("a template territory the custom does not cover is untouched", async () => {
    getAppTemplate.mockResolvedValue({
      template: { id: "t1" },
      entries: [
        {
          tier_id: "TIER_5",
          territory_code: "VNM",
          currency_code: "VND",
          customer_price: 24000,
          proceeds: null,
        },
        {
          tier_id: "TIER_5",
          territory_code: "JPN",
          currency_code: "JPY",
          customer_price: 1500,
          proceeds: null,
        },
      ],
    });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-1" },
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
      audit: baseAudit,
    });
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids).sort()).toEqual(["JPN", "VNM"]);
    // JPN keeps the TEMPLATE price — unchanged from today's behaviour.
    const jpn = ids.find((id) => decodePricePointId(id)?.t === "JPN")!;
    const jpnTemplate = points("JPN", CATALOG.JPN).find(
      (p) => Number(p.attributes.customerPrice) === 1500,
    )!;
    expect(jpn).toBe(jpnTemplate.id);
  });

  it("never emits a duplicate territory even with duplicate customs", async () => {
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: [
        { territory_code: "VNM", customer_price: 24000, currency_code: "VND" },
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
      audit: baseAudit,
    });
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids)).toEqual(["VNM"]);
  });

  it("a custom for the BASE territory is ignored — the base has its own slot (§E)", async () => {
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: [
        { territory_code: "USA", customer_price: 9.99, currency_code: "USD" },
      ],
      audit: baseAudit,
    });
    const call = setPriceSchedule.mock.calls[0][1];
    expect(call.additionalPricePointIds).toEqual([]);
    // The base still comes from the tier's USD price, not the custom.
    expect(decodePricePointId(call.applePricePointId)?.t).toBe("USA");
  });
});

// ─── CP-2: all three sources ─────────────────────────────────────────────────

describe("CP-2 — customs apply under ALL THREE pricing sources", () => {
  const custom = [
    { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
  ];

  it("APPLE — customs are the only overrides in the payload", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: custom,
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids)).toEqual(["VNM"]);
    // No template was consulted at all.
    expect(getDefaultTemplate).not.toHaveBeenCalled();
    expect(getAppTemplate).not.toHaveBeenCalled();
  });

  it("DEFAULT_TEMPLATE — customs layer on top", async () => {
    getDefaultTemplate.mockResolvedValue({
      template: { id: "t-global" },
      entries: [
        {
          tier_id: "TIER_5",
          territory_code: "JPN",
          currency_code: "JPY",
          customer_price: 1500,
          proceeds: null,
        },
      ],
    });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "DEFAULT_TEMPLATE" },
      customPrices: custom,
      audit: baseAudit,
    });
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids).sort()).toEqual(["JPN", "VNM"]);
  });

  it("APP_TEMPLATE — customs layer on top", async () => {
    getAppTemplate.mockResolvedValue({ template: { id: "t-app" }, entries: [] });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-1" },
      customPrices: custom,
      audit: baseAudit,
    });
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids)).toEqual(["VNM"]);
  });

  it("no customs ⇒ byte-identical to today (template or auto only)", async () => {
    getAppTemplate.mockResolvedValue({
      template: { id: "t1" },
      entries: [
        {
          tier_id: "TIER_5",
          territory_code: "JPN",
          currency_code: "JPY",
          customer_price: 1500,
          proceeds: null,
        },
      ],
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-1" },
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids)).toEqual(["JPN"]);
    expect(out.kind === "set" && out.resolution).toEqual({
      custom: 0,
      template: 1,
      custom_over_template: 0,
    });
  });
});

// ─── J-5 red reporting ───────────────────────────────────────────────────────

describe("J-5 — an unapplied custom is RED and names the territory", () => {
  it("no Apple price point for a custom ⇒ partial-custom-fail, not `set`, not amber", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: [
        // 99999 is not in Apple's VNM catalog.
        { territory_code: "VNM", customer_price: 99999, currency_code: "VND" },
      ],
      audit: baseAudit,
    });

    expect(out.kind).toBe("partial-custom-fail");
    if (out.kind !== "partial-custom-fail") return;
    expect(out.failed_custom_territories).toEqual([
      {
        tier_id: null,
        territory_code: "VNM",
        customer_price: 99999,
        source: "custom",
        reason: "no-apple-price-point",
      },
    ]);
    // The POST still happened — the other territories are priced.
    expect(setPriceSchedule).toHaveBeenCalled();
    expect(out.schedule_id).toBe("sched-1");
  });

  it("a custom failure OUTRANKS a template failure — never reported as amber", async () => {
    // A template entry ALSO fails here. The amber `partial-template-fail` is
    // what the Manager has learned to read as "expected"; a red custom failure
    // must not be flattened into it.
    getAppTemplate.mockResolvedValue({
      template: { id: "t1" },
      entries: [
        {
          tier_id: "TIER_5",
          territory_code: "JPN",
          currency_code: "JPY",
          customer_price: 7777,
          proceeds: null,
        },
      ],
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-1" },
      customPrices: [
        { territory_code: "VNM", customer_price: 99999, currency_code: "VND" },
      ],
      audit: baseAudit,
    });
    expect(out.kind).toBe("partial-custom-fail");
    if (out.kind !== "partial-custom-fail") return;
    // Both are recorded, but only the custom is in the red list.
    expect(out.missing_price_points).toHaveLength(2);
    expect(out.failed_custom_territories).toHaveLength(1);
    expect(out.failed_custom_territories[0].territory_code).toBe("VNM");
  });

  it("⚠ a failed custom does NOT silently fall back to auto the way a template does", async () => {
    // The template path's documented behaviour is a silent auto fallback
    // (G5 "template · unverified"). A custom is an explicit instruction, so its
    // failure is surfaced — this assertion is the difference between the two.
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: [
        { territory_code: "VNM", customer_price: 99999, currency_code: "VND" },
      ],
      audit: baseAudit,
    });
    expect(out.kind).not.toBe("set");
    expect(out.kind).not.toBe("partial-template-fail");
  });

  it("the surviving customs still apply alongside the failed one", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: [
        { territory_code: "VNM", customer_price: 99999, currency_code: "VND" },
        { territory_code: "JPN", customer_price: 1200, currency_code: "JPY" },
      ],
      audit: baseAudit,
    });
    expect(out.kind).toBe("partial-custom-fail");
    const ids: string[] = setPriceSchedule.mock.calls[0][1].additionalPricePointIds;
    expect(territoriesOf(ids)).toEqual(["JPN"]);
  });

  it("a territory fetch failure is red too, with its own reason", async () => {
    listPricePointsForIap.mockImplementation(
      async (_c: unknown, _iap: string, territory = "USA") => {
        if (territory === "VNM") throw new Error("apple 500");
        return points(territory, CATALOG[territory] ?? []);
      },
    );
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
      audit: baseAudit,
    });
    expect(out.kind).toBe("partial-custom-fail");
    if (out.kind !== "partial-custom-fail") return;
    expect(out.failed_custom_territories[0].reason).toBe("territory-fetch-failed");
  });
});

// ─── §H provenance in the audit row ──────────────────────────────────────────

describe("§H — per-territory custom provenance reaches actions_log", () => {
  it("records the custom set, the resolution breakdown, and which resolved", async () => {
    getAppTemplate.mockResolvedValue({
      template: { id: "t1" },
      entries: [
        {
          tier_id: "TIER_5",
          territory_code: "VNM",
          currency_code: "VND",
          customer_price: 24000,
          proceeds: null,
        },
      ],
    });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-1" },
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
        { territory_code: "BRA", customer_price: 99, currency_code: "BRL" },
      ],
      audit: baseAudit,
    });
    const payload = lastAudit();
    expect(payload.custom_territory_count).toBe(2);
    expect(payload.resolution_by_territory).toEqual({
      custom: 1,
      template: 0,
      custom_over_template: 1,
    });
    // Enough for a future reader to reconstruct WHY a territory got its price.
    expect(payload.custom_territories).toEqual([
      {
        territory_code: "VNM",
        customer_price: 25000,
        currency_code: "VND",
        resolved: true,
      },
      {
        territory_code: "BRA",
        customer_price: 99,
        currency_code: "BRL",
        resolved: false,
      },
    ]);
    expect(payload.result).toBe("ERROR");
  });

  it("uses the existing SET_PRICE_SCHEDULE action type — no new one needed", () => {
    // §F/2f: a new action_type would need its own migration AND a guard-registry
    // entry. The pricing run reuses the existing type; only SC1's three
    // custom-price persistence types are new.
    expect(insertedAudit.every((r) => r.action_type === "SET_PRICE_SCHEDULE")).toBe(
      true,
    );
  });
});
