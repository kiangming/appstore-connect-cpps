import { describe, it, expect } from "vitest";
import {
  bucketSelection,
  terminalStateHint,
  type AppleStateRow,
  type LocalSelectionRow,
} from "./bucket";

function localRow(over: Partial<LocalSelectionRow> = {}): LocalSelectionRow {
  return {
    id: over.id ?? "uuid-1",
    apple_iap_id:
      "apple_iap_id" in over ? (over.apple_iap_id as string | null) : "apple-1",
    product_id: over.product_id ?? "com.vng.app.iap1",
    reference_name: over.reference_name ?? "IAP 1",
  };
}

function appleMap(rows: AppleStateRow[]): Map<string, AppleStateRow> {
  return new Map(rows.map((r) => [r.apple_iap_id, r]));
}

describe("bucketSelection — preflight categorization", () => {
  it("buckets a READY_TO_SUBMIT row into ready", () => {
    const sel = [localRow({ apple_iap_id: "apple-1" })];
    const apple = appleMap([{ apple_iap_id: "apple-1", state: "READY_TO_SUBMIT" }]);
    const out = bucketSelection(sel, apple);
    expect(out.ready).toHaveLength(1);
    expect(out.missing_metadata).toHaveLength(0);
    expect(out.other).toHaveLength(0);
    expect(out.not_on_apple).toHaveLength(0);
    expect(out.ready[0].state).toBe("READY_TO_SUBMIT");
    expect(out.ready[0].hint).toBeUndefined();
  });

  it("buckets MISSING_METADATA into missing_metadata with hint", () => {
    const sel = [localRow({ apple_iap_id: "apple-1" })];
    const apple = appleMap([{ apple_iap_id: "apple-1", state: "MISSING_METADATA" }]);
    const out = bucketSelection(sel, apple);
    expect(out.missing_metadata).toHaveLength(1);
    expect(out.missing_metadata[0].hint).toContain("MISSING_METADATA");
  });

  it("buckets a local draft (apple_iap_id null) into not_on_apple", () => {
    const sel = [
      localRow({ id: "draft-1", apple_iap_id: null, product_id: "com.x.draft" }),
    ];
    const out = bucketSelection(sel, new Map());
    expect(out.not_on_apple).toHaveLength(1);
    expect(out.not_on_apple[0].iap_id).toBe("draft-1");
    expect(out.ready).toHaveLength(0);
  });

  it("buckets WAITING_FOR_REVIEW into other with appropriate hint", () => {
    const sel = [localRow({ apple_iap_id: "apple-1" })];
    const apple = appleMap([
      { apple_iap_id: "apple-1", state: "WAITING_FOR_REVIEW" },
    ]);
    const out = bucketSelection(sel, apple);
    expect(out.other).toHaveLength(1);
    expect(out.other[0].hint).toContain("Already submitted");
  });

  it("buckets APPROVED + REJECTED + REMOVED into other with distinct hints", () => {
    const sel = [
      localRow({ id: "u1", apple_iap_id: "a1" }),
      localRow({ id: "u2", apple_iap_id: "a2" }),
      localRow({ id: "u3", apple_iap_id: "a3" }),
    ];
    const apple = appleMap([
      { apple_iap_id: "a1", state: "APPROVED" },
      { apple_iap_id: "a2", state: "REJECTED" },
      { apple_iap_id: "a3", state: "REMOVED_FROM_SALE" },
    ]);
    const out = bucketSelection(sel, apple);
    expect(out.other).toHaveLength(3);
    const byId = new Map(out.other.map((o) => [o.iap_id, o]));
    expect(byId.get("u1")!.hint).toContain("approved");
    expect(byId.get("u2")!.hint).toContain("rejected");
    expect(byId.get("u3")!.hint).toContain("Removed");
  });

  it("buckets an apple_iap_id missing from Apple's response into other with NOT_FOUND state", () => {
    const sel = [localRow({ apple_iap_id: "apple-vanished" })];
    const out = bucketSelection(sel, new Map());
    expect(out.other).toHaveLength(1);
    expect(out.other[0].state).toBe("NOT_FOUND");
    expect(out.other[0].hint).toContain("no longer returns");
  });

  it("mixed selection: separates ready / missing / other / not_on_apple correctly", () => {
    const sel = [
      localRow({ id: "u1", apple_iap_id: "a1", product_id: "p1" }),
      localRow({ id: "u2", apple_iap_id: "a2", product_id: "p2" }),
      localRow({ id: "u3", apple_iap_id: "a3", product_id: "p3" }),
      localRow({ id: "u4", apple_iap_id: null, product_id: "draft" }),
    ];
    const apple = appleMap([
      { apple_iap_id: "a1", state: "READY_TO_SUBMIT" },
      { apple_iap_id: "a2", state: "MISSING_METADATA" },
      { apple_iap_id: "a3", state: "IN_REVIEW" },
    ]);
    const out = bucketSelection(sel, apple);
    expect(out.ready.map((r) => r.iap_id)).toEqual(["u1"]);
    expect(out.missing_metadata.map((r) => r.iap_id)).toEqual(["u2"]);
    expect(out.other.map((r) => r.iap_id)).toEqual(["u3"]);
    expect(out.not_on_apple.map((r) => r.iap_id)).toEqual(["u4"]);
  });

  it("empty selection returns empty buckets", () => {
    const out = bucketSelection([], new Map());
    expect(out.ready).toEqual([]);
    expect(out.missing_metadata).toEqual([]);
    expect(out.other).toEqual([]);
    expect(out.not_on_apple).toEqual([]);
  });
});

describe("terminalStateHint — state coverage", () => {
  it("maps every known InAppPurchaseState to a non-empty hint", () => {
    const states = [
      "WAITING_FOR_REVIEW",
      "IN_REVIEW",
      "APPROVED",
      "READY_FOR_SALE",
      "REJECTED",
      "DEVELOPER_ACTION_NEEDED",
      "PENDING_APPLE_RELEASE",
      "PENDING_DEVELOPER_RELEASE",
      "REMOVED_FROM_SALE",
      "DEVELOPER_REMOVED_FROM_SALE",
    ];
    for (const s of states) {
      expect(terminalStateHint(s).length).toBeGreaterThan(0);
    }
  });

  it("falls back with the unrecognized state name embedded", () => {
    expect(terminalStateHint("WEIRD_STATE")).toContain("WEIRD_STATE");
  });
});
