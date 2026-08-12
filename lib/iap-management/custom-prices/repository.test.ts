/**
 * Per-territory Custom Prices — the single-writer repository.
 *
 * Locks the properties that are invisible in the happy path but decide whether
 * a failure is safe:
 *   · round-trip stores and returns exactly (territory, price, currency) —
 *     never a price-point id
 *   · replace-all order is delete → insert → stamp, so every crash point
 *     leaves a state that reads as empty or STALE, never as clean-but-wrong
 *   · each operation writes its own typed action type
 *   · an audit-write failure never fails the persistence operation, but is
 *     always logged
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => ({ from: fromMock }) }));

import {
  clearCustomPrices,
  getCustomPriceState,
  listCustomPrices,
  readCustomPriceBaseline,
  replaceCustomPrices,
  restampCustomPriceBaseline,
} from "./repository";
import type { CustomPriceBaseline, CustomPriceEntry } from "./model";

const BASELINE: CustomPriceBaseline = {
  tier_id: "TIER_10",
  pricing_source: "APP_TEMPLATE",
  base_territory: "USA",
};

const VNM: CustomPriceEntry = {
  territory_code: "VNM",
  customer_price: 25000,
  currency_code: "VND",
};
const JPN: CustomPriceEntry = {
  territory_code: "JPN",
  customer_price: 1200,
  currency_code: "JPY",
};

/** Records every call so ordering and payloads are assertable. */
interface Recorded {
  table: string;
  op: string;
  payload?: unknown;
}

function harness(opts?: {
  selectRows?: Record<string, { data: unknown; error: unknown }>;
  errorOn?: { table: string; op: string; message: string };
}) {
  const calls: Recorded[] = [];
  const fail = (table: string, op: string) =>
    opts?.errorOn && opts.errorOn.table === table && opts.errorOn.op === op
      ? { message: opts.errorOn.message }
      : null;

  fromMock.mockImplementation((table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = (cols: string) => {
      calls.push({ table, op: "select", payload: cols });
      return b;
    };
    b.eq = chain;
    b.order = chain;
    b.maybeSingle = () =>
      Promise.resolve(
        opts?.selectRows?.[`${table}:single`] ?? { data: null, error: null },
      );
    b.insert = (payload: unknown) => {
      calls.push({ table, op: "insert", payload });
      return Promise.resolve({ data: null, error: fail(table, "insert") });
    };
    b.update = (payload: unknown) => {
      calls.push({ table, op: "update", payload });
      const r = { data: null, error: fail(table, "update") };
      const u: Record<string, unknown> = {};
      u.eq = () => Promise.resolve(r);
      return u;
    };
    b.delete = () => {
      calls.push({ table, op: "delete" });
      const r = { data: null, error: fail(table, "delete") };
      const d: Record<string, unknown> = {};
      d.eq = () => Promise.resolve(r);
      return d;
    };
    b.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve(
        opts?.selectRows?.[`${table}:list`] ?? { data: [], error: null },
      ).then(resolve, reject);
    return b;
  });

  return { calls };
}

const auditRows = (calls: Recorded[]) =>
  calls
    .filter((c) => c.table === "actions_log" && c.op === "insert")
    .map((c) => c.payload as { action_type: string; payload: Record<string, unknown> });

beforeEach(() => fromMock.mockReset());
afterEach(() => vi.restoreAllMocks());

// ─── Reads ───────────────────────────────────────────────────────────────────

describe("listCustomPrices", () => {
  it("returns exactly (territory_code, customer_price, currency_code) — no price-point id", async () => {
    harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [
            { territory_code: "VNM", currency_code: "VND", customer_price: 25000 },
          ],
          error: null,
        },
      },
    });
    const out = await listCustomPrices("iap-1");
    expect(out).toEqual([VNM]);
    expect(Object.keys(out[0]).sort()).toEqual([
      "currency_code",
      "customer_price",
      "territory_code",
    ]);
  });

  it("coerces a PostgREST NUMERIC-as-string price to a number", async () => {
    harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [
            { territory_code: "VNM", currency_code: "VND", customer_price: "25000.0000" },
          ],
          error: null,
        },
      },
    });
    const out = await listCustomPrices("iap-1");
    expect(out[0].customer_price).toBe(25000);
    expect(typeof out[0].customer_price).toBe("number");
  });

  it("throws with the IAP id on a read failure (reads are not fail-soft)", async () => {
    harness({
      selectRows: {
        "iap_custom_prices:list": { data: null, error: { message: "boom" } },
      },
    });
    await expect(listCustomPrices("iap-1")).rejects.toThrow(/iap-1.*boom/);
  });
});

describe("readCustomPriceBaseline", () => {
  it("reads the three fingerprint columns into one object", async () => {
    harness({
      selectRows: {
        "iaps:single": {
          data: {
            custom_prices_baseline_tier_id: "TIER_10",
            custom_prices_baseline_pricing_source: "APP_TEMPLATE",
            custom_prices_baseline_base_territory: "USA",
          },
          error: null,
        },
      },
    });
    expect(await readCustomPriceBaseline("iap-1")).toEqual(BASELINE);
  });

  it("null when the IAP has never had customs", async () => {
    harness({
      selectRows: {
        "iaps:single": {
          data: {
            custom_prices_baseline_tier_id: null,
            custom_prices_baseline_pricing_source: null,
            custom_prices_baseline_base_territory: null,
          },
          error: null,
        },
      },
    });
    expect(await readCustomPriceBaseline("iap-1")).toBeNull();
  });

  it("null — not a half-fingerprint — if a row was hand-edited into an incoherent state", async () => {
    // The DB coherence CHECK makes this unreachable through the app; a partial
    // fingerprint would compare as stale against EVERY possible current
    // baseline, i.e. permanently unresolvable.
    harness({
      selectRows: {
        "iaps:single": {
          data: {
            custom_prices_baseline_tier_id: "TIER_10",
            custom_prices_baseline_pricing_source: null,
            custom_prices_baseline_base_territory: "USA",
          },
          error: null,
        },
      },
    });
    expect(await readCustomPriceBaseline("iap-1")).toBeNull();
  });
});

describe("getCustomPriceState", () => {
  it("returns set + fingerprint together", async () => {
    harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [{ territory_code: "JPN", currency_code: "JPY", customer_price: 1200 }],
          error: null,
        },
        "iaps:single": {
          data: {
            custom_prices_baseline_tier_id: "TIER_10",
            custom_prices_baseline_pricing_source: "APP_TEMPLATE",
            custom_prices_baseline_base_territory: "USA",
          },
          error: null,
        },
      },
    });
    expect(await getCustomPriceState("iap-1")).toEqual({
      entries: [JPN],
      baseline: BASELINE,
    });
  });
});

// ─── replaceCustomPrices ─────────────────────────────────────────────────────

describe("replaceCustomPrices", () => {
  it("writes delete → insert → stamp, in that order", async () => {
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [VNM, JPN],
      baseline: BASELINE,
      actor: "manager@vng.com.vn",
      source: "manual",
    });
    const seq = calls
      .filter((c) => c.table !== "actions_log")
      .map((c) => `${c.table}:${c.op}`);
    expect(seq).toEqual([
      "iap_custom_prices:delete",
      "iap_custom_prices:insert",
      "iaps:update",
    ]);
  });

  it("⚠ order matters: every crash point leaves empty-or-STALE, never clean-but-wrong", async () => {
    // Stamping BEFORE the insert would leave a fresh fingerprint over stale
    // prices — reads as clean, and would ship to a live store. The assertion
    // above pins the safe order; this one states why in one place.
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [VNM],
      baseline: BASELINE,
      actor: "m",
      source: "manual",
    });
    const stampIdx = calls.findIndex((c) => c.table === "iaps" && c.op === "update");
    const insertIdx = calls.findIndex(
      (c) => c.table === "iap_custom_prices" && c.op === "insert",
    );
    expect(stampIdx).toBeGreaterThan(insertIdx);
  });

  it("persists exactly (iap_id, territory, currency, price) — never a price-point id", async () => {
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [VNM],
      baseline: BASELINE,
      actor: "m",
      source: "manual",
    });
    const ins = calls.find(
      (c) => c.table === "iap_custom_prices" && c.op === "insert",
    )!.payload as Array<Record<string, unknown>>;
    expect(ins).toEqual([
      {
        iap_id: "iap-1",
        territory_code: "VNM",
        currency_code: "VND",
        customer_price: 25000,
      },
    ]);
    expect(Object.keys(ins[0]).join()).not.toMatch(/price_point|point_id/i);
  });

  it("normalizes before writing (sorted, deduped last-wins, upper-cased)", async () => {
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [
        VNM,
        { territory_code: "vnm", customer_price: 39000, currency_code: "vnd" },
        JPN,
      ],
      baseline: BASELINE,
      actor: "m",
      source: "manual",
    });
    const ins = calls.find(
      (c) => c.table === "iap_custom_prices" && c.op === "insert",
    )!.payload as Array<Record<string, unknown>>;
    expect(ins.map((r) => r.territory_code)).toEqual(["JPN", "VNM"]);
    expect(ins.find((r) => r.territory_code === "VNM")!.customer_price).toBe(39000);
  });

  it("stamps the fingerprint alongside the set", async () => {
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [VNM],
      baseline: BASELINE,
      actor: "m",
      source: "manual",
    });
    expect(
      calls.find((c) => c.table === "iaps" && c.op === "update")!.payload,
    ).toEqual({
      custom_prices_baseline_tier_id: "TIER_10",
      custom_prices_baseline_pricing_source: "APP_TEMPLATE",
      custom_prices_baseline_base_territory: "USA",
    });
  });

  it("an empty replace nulls the fingerprint and audits as CLEARED, not SAVED", async () => {
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [],
      baseline: BASELINE,
      actor: "m",
      source: "manual",
    });
    expect(
      calls.find((c) => c.table === "iaps" && c.op === "update")!.payload,
    ).toEqual({
      custom_prices_baseline_tier_id: null,
      custom_prices_baseline_pricing_source: null,
      custom_prices_baseline_base_territory: null,
    });
    // No insert at all when there is nothing to insert.
    expect(
      calls.some((c) => c.table === "iap_custom_prices" && c.op === "insert"),
    ).toBe(false);
    expect(auditRows(calls)[0].action_type).toBe("CUSTOM_PRICES_CLEARED");
  });

  it("audits CUSTOM_PRICES_SAVED with the source and the territory list", async () => {
    const { calls } = harness();
    await replaceCustomPrices({
      iapId: "iap-1",
      entries: [VNM],
      baseline: BASELINE,
      actor: "manager@vng.com.vn",
      source: "imported-from-apple",
    });
    const row = auditRows(calls)[0];
    expect(row.action_type).toBe("CUSTOM_PRICES_SAVED");
    expect(row.payload).toMatchObject({
      result: "SUCCESS",
      source: "imported-from-apple",
      territory_count: 1,
      baseline: BASELINE,
      territories: [VNM],
    });
  });

  it("throws on an insert failure rather than reporting a save that did not happen", async () => {
    harness({ errorOn: { table: "iap_custom_prices", op: "insert", message: "pk dup" } });
    await expect(
      replaceCustomPrices({
        iapId: "iap-1",
        entries: [VNM],
        baseline: BASELINE,
        actor: "m",
        source: "manual",
      }),
    ).rejects.toThrow(/insert failed for iap-1.*pk dup/);
  });

  it("throws if the fingerprint stamp fails — a set with no baseline must not look saved", async () => {
    harness({ errorOn: { table: "iaps", op: "update", message: "nope" } });
    await expect(
      replaceCustomPrices({
        iapId: "iap-1",
        entries: [VNM],
        baseline: BASELINE,
        actor: "m",
        source: "manual",
      }),
    ).rejects.toThrow(/baseline stamp failed/);
  });
});

// ─── clearCustomPrices ───────────────────────────────────────────────────────

describe("clearCustomPrices", () => {
  it("captures the removed values in the audit row — the only recovery path", async () => {
    const { calls } = harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [{ territory_code: "VNM", currency_code: "VND", customer_price: 25000 }],
          error: null,
        },
        "iaps:single": {
          data: {
            custom_prices_baseline_tier_id: "TIER_10",
            custom_prices_baseline_pricing_source: "APP_TEMPLATE",
            custom_prices_baseline_base_territory: "USA",
          },
          error: null,
        },
      },
    });
    const removed = await clearCustomPrices({ iapId: "iap-1", actor: "m" });
    expect(removed).toBe(1);
    const row = auditRows(calls)[0];
    expect(row.action_type).toBe("CUSTOM_PRICES_CLEARED");
    expect(row.payload).toMatchObject({
      cleared_territory_count: 1,
      previous_baseline: BASELINE,
      territories: [VNM],
    });
  });

  it("reads the values BEFORE deleting them", async () => {
    const { calls } = harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [{ territory_code: "VNM", currency_code: "VND", customer_price: 25000 }],
          error: null,
        },
      },
    });
    await clearCustomPrices({ iapId: "iap-1", actor: "m" });
    const readIdx = calls.findIndex(
      (c) => c.table === "iap_custom_prices" && c.op === "select",
    );
    const delIdx = calls.findIndex(
      (c) => c.table === "iap_custom_prices" && c.op === "delete",
    );
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(readIdx);
  });

  it("nulls the fingerprint", async () => {
    const { calls } = harness();
    await clearCustomPrices({ iapId: "iap-1", actor: "m" });
    expect(
      calls.find((c) => c.table === "iaps" && c.op === "update")!.payload,
    ).toEqual({
      custom_prices_baseline_tier_id: null,
      custom_prices_baseline_pricing_source: null,
      custom_prices_baseline_base_territory: null,
    });
  });
});

// ─── restampCustomPriceBaseline ──────────────────────────────────────────────

describe("restampCustomPriceBaseline — 'Keep them (reviewed)'", () => {
  const NEXT: CustomPriceBaseline = {
    tier_id: "TIER_15",
    pricing_source: "APP_TEMPLATE",
    base_territory: "USA",
  };

  it("updates ONLY the fingerprint — no price row is touched", async () => {
    const { calls } = harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [{ territory_code: "VNM", currency_code: "VND", customer_price: 25000 }],
          error: null,
        },
      },
    });
    await restampCustomPriceBaseline({
      iapId: "iap-1",
      baseline: NEXT,
      actor: "m",
    });
    expect(
      calls.some(
        (c) =>
          c.table === "iap_custom_prices" &&
          (c.op === "insert" || c.op === "delete" || c.op === "update"),
      ),
    ).toBe(false);
    expect(
      calls.find((c) => c.table === "iaps" && c.op === "update")!.payload,
    ).toEqual({
      custom_prices_baseline_tier_id: "TIER_15",
      custom_prices_baseline_pricing_source: "APP_TEMPLATE",
      custom_prices_baseline_base_territory: "USA",
    });
  });

  it("audits old → new baseline and the kept count", async () => {
    const { calls } = harness({
      selectRows: {
        "iap_custom_prices:list": {
          data: [{ territory_code: "VNM", currency_code: "VND", customer_price: 25000 }],
          error: null,
        },
        "iaps:single": {
          data: {
            custom_prices_baseline_tier_id: "TIER_10",
            custom_prices_baseline_pricing_source: "APP_TEMPLATE",
            custom_prices_baseline_base_territory: "USA",
          },
          error: null,
        },
      },
    });
    await restampCustomPriceBaseline({ iapId: "iap-1", baseline: NEXT, actor: "m" });
    const row = auditRows(calls)[0];
    expect(row.action_type).toBe("CUSTOM_PRICES_REBASELINE");
    expect(row.payload).toMatchObject({
      old_baseline: BASELINE,
      new_baseline: NEXT,
      kept_territory_count: 1,
    });
  });
});

// ─── Audit-write failure is never fatal, but is always logged ────────────────

describe("audit writes: non-fatal, never silent", () => {
  it("a rejected audit insert does not fail the persistence op, and IS logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    harness({ errorOn: { table: "actions_log", op: "insert", message: "check violation" } });

    await expect(
      replaceCustomPrices({
        iapId: "iap-1",
        entries: [VNM],
        baseline: BASELINE,
        actor: "m",
        source: "manual",
      }),
    ).resolves.toEqual([VNM]);

    // The P2 bug was invisible precisely because nothing surfaced. A swallowed
    // constraint violation must always leave a console trace.
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[custom-prices] audit insert error"),
    );
    expect(spy.mock.calls[0][0]).toContain("check violation");
  });
});
