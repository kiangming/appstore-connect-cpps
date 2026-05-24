/**
 * Tests for Cycle 39 Phase 2 bulk-availability-fetch helper. Covers:
 *   • fan-out with bounded concurrency
 *   • per-IAP failure isolation (404/null/error all classified correctly)
 *   • classifyAvailability pure helper (drives both column + modal filter)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getAvailabilityForIap = vi.hoisted(() => vi.fn());
vi.mock("./availabilities", () => ({ getAvailabilityForIap }));

import {
  classifyAvailability,
  fetchAvailabilityStatesForIaps,
} from "./bulk-availability-fetch";

const creds = {
  id: "t",
  name: "T",
  keyId: "k",
  issuerId: "i",
  privateKey: "p",
} as never;

beforeEach(() => {
  getAvailabilityForIap.mockReset();
});

describe("classifyAvailability (pure)", () => {
  it("returns 'unknown' whenever the per-IAP fetch errored", () => {
    expect(classifyAvailability(null, true)).toBe("unknown");
    expect(
      classifyAvailability(
        { availableInNewTerritories: true, territoryCount: 175, territoryIds: [] },
        true,
      ),
    ).toBe("unknown");
  });

  it("returns 'removed' when Apple has no availability resource (null state)", () => {
    expect(classifyAvailability(null, false)).toBe("removed");
  });

  it("returns 'removed' when Apple returns availability with zero territories", () => {
    expect(
      classifyAvailability(
        { availableInNewTerritories: false, territoryCount: 0, territoryIds: [] },
        false,
      ),
    ).toBe("removed");
  });

  it("returns 'available' when at least one territory is on the availability resource", () => {
    expect(
      classifyAvailability(
        { availableInNewTerritories: true, territoryCount: 1, territoryIds: ["USA"] },
        false,
      ),
    ).toBe("available");
  });
});

describe("fetchAvailabilityStatesForIaps", () => {
  it("fans out across all input ids and returns a complete id→state Map", async () => {
    getAvailabilityForIap.mockImplementation(async (_creds, id: string) => ({
      availableInNewTerritories: true,
      territoryCount: 175,
      territoryIds: ["USA"],
      __id: id, // marker
    }));
    const out = await fetchAvailabilityStatesForIaps({
      creds,
      iapIds: ["iap-1", "iap-2", "iap-3"],
    });
    expect(out.states.size).toBe(3);
    expect(out.states.get("iap-1")?.territoryCount).toBe(175);
    expect(out.errors.size).toBe(0);
    expect(getAvailabilityForIap).toHaveBeenCalledTimes(3);
  });

  it("isolates per-IAP failures: caught error → null state + entry in errors Map", async () => {
    getAvailabilityForIap
      .mockResolvedValueOnce({
        availableInNewTerritories: true,
        territoryCount: 50,
        territoryIds: [],
      })
      .mockRejectedValueOnce(new Error("Apple 503"))
      .mockResolvedValueOnce(null);
    const out = await fetchAvailabilityStatesForIaps({
      creds,
      iapIds: ["ok-1", "boom", "removed-3"],
    });
    expect(out.states.get("ok-1")?.territoryCount).toBe(50);
    expect(out.states.get("boom")).toBeNull();
    expect(out.states.get("removed-3")).toBeNull();
    expect(out.errors.get("boom")).toBe("Apple 503");
    expect(out.errors.has("ok-1")).toBe(false);
    expect(out.errors.has("removed-3")).toBe(false);
  });

  it("respects the concurrency ceiling — no more than `concurrency` calls run in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    getAvailabilityForIap.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    await fetchAvailabilityStatesForIaps({
      creds,
      iapIds: Array.from({ length: 12 }, (_, i) => `iap-${i}`),
      concurrency: 3,
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("returns an empty Map without calling Apple when the input is empty", async () => {
    const out = await fetchAvailabilityStatesForIaps({ creds, iapIds: [] });
    expect(out.states.size).toBe(0);
    expect(out.errors.size).toBe(0);
    expect(getAvailabilityForIap).not.toHaveBeenCalled();
  });
});
