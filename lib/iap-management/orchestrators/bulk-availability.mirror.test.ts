/**
 * [EXPORT-availability-filter] C3 — MUTATION (e).
 *
 * Census M3, in one sentence: this orchestrator POSTed to Apple, wrote one
 * `actions_log` row, and told the local DB nothing. So a Manager who clicked
 * Remove from Sales watched the Availabilities column keep saying "Available",
 * concluded the tool had failed, and had no way to tell otherwise short of a
 * hard reload.
 *
 * These tests say: an ACCEPTED Apple write lands in the mirror, and an
 * attempted-but-not-accepted one does not. Deleting the mirror call reproduces
 * the M3 bug exactly, and this file is what stops that being silent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleRateLimitError } from "@/lib/iap-management/apple/fetch";

const setAvailabilityTerritories = vi.hoisted(() => vi.fn());
const getAllTerritoryIds = vi.hoisted(() => vi.fn());
const auditInsert = vi.hoisted(() => vi.fn());
const iapsUpdate = vi.hoisted(() => vi.fn());
const iapsUpdateEq = vi.hoisted(() => vi.fn());

vi.mock("@/lib/iap-management/apple/availabilities", () => ({
  setAvailabilityTerritories,
  getAllTerritoryIds,
}));

const CATALOGUE = ["USA", "VNM", "JPN"];

vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({
    from: (table: string) => {
      if (table === "iaps") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: ids.map((id) => ({
                  id,
                  apple_iap_id: id.startsWith("draft-") ? null : `APL_${id}`,
                })),
                error: null,
              }),
          }),
          // The mirror write: `.update(columns).eq("id", iapId)`.
          update: (columns: Record<string, unknown>) => {
            iapsUpdate(columns);
            return {
              eq: (col: string, value: string) => {
                iapsUpdateEq(col, value);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === "actions_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            auditInsert(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return { select: () => ({}) };
    },
  }),
}));

import { executeBulkAvailability } from "./bulk-availability";

const creds = {
  id: "t",
  name: "T",
  keyId: "k",
  issuerId: "i",
  privateKey: "p",
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  getAllTerritoryIds.mockResolvedValue(CATALOGUE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── MUTATION (e) — an accepted write reaches the mirror ────────────────────

describe("⚠ MUTATION (e) — Remove from Sales is recorded locally, not only on Apple", () => {
  it("writes REMOVED with a zero territory count after Apple accepts", async () => {
    setAvailabilityTerritories.mockResolvedValue({
      data: { id: "av-1", type: "inAppPurchaseAvailabilities" },
    });

    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "remove",
      actor: "tester",
    });

    expect(out.overall).toBe("SUCCESS");
    // ⚠ THE ASSERTION THAT REPRODUCES M3 WHEN DELETED. Without this write the
    //   list column keeps rendering the pre-removal verdict until a reload.
    expect(iapsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        availability_state: "REMOVED",
        availability_territory_count: 0,
      }),
    );
    expect(iapsUpdateEq).toHaveBeenCalledWith("id", "row-1");
  });

  it("the mirror row carries a timestamp — a verdict that cannot be dated is not shown", async () => {
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-1" } });
    await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "remove",
      actor: "tester",
    });
    const columns = iapsUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof columns.availability_synced_at).toBe("string");
    expect(Number.isNaN(Date.parse(columns.availability_synced_at as string))).toBe(false);
  });

  it("'set-all' writes AVAILABLE with the catalogue's real size", async () => {
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-1" } });
    await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "set-all",
      actor: "tester",
    });
    expect(iapsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        availability_state: "AVAILABLE",
        availability_territory_count: CATALOGUE.length,
      }),
    );
  });

  it("'set-territories' writes the SUBSET's own size, not a rounded 'all'", async () => {
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-1" } });
    await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "set-territories",
      selection: { territoryIds: ["USA", "VNM"], availableInNewTerritories: false },
      actor: "tester",
    });
    expect(iapsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        availability_state: "AVAILABLE",
        availability_territory_count: 2,
      }),
    );
  });

  it("every successful row in a batch is mirrored, not just the first", async () => {
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-1" } });
    await executeBulkAvailability({
      creds,
      iapIds: ["row-1", "row-2", "row-3"],
      action: "remove",
      actor: "tester",
    });
    expect(iapsUpdate).toHaveBeenCalledTimes(3);
    const targets = iapsUpdateEq.mock.calls.map((c) => c[1]).sort();
    expect(targets).toEqual(["row-1", "row-2", "row-3"]);
  });
});

// ─── The other half — an attempt is not an acceptance ───────────────────────

describe("⚠ a write Apple did NOT accept leaves the mirror alone", () => {
  it("an Apple error mirrors nothing for that row", async () => {
    setAvailabilityTerritories.mockRejectedValue(new Error("400 Bad Request"));
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "remove",
      actor: "tester",
    });
    expect(out.results[0].status).toBe("FAILED");
    expect(iapsUpdate).not.toHaveBeenCalled();
  });

  it("a local draft (no apple_iap_id) mirrors nothing — nothing was sent", async () => {
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["draft-1"],
      action: "remove",
      actor: "tester",
    });
    expect(out.results[0].status).toBe("FAILED");
    expect(iapsUpdate).not.toHaveBeenCalled();
  });

  it("⚠ rows the stop latch never attempted are NOT mirrored", async () => {
    // Stop-and-preserve, on the write side. A NOT_ATTEMPTED row had nothing
    // sent for it; stamping a verdict and a fresh timestamp would claim
    // otherwise, and would do it for the exact rows a resume needs to find
    // untouched.
    setAvailabilityTerritories.mockRejectedValue(
      new AppleRateLimitError("POST", "/v1/x", "429 Too Many Requests", 0),
    );
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1", "row-2", "row-3", "row-4"],
      action: "remove",
      actor: "tester",
      concurrency: 1,
    });
    expect(out.results.some((r) => r.status === "NOT_ATTEMPTED")).toBe(true);
    expect(iapsUpdate).not.toHaveBeenCalled();
  });

  it("a mixed batch mirrors ONLY the rows Apple accepted", async () => {
    setAvailabilityTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } })
      .mockRejectedValueOnce(new Error("400 Bad Request"))
      .mockResolvedValueOnce({ data: { id: "av-3" } });

    await executeBulkAvailability({
      creds,
      iapIds: ["row-1", "row-2", "row-3"],
      action: "remove",
      actor: "tester",
      concurrency: 1,
    });

    const targets = iapsUpdateEq.mock.calls.map((c) => c[1]).sort();
    expect(targets).toEqual(["row-1", "row-3"]);
  });
});

// ─── Fail-soft — the mirror is a cache, never a gate ────────────────────────

describe("a failing mirror write never demotes a successful Apple write", () => {
  it("the row still reports SUCCESS when the local update errors", async () => {
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-1" } });
    iapsUpdateEq.mockImplementationOnce(() => {
      throw new Error("connection reset");
    });
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "remove",
      actor: "tester",
    });
    // Apple accepted it. What our own cache did about that is our problem, not
    // a fact about the item — the status principle (KB §9 P5).
    expect(out.overall).toBe("SUCCESS");
    expect(out.results[0].status).toBe("SUCCESS");
  });
});
