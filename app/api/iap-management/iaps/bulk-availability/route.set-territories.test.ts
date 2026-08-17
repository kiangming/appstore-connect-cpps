/**
 * END-TO-END THROUGH HTTP — the only shape of test that catches the fifth
 * LAYER-GAP in this project.
 *
 * ⚠ WHY THIS FILE EXISTS. SC2 shipped a fully selection-driven
 * `executeBulkAvailability` and SC3 shipped stop-and-resume on top of it. Both
 * were complete and BOTH WERE UNREACHABLE: the route's zod schema still read
 * `z.enum(["set-all","remove"])` and accepted no `selection`, so every
 * set-territories request died at the HTTP boundary with a 400. Nothing caught
 * it for two chunks, because every test below the route called the orchestrator
 * DIRECTLY — no test ever put a request body through the real schema.
 *
 * So this file deliberately does the one thing those tests could not:
 *   1. builds the body with `buildBulkAvailabilityRequestBody` — the exact
 *      function the modal calls, not a hand-written literal that could drift
 *      from it;
 *   2. pushes it through the REAL exported `POST` (real zod, real branching);
 *   3. asserts the selection arrived at the orchestrator intact, and that all
 *      three row states survive the trip back out.
 *
 * The orchestrator itself is mocked — this tests the seam, not the writes.
 * If the schema narrows again, or the modal stops sending `selection`, these
 * fail. That is the whole point.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/auth")>(
    "@/lib/iap-management/auth",
  );
  return { ...actual, requireIapSession };
});

const getActiveAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));

const executeBulkAvailability = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/orchestrators/bulk-availability", () => ({
  executeBulkAvailability,
}));

const finalizeHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/hub-tracking/tracking", () => ({
  finalizeHubTracking,
}));

import { POST } from "./route";
import { buildBulkAvailabilityRequestBody } from "@/lib/iap-management/apple/bulk-availability-view";
import { subsetSelection } from "@/lib/iap-management/apple/territory-selection";

/** Ids with mixed case and a non-alphabetical order, so any normalisation or
 *  sorting anywhere along the path becomes visible. */
const IDS = ["VNM", "USA", "BRA"];

function req(body: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The three states SC3 produces, as the orchestrator would report them. */
function stoppedOutcome() {
  return {
    total: 4,
    succeeded: 2,
    failed: 1,
    results: [
      { iapId: "i-1", ok: true, status: "SUCCESS" },
      { iapId: "i-2", ok: true, status: "SUCCESS" },
      { iapId: "i-3", ok: false, status: "FAILED", error: "Apple 409 state guard" },
      { iapId: "i-4", ok: false, status: "NOT_ATTEMPTED" },
    ],
    remainder: ["i-4"],
    overall: "STOPPED_RATE_LIMITED",
    stopped_reason: "RATE_LIMIT",
    summary: "stopped after 3 of 4",
    rate_limit_total: {
      rate429_count: 4,
      retry_attempts: 3,
      backoff_total_ms: 3500,
      longest_backoff_ms: 2000,
      rows_throttled: 1,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireIapSession.mockResolvedValue({ user: { email: "m@x.com" } });
  getActiveAccount.mockResolvedValue({ id: "acc-1" });
  executeBulkAvailability.mockResolvedValue(stoppedOutcome());
});

describe("set-territories survives the HTTP boundary", () => {
  it("⚠ the body the MODAL builds passes zod and reaches the orchestrator", async () => {
    const selection = subsetSelection(IDS);
    const body = buildBulkAvailabilityRequestBody({
      mode: "set-territories",
      iapIds: ["i-1", "i-2", "i-3", "i-4"],
      selection,
      hubRunId: null,
    });

    const res = await POST(req(body));

    // A 400 here is the layer gap re-opening.
    expect(res.status).toBe(200);
    expect(executeBulkAvailability).toHaveBeenCalledTimes(1);
    const args = executeBulkAvailability.mock.calls[0][0];
    expect(args.action).toBe("set-territories");
    expect(args.selection).toEqual(selection);
  });

  it("⚠ territory ids arrive verbatim — order and case untouched", async () => {
    await POST(
      req(
        buildBulkAvailabilityRequestBody({
          mode: "set-territories",
          iapIds: ["i-1"],
          selection: subsetSelection(IDS),
          hubRunId: null,
        }),
      ),
    );
    expect(
      executeBulkAvailability.mock.calls[0][0].selection.territoryIds,
    ).toEqual(IDS);
  });

  it("⚠ the forward-looking flag survives BOTH ways (KB §4.13)", async () => {
    // Identical ids, different flags ⇒ two different Apple requests. A schema
    // with `.default(false)` would silently collapse the first into the second.
    await POST(
      req(
        buildBulkAvailabilityRequestBody({
          mode: "set-territories",
          iapIds: ["i-1"],
          selection: { territoryIds: IDS, availableInNewTerritories: true },
          hubRunId: null,
        }),
      ),
    );
    expect(
      executeBulkAvailability.mock.calls[0][0].selection
        .availableInNewTerritories,
    ).toBe(true);

    await POST(
      req(
        buildBulkAvailabilityRequestBody({
          mode: "set-territories",
          iapIds: ["i-1"],
          selection: { territoryIds: IDS, availableInNewTerritories: false },
          hubRunId: null,
        }),
      ),
    );
    expect(
      executeBulkAvailability.mock.calls[1][0].selection
        .availableInNewTerritories,
    ).toBe(false);
  });

  it("⚠ all three row states survive the round trip", async () => {
    const res = await POST(
      req(
        buildBulkAvailabilityRequestBody({
          mode: "set-territories",
          iapIds: ["i-1", "i-2", "i-3", "i-4"],
          selection: subsetSelection(IDS),
          hubRunId: null,
        }),
      ),
    );
    const json = (await res.json()) as ReturnType<typeof stoppedOutcome>;

    expect(json.overall).toBe("STOPPED_RATE_LIMITED");
    expect(json.results.map((r) => r.status)).toEqual([
      "SUCCESS",
      "SUCCESS",
      "FAILED",
      "NOT_ATTEMPTED",
    ]);
    // The remainder a resume would use — successes and failures excluded by
    // construction.
    expect(json.remainder).toEqual(["i-4"]);
  });

  it("a selection-less set-territories request is rejected with a usable 400", async () => {
    // Not a thrown 500 from the orchestrator's own guard.
    const res = await POST(
      req({ iapIds: ["i-1"], action: "set-territories" }),
    );
    expect(res.status).toBe(400);
    expect(executeBulkAvailability).not.toHaveBeenCalled();
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("selection");
  });

  it("a malformed selection is rejected by the schema, not passed through", async () => {
    const res = await POST(
      req({
        iapIds: ["i-1"],
        action: "set-territories",
        selection: { territoryIds: ["USA"] }, // flag missing
      }),
    );
    expect(res.status).toBe(400);
    expect(executeBulkAvailability).not.toHaveBeenCalled();
  });
});

describe("a stopped run is reported to the hub as PARTIAL, never SUCCESS", () => {
  it("⚠ failed === 0 + a large remainder must not close as SUCCESS (P5)", async () => {
    executeBulkAvailability.mockResolvedValue({
      ...stoppedOutcome(),
      succeeded: 2,
      failed: 0,
      total: 50,
      results: [
        { iapId: "i-1", ok: true, status: "SUCCESS" },
        { iapId: "i-2", ok: true, status: "SUCCESS" },
      ],
    });

    await POST(
      req(
        buildBulkAvailabilityRequestBody({
          mode: "set-territories",
          iapIds: ["i-1", "i-2"],
          selection: subsetSelection(IDS),
          hubRunId: "run-9",
        }),
      ),
    );

    const [runId, status, reason] = finalizeHubTracking.mock.calls[0];
    expect(runId).toBe("run-9");
    // The shared mapping keys off `failed`; with none, it would say SUCCESS and
    // the hub row would claim a 50-item batch completed.
    expect(status).toBe("PARTIAL");
    expect(reason).toContain("48");
  });

  it("uses the distinct hub tag for the third action", async () => {
    await POST(
      req(
        buildBulkAvailabilityRequestBody({
          mode: "set-territories",
          iapIds: ["i-1"],
          selection: subsetSelection(IDS),
          hubRunId: "run-1",
        }),
      ),
    );
    const feature = finalizeHubTracking.mock.calls[0][3];
    expect(feature).toBe("iap-set-territories");
    expect(feature).not.toBe("iap-set-availabilities");
  });
});
