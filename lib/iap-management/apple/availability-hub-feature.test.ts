/**
 * The hub feature tag is ONE map, and every mode has a distinct one.
 *
 * ⚠ MUTATION TARGET. The bug this closes was a client-side binary ternary
 * (`mode === "set-all" ? … : "iap-remove-from-sales"`) that tagged
 * `set-territories` runs as Remove-from-Sales at /start and /cancel, while the
 * write route finalized the same run as `iap-set-territories`. Collapse any two
 * entries below and the distinctness test goes red.
 */
import { describe, it, expect } from "vitest";
import {
  AVAILABILITY_HUB_FEATURE,
  type AvailabilityHubMode,
} from "./availability-hub-feature";

const MODES: AvailabilityHubMode[] = ["set-all", "remove", "set-territories"];

describe("AVAILABILITY_HUB_FEATURE", () => {
  it("covers every mode — no mode falls through to another's tag", () => {
    for (const m of MODES) {
      expect(AVAILABILITY_HUB_FEATURE[m]).toBeTruthy();
    }
    expect(Object.keys(AVAILABILITY_HUB_FEATURE).sort()).toEqual(
      [...MODES].sort(),
    );
  });

  it("⚠ all three tags are DISTINCT — set-territories is not remove-from-sales", () => {
    const tags = MODES.map((m) => AVAILABILITY_HUB_FEATURE[m]);
    expect(new Set(tags).size).toBe(MODES.length);
    expect(AVAILABILITY_HUB_FEATURE["set-territories"]).toBe(
      "iap-set-territories",
    );
    expect(AVAILABILITY_HUB_FEATURE["set-territories"]).not.toBe(
      AVAILABILITY_HUB_FEATURE.remove,
    );
    expect(AVAILABILITY_HUB_FEATURE["set-territories"]).not.toBe(
      AVAILABILITY_HUB_FEATURE["set-all"],
    );
  });

  it("pins the exact wire values both ends stamp", () => {
    expect(AVAILABILITY_HUB_FEATURE).toEqual({
      "set-all": "iap-set-availabilities",
      remove: "iap-remove-from-sales",
      "set-territories": "iap-set-territories",
    });
  });
});
