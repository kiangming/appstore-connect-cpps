/**
 * Tests for Cycle 39 Phase 2 bulk-availability orchestrator.
 *
 * Covers:
 *   • Empty input → NO_OP without touching Apple.
 *   • Per-IAP audit row written for every row (success + error).
 *   • Q-K fail-soft: one row fails → siblings still succeed → overall=PARTIAL.
 *   • Local-draft row (no apple_iap_id) surfaces a per-row failure.
 *   • Action → Apple helper routing:
 *       - "set-all"  → setAvailabilityToAllTerritories
 *       - "remove"   → setAvailabilityRemoveFromSales
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const setAvailabilityToAllTerritories = vi.hoisted(() => vi.fn());
const setAvailabilityRemoveFromSales = vi.hoisted(() => vi.fn());
const auditInsert = vi.hoisted(() => vi.fn());
const dbSelect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/iap-management/apple/availabilities", () => ({
  setAvailabilityToAllTerritories,
  setAvailabilityRemoveFromSales,
}));
vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({
    from: (table: string) => {
      if (table === "iaps") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => {
              dbSelect(ids);
              return Promise.resolve({
                data: ids.map((id) => ({
                  id,
                  // Convention for these tests: id "draft-X" => no apple_iap_id.
                  apple_iap_id: id.startsWith("draft-") ? null : `APL_${id}`,
                })),
                error: null,
              });
            },
          }),
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
  setAvailabilityToAllTerritories.mockReset();
  setAvailabilityRemoveFromSales.mockReset();
  auditInsert.mockReset();
  dbSelect.mockReset();
});

describe("executeBulkAvailability — empty input", () => {
  it("returns NO_OP without calling Apple or the DB", async () => {
    const out = await executeBulkAvailability({
      creds,
      iapIds: [],
      action: "set-all",
      actor: "tester",
    });
    expect(out.overall).toBe("NO_OP");
    expect(out.total).toBe(0);
    expect(setAvailabilityToAllTerritories).not.toHaveBeenCalled();
    expect(setAvailabilityRemoveFromSales).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });
});

describe("executeBulkAvailability — action routing", () => {
  it("'set-all' calls setAvailabilityToAllTerritories with the Apple id", async () => {
    setAvailabilityToAllTerritories.mockResolvedValue({
      data: { id: "av-1", type: "inAppPurchaseAvailabilities" },
    });
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "set-all",
      actor: "tester",
    });
    expect(setAvailabilityToAllTerritories).toHaveBeenCalledWith(creds, "APL_row-1");
    expect(setAvailabilityRemoveFromSales).not.toHaveBeenCalled();
    expect(out.overall).toBe("SUCCESS");
    expect(out.results[0]).toMatchObject({
      iapId: "row-1",
      apple_iap_id: "APL_row-1",
      ok: true,
      apple_availability_id: "av-1",
    });
  });

  it("'remove' calls setAvailabilityRemoveFromSales", async () => {
    setAvailabilityRemoveFromSales.mockResolvedValue({
      data: { id: "av-2", type: "inAppPurchaseAvailabilities" },
    });
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-2"],
      action: "remove",
      actor: "tester",
    });
    expect(setAvailabilityRemoveFromSales).toHaveBeenCalledWith(creds, "APL_row-2");
    expect(setAvailabilityToAllTerritories).not.toHaveBeenCalled();
    expect(out.overall).toBe("SUCCESS");
  });
});

describe("executeBulkAvailability — audit logging", () => {
  it("writes exactly one actions_log row per IAP using the matching action_type", async () => {
    setAvailabilityRemoveFromSales.mockResolvedValue({
      data: { id: "av-x" },
    });
    await executeBulkAvailability({
      creds,
      iapIds: ["row-1", "row-2", "row-3"],
      action: "remove",
      actor: "ops@example.com",
    });
    expect(auditInsert).toHaveBeenCalledTimes(3);
    for (const call of auditInsert.mock.calls) {
      const row = call[0] as { action_type: string; payload: { source: string } };
      expect(row.action_type).toBe("AVAILABILITY_REMOVE_FROM_SALES");
      expect(row.payload.source).toBe("bulk");
    }
  });

  it("captures per-row error in actions_log payload when Apple rejects", async () => {
    setAvailabilityToAllTerritories.mockRejectedValueOnce(new Error("Apple 409 STATE_ERROR"));
    await executeBulkAvailability({
      creds,
      iapIds: ["row-1"],
      action: "set-all",
      actor: "tester",
    });
    const row = auditInsert.mock.calls[0][0] as {
      payload: { result: string; error: string };
    };
    expect(row.payload.result).toBe("ERROR");
    expect(row.payload.error).toContain("Apple 409");
  });
});

describe("executeBulkAvailability — Q-K fail-soft (PARTIAL roll-up)", () => {
  it("succeeds 2 rows + fails 1 row → overall=PARTIAL with per-row visibility", async () => {
    setAvailabilityToAllTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } })
      .mockRejectedValueOnce(new Error("Apple 503"))
      .mockResolvedValueOnce({ data: { id: "av-3" } });
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1", "row-2", "row-3"],
      action: "set-all",
      actor: "tester",
    });
    expect(out.overall).toBe("PARTIAL");
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.results[0].ok).toBe(true);
    expect(out.results[1].ok).toBe(false);
    expect(out.results[2].ok).toBe(true);
  });

  it("all rows fail → overall=FAILURE", async () => {
    setAvailabilityRemoveFromSales.mockRejectedValue(new Error("Apple 503"));
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["row-1", "row-2"],
      action: "remove",
      actor: "tester",
    });
    expect(out.overall).toBe("FAILURE");
    expect(out.succeeded).toBe(0);
    expect(out.failed).toBe(2);
  });
});

describe("executeBulkAvailability — local-draft rows", () => {
  it("surfaces 'not synced' as a per-row failure without calling Apple for that row", async () => {
    setAvailabilityToAllTerritories.mockResolvedValueOnce({ data: { id: "av-1" } });
    const out = await executeBulkAvailability({
      creds,
      iapIds: ["draft-x", "row-1"],
      action: "set-all",
      actor: "tester",
    });
    expect(out.overall).toBe("PARTIAL");
    const draftRow = out.results.find((r) => r.iapId === "draft-x");
    expect(draftRow?.ok).toBe(false);
    expect(draftRow?.error).toMatch(/not synced/i);
    // Apple helper called only once — for the synced row.
    expect(setAvailabilityToAllTerritories).toHaveBeenCalledTimes(1);
  });
});
