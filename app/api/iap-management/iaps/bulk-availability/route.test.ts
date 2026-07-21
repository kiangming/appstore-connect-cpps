/**
 * Hub-tracking wiring tests for the Apple bulk-availability route (6th+7th
 * integration, docs/iap-management/design-iap-availability-hub-tracking.md).
 * Mirrors app/api/google-iap-management/apps/[packageName]/iaps/
 * bulk-deactivate/route.test.ts. NOT a test of executeBulkAvailability
 * itself (mocked) — these prove the load-bearing guarantee: the
 * try/finally wrapper calls finalizeHubTracking exactly once on every
 * exit path (each early return + the success/failure of
 * executeBulkAvailability), with the correct run id + terminal status +
 * reason, tagged per the validated `action` ("iap-set-availabilities" /
 * "iap-remove-from-sales" — never a client-sent tag).
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
vi.mock("@/lib/iap-management/hub-tracking/tracking", () => ({ finalizeHubTracking }));

import { POST } from "./route";
import { IapUnauthorizedError } from "@/lib/iap-management/auth";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function badJsonReq(): Request {
  return new Request("http://localhost/api/x", { method: "POST", body: "not json" });
}

function outcome(
  action: "set-all" | "remove",
  overrides: Partial<{ total: number; succeeded: number; failed: number }> = {},
) {
  const total = overrides.total ?? 1;
  const succeeded = overrides.succeeded ?? total;
  const failed = overrides.failed ?? 0;
  return {
    action,
    total,
    succeeded,
    failed,
    results: [],
    overall: failed === 0 ? "SUCCESS" : succeeded === 0 ? "FAILURE" : "PARTIAL",
    summary: `${succeeded}/${total} succeeded`,
    rate_limit_total: {
      rate429_count: 0,
      retry_attempts: 0,
      backoff_total_ms: 0,
      longest_backoff_ms: 0,
      rows_throttled: 0,
    },
  };
}

beforeEach(() => {
  requireIapSession.mockReset().mockResolvedValue({ user: { email: "a@b.com", role: "member" } });
  getActiveAccount.mockReset().mockResolvedValue({
    id: "t",
    name: "T",
    keyId: "k",
    issuerId: "i",
    privateKey: "p",
  });
  executeBulkAvailability.mockReset();
  finalizeHubTracking.mockReset();
});

describe("Apple bulk-availability — Hub tracking closes on every exit exactly once", () => {
  it("401 unauthorized: closes FAILED under the generic default tag; no run id available yet (body never parsed)", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError());
    const res = await POST(jsonReq({ iapIds: ["x"], action: "set-all" }));
    expect(res.status).toBe(401);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.any(String),
      "iap-hub-tracking",
    );
  });

  it("400 invalid JSON body: closes FAILED under the generic default tag (action unknown)", async () => {
    const res = await POST(badJsonReq());
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.any(String),
      "iap-hub-tracking",
    );
  });

  it("400 zod validation failure (empty iapIds): closes FAILED — hub_run_id never reaches a validated state", async () => {
    const res = await POST(jsonReq({ iapIds: [], action: "set-all" }));
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.any(String),
      "iap-hub-tracking",
    );
  });

  it("blank hub_run_id is treated as no run (null), not an empty-string run id", async () => {
    executeBulkAvailability.mockResolvedValue(outcome("set-all"));
    const res = await POST(
      jsonReq({ iapIds: ["row-1"], action: "set-all", hub_run_id: "" }),
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "SUCCESS",
      undefined,
      "iap-set-availabilities",
    );
  });

  it("500 getActiveAccount failure: closes FAILED with the correct per-mode tag (action already known)", async () => {
    getActiveAccount.mockRejectedValue(new Error("no creds"));
    const res = await POST(
      jsonReq({ iapIds: ["row-1"], action: "remove", hub_run_id: "run-x" }),
    );
    expect(res.status).toBe(500);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-x",
      "FAILED",
      "Apple credentials unavailable",
      "iap-remove-from-sales",
    );
  });

  it("set-all all-success: closes SUCCESS tagged iap-set-availabilities", async () => {
    executeBulkAvailability.mockResolvedValue(outcome("set-all", { total: 2, succeeded: 2, failed: 0 }));
    const res = await POST(
      jsonReq({ iapIds: ["row-1", "row-2"], action: "set-all", hub_run_id: "run-1" }),
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-1",
      "SUCCESS",
      undefined,
      "iap-set-availabilities",
    );
  });

  it("remove mixed result: closes PARTIAL tagged iap-remove-from-sales", async () => {
    executeBulkAvailability.mockResolvedValue(outcome("remove", { total: 4, succeeded: 2, failed: 2 }));
    const res = await POST(
      jsonReq({ iapIds: ["row-1", "row-2", "row-3", "row-4"], action: "remove", hub_run_id: "run-2" }),
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-2",
      "PARTIAL",
      undefined,
      "iap-remove-from-sales",
    );
  });

  it("all-failed: closes FAILED with the failure-count reason", async () => {
    executeBulkAvailability.mockResolvedValue(outcome("remove", { total: 3, succeeded: 0, failed: 3 }));
    const res = await POST(
      jsonReq({ iapIds: ["row-1", "row-2", "row-3"], action: "remove", hub_run_id: "run-3" }),
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-3",
      "FAILED",
      expect.stringContaining("failed"),
      "iap-remove-from-sales",
    );
  });

  it("zero-eligible (NO_OP shape from the orchestrator, total=0): closes SUCCESS, never FAILED", async () => {
    executeBulkAvailability.mockResolvedValue(outcome("set-all", { total: 0, succeeded: 0, failed: 0 }));
    const res = await POST(
      jsonReq({ iapIds: ["row-1"], action: "set-all", hub_run_id: "run-4" }),
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-4",
      "SUCCESS",
      undefined,
      "iap-set-availabilities",
    );
  });

  it("the two tags are actually distinct for the same route", async () => {
    executeBulkAvailability.mockResolvedValue(outcome("set-all"));
    await POST(jsonReq({ iapIds: ["row-1"], action: "set-all", hub_run_id: "run-a" }));
    executeBulkAvailability.mockResolvedValue(outcome("remove"));
    await POST(jsonReq({ iapIds: ["row-1"], action: "remove", hub_run_id: "run-b" }));

    const tags = finalizeHubTracking.mock.calls.map((c) => c[3]);
    expect(tags).toEqual(["iap-set-availabilities", "iap-remove-from-sales"]);
  });

  // ── R1 mutation-check target: this test forces an UNEXPECTED,
  // completely UNCAUGHT throw from executeBulkAvailability (no inner
  // try/catch wraps this call in the route, unlike the getActiveAccount
  // step) and asserts the route's finally STILL finalizes Hub with
  // FAILED before the exception propagates. See the PR description for
  // the pass→fail→pass mutation-check proof that removing the route's
  // `finally` makes this test fail.
  it("R1: executeBulkAvailability throwing unexpectedly still closes FAILED (never left RUNNING), then the exception propagates", async () => {
    executeBulkAvailability.mockRejectedValue(new Error("DB connection reset"));
    await expect(
      POST(jsonReq({ iapIds: ["row-1"], action: "set-all", hub_run_id: "run-5" })),
    ).rejects.toThrow("DB connection reset");
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-5",
      "FAILED",
      undefined,
      "iap-set-availabilities",
    );
  });
});
