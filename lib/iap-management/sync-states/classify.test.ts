/**
 * Sync-states classifier — IAP.o.8b decision matrix.
 *
 * Pinned scenarios:
 *   - missing local row → INSERT (Manager MV30 Issue 2 fix; never-imported
 *     apps populate on first Refresh).
 *   - state match → UNCHANGED (synced_at touched only).
 *   - state mismatch → UPDATE_STATE.
 *   - mixed batch → counts add up across decisions.
 *   - empty Apple list → empty decisions, all counts zero.
 *   - INSERT payload mirrors Apple's productId / name / type / state.
 */

import { describe, it, expect } from "vitest";
import { classifySyncStates } from "./classify";
import type {
  InAppPurchase,
  InAppPurchaseType,
  InAppPurchaseState,
} from "@/types/iap-management/apple";

function fakeIap(
  id: string,
  productId: string,
  state: InAppPurchaseState,
  type: InAppPurchaseType = "CONSUMABLE",
): InAppPurchase {
  return {
    type: "inAppPurchases",
    id,
    attributes: {
      name: `name-${productId}`,
      productId,
      inAppPurchaseType: type,
      state,
    },
  };
}

describe("classifySyncStates", () => {
  it("classifies a missing local row as INSERT with full payload", () => {
    const apple = [fakeIap("apple-1", "com.x.gem", "READY_TO_SUBMIT")];
    const local = new Map<string, string>();

    const { decisions, counts } = classifySyncStates(apple, local);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "INSERT",
      apple_iap_id: "apple-1",
      state: "READY_TO_SUBMIT",
      insert_payload: {
        apple_iap_id: "apple-1",
        product_id: "com.x.gem",
        reference_name: "name-com.x.gem",
        type: "CONSUMABLE",
        state: "READY_TO_SUBMIT",
      },
    });
    expect(counts).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
  });

  it("classifies a state match as UNCHANGED (no insert payload)", () => {
    const apple = [fakeIap("apple-1", "com.x.gem", "READY_FOR_SALE")];
    const local = new Map([["apple-1", "READY_FOR_SALE"]]);

    const { decisions, counts } = classifySyncStates(apple, local);

    expect(decisions[0]).toEqual({
      kind: "UNCHANGED",
      apple_iap_id: "apple-1",
      state: "READY_FOR_SALE",
    });
    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("classifies a state mismatch as UPDATE_STATE with the fresh state", () => {
    const apple = [fakeIap("apple-1", "com.x.gem", "REJECTED")];
    const local = new Map([["apple-1", "WAITING_FOR_REVIEW"]]);

    const { decisions, counts } = classifySyncStates(apple, local);

    expect(decisions[0]).toEqual({
      kind: "UPDATE_STATE",
      apple_iap_id: "apple-1",
      state: "REJECTED",
    });
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
  });

  it("counts a mixed batch across all three decision kinds", () => {
    const apple = [
      fakeIap("apple-1", "com.x.a", "READY_FOR_SALE"), // unchanged
      fakeIap("apple-2", "com.x.b", "REJECTED"), // update
      fakeIap("apple-3", "com.x.c", "READY_TO_SUBMIT"), // insert
      fakeIap("apple-4", "com.x.d", "READY_FOR_SALE"), // unchanged
    ];
    const local = new Map([
      ["apple-1", "READY_FOR_SALE"],
      ["apple-2", "WAITING_FOR_REVIEW"],
      ["apple-4", "READY_FOR_SALE"],
    ]);

    const { counts } = classifySyncStates(apple, local);

    expect(counts).toEqual({ inserted: 1, updated: 1, unchanged: 2 });
  });

  it("returns empty decisions when Apple has no IAPs", () => {
    const { decisions, counts } = classifySyncStates([], new Map());
    expect(decisions).toEqual([]);
    expect(counts).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
  });

  it("propagates inAppPurchaseType into the INSERT payload (NRS coverage)", () => {
    const apple = [
      fakeIap(
        "apple-9",
        "com.x.month_sub",
        "READY_TO_SUBMIT",
        "NON_RENEWING_SUBSCRIPTION",
      ),
    ];
    const local = new Map<string, string>();

    const { decisions } = classifySyncStates(apple, local);

    expect(decisions[0].insert_payload?.type).toBe(
      "NON_RENEWING_SUBSCRIPTION",
    );
  });
});
