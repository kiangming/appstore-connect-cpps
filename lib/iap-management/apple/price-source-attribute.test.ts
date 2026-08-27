/**
 * E1 / F1 — WHO SET THIS PRICE is read from Apple's `manual` attribute, never
 * inferred from which sub-resource the row arrived on.
 *
 * MUTATION (i): deriving the flag from the endpoint instead of the attribute
 * must FAIL. The two are separately observable — `/manualPrices` and
 * `/automaticPrices` both return `inAppPurchasePrices` resources, each
 * carrying its own `manual` boolean — so they CAN disagree, and if they ever
 * do, the endpoint is our inference while the attribute is Apple's statement.
 *
 * Measured live 2026-08-27 (com.vnggames.aoiaf.0.99): manualPrices = 10,
 * automaticPrices = 165, and an automaticPrices entry carries `manual: false`.
 */
import { describe, it, expect } from "vitest";
import { unpackPriceSchedule } from "@/lib/iap-management/queries/iap-detail";
import type {
  AscApiResponse,
  InAppPurchasePriceSchedule,
} from "@/types/iap-management/apple";

/** One merged schedule response, shaped like the real Stage 1 + Stage 2 + 2b
 *  merge: prices, their price points and their territories all in `included`. */
function schedule(
  prices: Array<{ id: string; territory: string; price: string; manual?: boolean }>,
): AscApiResponse<InAppPurchasePriceSchedule> {
  const included: unknown[] = [];
  for (const p of prices) {
    included.push({
      type: "inAppPurchasePrices",
      id: p.id,
      attributes: {
        startDate: null,
        ...(p.manual === undefined ? {} : { manual: p.manual }),
      },
      relationships: {
        inAppPurchasePricePoint: { data: { id: `pp-${p.id}` } },
        territory: { data: { id: p.territory } },
      },
    });
    included.push({
      type: "inAppPurchasePricePoints",
      id: `pp-${p.id}`,
      attributes: { customerPrice: p.price, proceeds: p.price },
    });
    included.push({
      type: "territories",
      id: p.territory,
      attributes: { currency: "USD" },
    });
  }
  return {
    data: {
      type: "inAppPurchasePriceSchedules",
      id: "sched-1",
      attributes: {},
      relationships: { baseTerritory: { data: { id: "USA" } } },
    },
    included,
  } as unknown as AscApiResponse<InAppPurchasePriceSchedule>;
}

const byTerritory = (view: ReturnType<typeof unpackPriceSchedule>) =>
  Object.fromEntries(view.entries.map((e) => [e.territory, e.manual]));

describe("⚠ MUTATION (i) — the source comes from the ATTRIBUTE", () => {
  it("manual: true → true, manual: false → false", () => {
    const view = unpackPriceSchedule(
      schedule([
        { id: "1", territory: "USA", price: "0.99", manual: true },
        { id: "2", territory: "THA", price: "0.99", manual: false },
      ]),
    );
    expect(byTerritory(view)).toEqual({ USA: true, THA: false });
  });

  it("⚠ an AUTO entry is false even though it sits in the same merged bucket", () => {
    // THE MUTATION. After the merge there is no endpoint left to consult —
    // manual and automatic rows are indistinguishable except by this
    // attribute. Anything that reconstructs the source from position, order
    // or bucket membership is guessing.
    const view = unpackPriceSchedule(
      schedule([
        { id: "1", territory: "USA", price: "0.99", manual: true },
        { id: "2", territory: "VNM", price: "0.99", manual: false },
        { id: "3", territory: "SGP", price: "0.99", manual: false },
      ]),
    );
    expect(byTerritory(view)).toEqual({ USA: true, VNM: false, SGP: false });
  });

  it("⚠ ABSENT is null — NOT false", () => {
    // `?? false` would make every pre-existing cached response claim "Apple
    // auto-set this", and the export shades auto cells. An unknown must
    // claim less than a known, not more.
    const view = unpackPriceSchedule(
      schedule([{ id: "1", territory: "USA", price: "0.99" }]),
    );
    expect(byTerritory(view)).toEqual({ USA: null });
  });

  it("⚠ null and false stay distinguishable in one response", () => {
    // The three-value distinction has to survive together, not just alone:
    // a single `??` in the wrong place collapses them and nothing else fails.
    const view = unpackPriceSchedule(
      schedule([
        { id: "1", territory: "USA", price: "0.99", manual: true },
        { id: "2", territory: "THA", price: "0.99", manual: false },
        { id: "3", territory: "VNM", price: "0.99" },
      ]),
    );
    expect(byTerritory(view)).toEqual({ USA: true, THA: false, VNM: null });
  });

  it("the rest of the entry is unchanged by the new field", () => {
    // Parity guard: E1 adds a field, it does not alter what was already read.
    const view = unpackPriceSchedule(
      schedule([{ id: "1", territory: "USA", price: "4.99", manual: true }]),
    );
    expect(view.entries[0]).toMatchObject({
      priceId: "1",
      territory: "USA",
      customerPrice: "4.99",
      currency: "USD",
      startDate: null,
    });
    expect(view.baseTerritory).toBe("USA");
  });
});
