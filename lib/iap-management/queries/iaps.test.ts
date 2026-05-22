import { describe, it, expect } from "vitest";

import { partitionMissingAppleIaps } from "./iaps";

/**
 * Hotfix 13: the partition step that decides which Apple IAPs need a
 * local stub seeded. Pure logic — covers the filter semantics so the
 * DB-integrated `seedMissingIapStubs` only has to worry about I/O.
 */
describe("partitionMissingAppleIaps", () => {
  it("returns only Apple IAPs not present in the existing set", () => {
    const apple = [
      { id: "iap_a", attributes: {} },
      { id: "iap_b", attributes: {} },
      { id: "iap_c", attributes: {} },
    ];
    const existing = new Set(["iap_b"]);
    expect(partitionMissingAppleIaps(apple, existing)).toEqual([
      { id: "iap_a", attributes: {} },
      { id: "iap_c", attributes: {} },
    ]);
  });

  it("returns the full list when nothing is cached locally (cold-start CookieRun case)", () => {
    const apple = [
      { id: "iap_1", attributes: {} },
      { id: "iap_2", attributes: {} },
    ];
    expect(partitionMissingAppleIaps(apple, new Set())).toEqual(apple);
  });

  it("returns an empty list when every Apple IAP already has a stub (PASS SDK TEST case)", () => {
    const apple = [{ id: "iap_x" }, { id: "iap_y" }];
    const existing = new Set(["iap_x", "iap_y"]);
    expect(partitionMissingAppleIaps(apple, existing)).toEqual([]);
  });

  it("ignores existing-set entries that aren't in the Apple list (Apple-side delete)", () => {
    // Manager deleted an IAP on App Store Connect; our local row still
    // has it. The partition shouldn't try to "re-add" it from Apple's
    // side because Apple no longer returns it.
    const apple = [{ id: "still_there" }];
    const existing = new Set(["still_there", "deleted_apple_side"]);
    expect(partitionMissingAppleIaps(apple, existing)).toEqual([]);
  });

  it("preserves the Apple list order (so batch INSERT ordering is predictable)", () => {
    const apple = [
      { id: "c" },
      { id: "a" },
      { id: "b" },
    ];
    expect(partitionMissingAppleIaps(apple, new Set()).map((i) => i.id)).toEqual(
      ["c", "a", "b"],
    );
  });

  it("handles empty Apple list (refreshed-after-delete-everything case)", () => {
    expect(partitionMissingAppleIaps([], new Set(["a", "b"]))).toEqual([]);
  });
});
