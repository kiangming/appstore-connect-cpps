/**
 * The item-list model — every exclusion carries its own TRUE reason.
 *
 * ⚠ MUTATION TARGETS in this file:
 *   (a) drop an excluded row instead of returning it  → "shows, never hides"
 *   (b) reorder the reason guards                      → "reason is operative"
 *   (c) collapse emptyCause's two branches             → "unreadable ≠ clean"
 */
import { describe, it, expect } from "vitest";
import {
  buildBulkItemRows,
  partitionRows,
  emptyCause,
  type BulkItemRow,
} from "./bulk-item-rows";
import type { InAppPurchase } from "@/types/iap-management/apple";
import type { AvailabilityForIap } from "./availabilities";

const iap = (id: string): InAppPurchase =>
  ({
    id,
    type: "inAppPurchases",
    attributes: {
      id,
      productId: `com.x.${id}`,
      name: `Item ${id}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_TO_SUBMIT",
    },
  }) as unknown as InAppPurchase;

const AVAILABLE: AvailabilityForIap = {
  availableInNewTerritories: false,
  territoryCount: 3,
  territoryIds: ["USA", "VNM", "BRA"],
};

const byKey = (rows: BulkItemRow[], k: string) => rows.find((r) => r.key === k)!;

describe("buildBulkItemRows — A′ (set-territories, no pre-read)", () => {
  it("⚠ eligibleAppleIds=null ⇒ every linked item is SELECTABLE, no state consulted", () => {
    const rows = buildBulkItemRows({
      iaps: [iap("a"), iap("b"), iap("c")],
      appleToInternal: { a: "u-a", b: "u-b", c: "u-c" },
      states: new Map(),
      errors: new Map(),
      mode: "set-territories",
      eligibleAppleIds: null,
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.exclusion === null)).toBe(true);
  });

  it("null is 'never asked', NOT 'nothing eligible' — an empty Set hides everything instead", () => {
    const common = {
      iaps: [iap("a")],
      appleToInternal: { a: "u-a" },
      states: new Map<string, AvailabilityForIap | null>(),
      errors: new Map<string, string>(),
      mode: "set-territories" as const,
    };
    expect(
      buildBulkItemRows({ ...common, eligibleAppleIds: null })[0].exclusion,
    ).toBeNull();
    expect(
      buildBulkItemRows({ ...common, eligibleAppleIds: new Set() })[0]
        .exclusion,
    ).not.toBeNull();
  });

  it("an unlinked row is still excluded under A′ — there is nothing to write to", () => {
    const rows = buildBulkItemRows({
      iaps: [iap("a")],
      appleToInternal: {},
      states: new Map(),
      errors: new Map(),
      mode: "set-territories",
      eligibleAppleIds: null,
    });
    expect(rows[0].exclusion?.kind).toBe("not_linked");
  });
});

describe("buildBulkItemRows — the silent drop, now visible", () => {
  const iaps = [iap("keep"), iap("rl"), iap("fail"), iap("unread"), iap("bucket"), iap("nolink")];
  const appleToInternal = {
    keep: "u1", rl: "u2", fail: "u3", unread: "u4", bucket: "u5",
  };
  const states = new Map<string, AvailabilityForIap | null>([
    ["keep", null],
    ["bucket", AVAILABLE],
  ]);
  const errors = new Map<string, string>([
    ["rl", "rate_limited"],
    ["fail", "fetch_failed"],
  ]);

  const rows = buildBulkItemRows({
    iaps,
    appleToInternal,
    states,
    errors,
    mode: "set-all",
    eligibleAppleIds: new Set(["keep"]),
  });

  it("⚠ EVERY dropped row is still RETURNED — nothing vanishes", () => {
    expect(rows).toHaveLength(iaps.length);
    expect(rows.map((r) => r.key).sort()).toEqual(
      ["bucket", "fail", "keep", "nolink", "rl", "unread"],
    );
  });

  it("names the operative cause per row, not a generic one", () => {
    expect(byKey(rows, "keep").exclusion).toBeNull();
    expect(byKey(rows, "rl").exclusion?.kind).toBe("read_rate_limited");
    expect(byKey(rows, "fail").exclusion?.kind).toBe("read_failed");
    expect(byKey(rows, "unread").exclusion?.kind).toBe("read_failed");
    expect(byKey(rows, "bucket").exclusion?.kind).toBe("not_in_bucket");
    expect(byKey(rows, "nolink").exclusion?.kind).toBe("not_linked");
  });

  it("⚠ a rate-limited row must NOT be described as an availability decision", () => {
    const r = byKey(rows, "rl").exclusion!;
    expect(r.reason).toMatch(/rate-limited/i);
    expect(r.reason).not.toMatch(/already available|already removed/i);
  });

  it("bucket wording follows the mode, not a sibling's", () => {
    const removeRows = buildBulkItemRows({
      iaps: [iap("bucket")],
      appleToInternal: { bucket: "u5" },
      states: new Map([["bucket", null]]),
      errors: new Map(),
      mode: "remove",
      eligibleAppleIds: new Set(),
    });
    expect(removeRows[0].exclusion?.reason).toMatch(/already removed/i);
    expect(byKey(rows, "bucket").exclusion?.reason).toMatch(/already available/i);
  });
});

describe("⚠ reason ORDER mirrors filterEligible's guard order", () => {
  // A row that is simultaneously unlinked, errored and out-of-bucket must
  // report the guard that ACTUALLY dropped it — the first one.
  it("unlinked beats a read error", () => {
    const rows = buildBulkItemRows({
      iaps: [iap("x")],
      appleToInternal: {},
      states: new Map(),
      errors: new Map([["x", "rate_limited"]]),
      mode: "set-all",
      eligibleAppleIds: new Set(),
    });
    expect(rows[0].exclusion?.kind).toBe("not_linked");
  });

  it("a read error beats an out-of-bucket verdict", () => {
    const rows = buildBulkItemRows({
      iaps: [iap("x")],
      appleToInternal: { x: "u" },
      states: new Map([["x", AVAILABLE]]),
      errors: new Map([["x", "rate_limited"]]),
      mode: "set-all",
      eligibleAppleIds: new Set(),
    });
    expect(rows[0].exclusion?.kind).toBe("read_rate_limited");
  });
});

describe("local drafts — shown, disabled, reasoned (Manager lock)", () => {
  const drafts = [{ id: "d1", product_id: "com.x.draft", reference_name: "Draft One" }];

  it.each(["set-all", "remove", "set-territories"] as const)(
    "%s: the draft is PRESENT and disabled — never hidden",
    (mode) => {
      const rows = buildBulkItemRows({
        iaps: [],
        drafts,
        appleToInternal: {},
        states: new Map(),
        errors: new Map(),
        mode,
        eligibleAppleIds: mode === "set-territories" ? null : new Set(),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].exclusion?.kind).toBe("local_draft");
      expect(rows[0].exclusion?.reason).toMatch(/not on Apple yet/i);
      expect(rows[0].appleIapId).toBeNull();
      expect(rows[0].internalId).toBe("d1");
    },
  );

  it("draft keys cannot collide with Apple ids", () => {
    const rows = buildBulkItemRows({
      iaps: [iap("d1")],
      drafts,
      appleToInternal: { d1: "u" },
      states: new Map(),
      errors: new Map(),
      mode: "set-territories",
      eligibleAppleIds: null,
    });
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe("partitionRows / emptyCause", () => {
  it("partitions without losing a row", () => {
    const rows = buildBulkItemRows({
      iaps: [iap("a"), iap("b")],
      appleToInternal: { a: "u" },
      states: new Map([["a", null]]),
      errors: new Map(),
      mode: "set-all",
      eligibleAppleIds: new Set(["a"]),
    });
    const { selectable, excluded } = partitionRows(rows);
    expect(selectable).toHaveLength(1);
    expect(excluded).toHaveLength(1);
    expect(selectable.length + excluded.length).toBe(rows.length);
  });

  it("⚠ 'nothing matched' and 'nothing could be read' are DIFFERENT causes", () => {
    expect(emptyCause([])).toBe("no_items");

    const unreadable = buildBulkItemRows({
      iaps: [iap("a")],
      appleToInternal: { a: "u" },
      states: new Map(),
      errors: new Map([["a", "rate_limited"]]),
      mode: "set-all",
      eligibleAppleIds: new Set(),
    });
    expect(emptyCause(unreadable)).toBe("all_excluded_unreadable");

    const clean = buildBulkItemRows({
      iaps: [iap("a")],
      appleToInternal: { a: "u" },
      states: new Map([["a", AVAILABLE]]),
      errors: new Map(),
      mode: "set-all",
      eligibleAppleIds: new Set(),
    });
    expect(emptyCause(clean)).toBe("all_excluded_other");
  });

  it("ONE unreadable row is enough to disqualify the clean claim", () => {
    const mixed = buildBulkItemRows({
      iaps: [iap("a"), iap("b")],
      appleToInternal: { a: "u", b: "v" },
      states: new Map([["a", AVAILABLE]]),
      errors: new Map([["b", "rate_limited"]]),
      mode: "set-all",
      eligibleAppleIds: new Set(),
    });
    expect(emptyCause(mixed)).toBe("all_excluded_unreadable");
  });
});
