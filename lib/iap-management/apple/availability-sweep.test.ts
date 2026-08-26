/**
 * [EXPORT-availability-filter] C4 — the sweep behind Refresh from Apple.
 *
 * MUTATION (g): a sweep that stops on Apple's rate limit must NOT stamp a new
 * timestamp on the items it never reached. That is the one failure that turns
 * the whole feature into a liar — an "as of 2 minutes ago" label over data
 * Apple was never asked about — and it is invisible in the UI, because a
 * stamped-but-unread item looks exactly like a read one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  buildSweepTargets,
  runAvailabilitySweep,
  type SweepTarget,
} from "./availability-sweep";
import { AppleRateLimitError } from "./fetch";
import type { InAppPurchase } from "@/types/iap-management/apple";

const target = (n: number, availabilityId: string | null = `av-${n}`): SweepTarget => ({
  iapId: `uuid-${n}`,
  appleIapId: `apple-${n}`,
  availabilityId,
  availableInNewTerritories: false,
});

const FULL = { availableInNewTerritories: false, territoryCount: 175, territoryIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ─── MUTATION (g) — stop and preserve ───────────────────────────────────────

describe("⚠ MUTATION (g) — a stopped sweep leaves untouched items untouched", () => {
  it("items after the stop are NOT_ATTEMPTED and are absent from `read`", async () => {
    const targets = [target(1), target(2), target(3), target(4), target(5)];
    const readOne = vi.fn(async (t: SweepTarget) => {
      if (t.iapId === "uuid-1") return FULL;
      throw new AppleRateLimitError("POST", "/v1/x", "429 Too Many Requests", 0);
    });

    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets,
      concurrency: 1,
      readOne,
    });

    expect(result.stoppedByRateLimit).toBe(true);
    // ⚠ THE ASSERTION THE MUTATION BREAKS. `read` is what the caller hands to
    //   the mirror; anything in it gets a fresh timestamp. Only genuinely-read
    //   items may appear.
    expect(result.read.map((r) => r.iapId)).toEqual(["uuid-1"]);
    expect(result.notAttemptedCount).toBeGreaterThan(0);
  });

  it("⚠ a RATE-LIMITED item is FAILED, not NOT_ATTEMPTED — it WAS asked", async () => {
    // The distinction A′ established and SC3 forbade collapsing: a refused
    // request must not be folded into the blindly-retryable remainder.
    const readOne = vi.fn(async () => {
      throw new AppleRateLimitError("POST", "/v1/x", "429 Too Many Requests", 0);
    });
    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets: [target(1), target(2)],
      concurrency: 1,
      readOne,
    });
    const first = result.outcomes.find((o) => o.iapId === "uuid-1");
    expect(first?.status).toBe("FAILED");
    expect(result.read).toHaveLength(0);
  });

  it("every input item gets exactly one outcome — nothing is dropped from the report", async () => {
    const readOne = vi.fn(async (t: SweepTarget) => {
      if (t.iapId === "uuid-2") throw new AppleRateLimitError("POST", "/v1/x", "429 Too Many Requests", 0);
      return FULL;
    });
    const targets = [target(1), target(2), target(3), target(4)];
    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets,
      concurrency: 1,
      readOne,
    });
    expect(result.outcomes).toHaveLength(4);
    expect(
      result.readCount + result.failedCount + result.notAttemptedCount,
    ).toBe(4);
  });
});

describe("an ordinary failure is fail-soft — one bad item does not end the sweep", () => {
  it("keeps going after a non-rate-limit error, and excludes only that item", async () => {
    // Q-K: a 404 on row 2 says nothing about row 3. Only an exhausted budget
    // predicts the next call fails too.
    const readOne = vi.fn(async (t: SweepTarget) => {
      if (t.iapId === "uuid-2") throw new Error("404 not found");
      return FULL;
    });
    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets: [target(1), target(2), target(3)],
      concurrency: 1,
      readOne,
    });
    expect(result.stoppedByRateLimit).toBe(false);
    expect(result.notAttemptedCount).toBe(0);
    expect(result.readCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.read.map((r) => r.iapId)).toEqual(["uuid-1", "uuid-3"]);
  });

  it("⚠ a FAILED item is excluded from `read` — an error is not a verdict", async () => {
    const readOne = vi.fn(async () => {
      throw new Error("500 from Apple");
    });
    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets: [target(1)],
      concurrency: 1,
      readOne,
    });
    expect(result.read).toHaveLength(0);
  });
});

describe("`null` from Apple is a real answer and IS written", () => {
  it("carries through as an observed value, not as a failure", async () => {
    // Apple having no availability resource is the Removed-from-Sale surface.
    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets: [target(1)],
      concurrency: 1,
      readOne: async () => null,
    });
    expect(result.readCount).toBe(1);
    expect(result.read[0]).toEqual({ iapId: "uuid-1", observed: null });
  });
});

describe("an empty sweep is a no-op, not an error", () => {
  it("returns zeros without calling anything", async () => {
    const readOne = vi.fn();
    const result = await runAvailabilitySweep({
      creds: {} as never,
      targets: [],
      readOne,
    });
    expect(readOne).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      readCount: 0,
      failedCount: 0,
      notAttemptedCount: 0,
      stoppedByRateLimit: false,
    });
  });
});

// ─── buildSweepTargets — the halving, and the trap it must not fall into ────

const listed = (id: string, availabilityId?: string): InAppPurchase =>
  ({
    type: "inAppPurchases",
    id,
    attributes: {
      name: id,
      productId: id,
      inAppPurchaseType: "CONSUMABLE",
      state: "APPROVED",
    },
    ...(availabilityId
      ? {
          relationships: {
            inAppPurchaseAvailability: {
              data: { type: "inAppPurchaseAvailabilities", id: availabilityId },
            },
          },
        }
      : {}),
  }) as InAppPurchase;

describe("buildSweepTargets — [EXPORT-avail-read-halving]", () => {
  const internalByAppleId = new Map([
    ["6001", "uuid-1"],
    ["6002", "uuid-2"],
  ]);

  it("takes the availability id off the list so the read costs 1 request, not 2", () => {
    const targets = buildSweepTargets({
      listed: [listed("6001", "av-1")],
      included: undefined,
      internalByAppleId,
    });
    expect(targets[0].availabilityId).toBe("av-1");
  });

  it("carries availableInNewTerritories from `included[]` — it is NOT derivable from the list", () => {
    // KB §4.13: ticking all territories by hand and choosing "All countries or
    // regions" send the same ids with a different flag.
    const targets = buildSweepTargets({
      listed: [listed("6001", "av-1")],
      included: [
        {
          type: "inAppPurchaseAvailabilities",
          id: "av-1",
          attributes: { availableInNewTerritories: true },
        },
      ],
      internalByAppleId,
    });
    expect(targets[0].availableInNewTerritories).toBe(true);
  });

  it("⚠ A MISSING RELATIONSHIP IS NOT A VERDICT — it produces a target with a null id", () => {
    // THE U3 TRAP. Reading "no availability relationship" as "removed" (or its
    // presence as "available") is exactly the defect this arc was censused
    // over. The only correct response is to pay for the full 2-request read.
    const targets = buildSweepTargets({
      listed: [listed("6001")],
      included: undefined,
      internalByAppleId,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].availabilityId).toBeNull();
  });

  it("⚠ a present relationship yields an id and NOTHING ELSE — no verdict rides along", () => {
    const targets = buildSweepTargets({
      listed: [listed("6001", "av-1")],
      included: undefined,
      internalByAppleId,
    });
    // No `state`, no `bucket`, no availability field of any kind on the target.
    expect(Object.keys(targets[0]).sort()).toEqual(
      ["appleIapId", "availabilityId", "availableInNewTerritories", "iapId"].sort(),
    );
  });

  it("an unknown flag defaults to false rather than true — the safer of two unknowns", () => {
    const targets = buildSweepTargets({
      listed: [listed("6001", "av-1")],
      included: [],
      internalByAppleId,
    });
    expect(targets[0].availableInNewTerritories).toBe(false);
  });

  it("items with no local row are skipped — the mirror has nowhere to put them", () => {
    const targets = buildSweepTargets({
      listed: [listed("6001", "av-1"), listed("9999", "av-9")],
      included: undefined,
      internalByAppleId,
    });
    expect(targets.map((t) => t.appleIapId)).toEqual(["6001"]);
  });

  it("ignores included resources of other types", () => {
    const targets = buildSweepTargets({
      listed: [listed("6001", "av-1")],
      included: [
        { type: "territories", id: "av-1", attributes: { availableInNewTerritories: true } },
      ],
      internalByAppleId,
    });
    expect(targets[0].availableInNewTerritories).toBe(false);
  });
});
