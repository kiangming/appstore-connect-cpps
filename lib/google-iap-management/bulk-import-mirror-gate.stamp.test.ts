/**
 * C2.1a — decideMirrorStamp: the ONE rule for whether an IAP Refresh may stamp
 * apps.iaps_last_synced_at.
 */
import { describe, it, expect } from "vitest";

import { decideMirrorStamp } from "./bulk-import-mirror-gate";

describe("decideMirrorStamp", () => {
  it("products fetched, none failed ⇒ stamp (the mirror is not consulted)", () => {
    expect(decideMirrorStamp({ fetched: 28, failed: 0, liveMirrorItems: null })).toEqual({ stamp: true });
  });

  it("any failed row ⇒ no stamp, FAILED_ROWS", () => {
    const d = decideMirrorStamp({ fetched: 28, failed: 2, liveMirrorItems: null });
    expect(d).toMatchObject({ stamp: false, reason: "FAILED_ROWS" });
  });

  it("EMPTY list + mirror holds items ⇒ no stamp, EMPTY_LIST_WITH_MIRROR_ITEMS, message names the count", () => {
    const d = decideMirrorStamp({ fetched: 0, failed: 0, liveMirrorItems: 16 });
    expect(d).toMatchObject({ stamp: false, reason: "EMPTY_LIST_WITH_MIRROR_ITEMS" });
    if (!d.stamp) expect(d.message).toMatch(/EMPTY IAP list while the tool holds 16 item\(s\)/);
  });

  it("boundary: EMPTY list + exactly ONE live mirror item ⇒ no stamp", () => {
    expect(decideMirrorStamp({ fetched: 0, failed: 0, liveMirrorItems: 1 })).toMatchObject({
      stamp: false,
      reason: "EMPTY_LIST_WITH_MIRROR_ITEMS",
    });
  });

  it("EMPTY list + EMPTY mirror ⇒ stamp (the app genuinely has no items)", () => {
    expect(decideMirrorStamp({ fetched: 0, failed: 0, liveMirrorItems: 0 })).toEqual({ stamp: true });
  });

  it("EMPTY list but the mirror was NOT measured ⇒ throws (never stamp by default)", () => {
    expect(() => decideMirrorStamp({ fetched: 0, failed: 0, liveMirrorItems: null })).toThrow(/must be measured/);
  });
});
