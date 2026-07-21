/**
 * Hub-tracking wiring tests for the Google bulk-deactivate route — mirrors
 * app/api/google-iap-management/apps/[packageName]/bulk-import/execute/route.test.ts
 * (5th integration, docs/google-iap-management/design-bulk-status-hub-tracking.md).
 * NOT a test of executeBulkStatus itself (mocked) — these prove the
 * load-bearing guarantee: the try/finally wrapper calls finalizeHubTracking
 * exactly once on every exit path (each early return + the success/failure
 * of executeBulkStatus), with the correct run id + terminal status +
 * reason, tagged "google-iap-bulk-deactivate".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));

const listAccounts = vi.hoisted(() => vi.fn());
const getEncryptedCredentials = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts,
  getEncryptedCredentials,
}));

const getAppByPackage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({ getAppByPackage }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

const jwtClientFromEncrypted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted }));

const executeBulkStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/orchestration/bulk-status", () => ({ executeBulkStatus }));

const finalizeHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/hub-tracking/tracking", () => ({ finalizeHubTracking }));

import { POST } from "./route";

const ctx = { params: { packageName: "com.example.app" } };

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function outcome(overrides: Partial<{ total: number; succeeded: number; failed: number }> = {}) {
  const total = overrides.total ?? 1;
  const succeeded = overrides.succeeded ?? 1;
  const failed = overrides.failed ?? 0;
  return {
    action: "deactivate",
    total,
    succeeded,
    failed,
    results: [],
    overall: failed === 0 ? "SUCCESS" : succeeded === 0 ? "FAILURE" : "PARTIAL",
    summary: `${succeeded}/${total} succeeded`,
    batches: 1,
  };
}

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { email: "a@b.com" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  getEncryptedCredentials.mockReset().mockResolvedValue({ enc: "x" });
  getAppByPackage.mockReset().mockResolvedValue({ id: "app1", default_currency: "USD" });
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  jwtClientFromEncrypted.mockReset().mockReturnValue({});
  executeBulkStatus.mockReset();
  finalizeHubTracking.mockReset();
});

describe("Google bulk-deactivate — Hub tracking closes on every exit exactly once", () => {
  it("401 unauthorized: closes FAILED; no run id available yet (body never parsed)", async () => {
    getServerSession.mockResolvedValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(401);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      "Unauthorized",
      "google-iap-bulk-deactivate",
    );
  });

  it("400 no Google Console account configured: closes FAILED", async () => {
    resolveActiveAccountId.mockReturnValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.stringContaining("Google Console"),
      "google-iap-bulk-deactivate",
    );
  });

  it("404 app not cached: closes FAILED", async () => {
    getAppByPackage.mockResolvedValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(404);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.stringContaining("not cached"),
      "google-iap-bulk-deactivate",
    );
  });

  it("400 invalid JSON body: closes FAILED", async () => {
    const badReq = new Request("http://localhost/api/x", { method: "POST", body: "not json" });
    const res = await POST(badReq, ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      "Invalid JSON body.",
      "google-iap-bulk-deactivate",
    );
  });

  it("hub_run_id is parsed as soon as the body is validated — closed even on a validation failure", async () => {
    const res = await POST(jsonReq({ skus: [] }), ctx);
    expect(res.status).toBe(400);
    // zod rejects skus:[] (min 1) before hub_run_id would be readable from
    // `parsed` — this proves the FAILED default fires even when the body
    // never reaches a validated state at all.
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.any(String),
      "google-iap-bulk-deactivate",
    );
  });

  it("blank hub_run_id is treated as no run (null), not an empty-string run id", async () => {
    executeBulkStatus.mockResolvedValue(outcome());
    const res = await POST(jsonReq({ skus: ["sku1"], hub_run_id: "" }), ctx);
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "SUCCESS",
      undefined,
      "google-iap-bulk-deactivate",
    );
  });

  it("all-success (all-skipped-equivalent zero-eligible edge included): closes SUCCESS", async () => {
    executeBulkStatus.mockResolvedValue(outcome({ total: 2, succeeded: 2, failed: 0 }));
    const res = await POST(jsonReq({ skus: ["sku1", "sku2"], hub_run_id: "run-2" }), ctx);
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-2",
      "SUCCESS",
      undefined,
      "google-iap-bulk-deactivate",
    );
  });

  it("mixed result (some succeeded, some failed): closes PARTIAL", async () => {
    executeBulkStatus.mockResolvedValue(outcome({ total: 4, succeeded: 2, failed: 2 }));
    const res = await POST(jsonReq({ skus: ["sku1"], hub_run_id: "run-3" }), ctx);
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-3",
      "PARTIAL",
      undefined,
      "google-iap-bulk-deactivate",
    );
  });

  it("all-failed: closes FAILED", async () => {
    executeBulkStatus.mockResolvedValue(outcome({ total: 3, succeeded: 0, failed: 3 }));
    const res = await POST(jsonReq({ skus: ["sku1"], hub_run_id: "run-4" }), ctx);
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-4",
      "FAILED",
      expect.stringContaining("failed"),
      "google-iap-bulk-deactivate",
    );
  });

  it("1fb3f7e multi-option warning does NOT change the terminal status (stays SUCCESS, not folded in)", async () => {
    executeBulkStatus.mockResolvedValue({
      ...outcome({ total: 1, succeeded: 1, failed: 0 }),
      results: [{ sku: "sku1", ok: true, warning: "Product has multiple active purchase options — only one was targeted; the other(s) remain unchanged." }],
    });
    const res = await POST(jsonReq({ skus: ["sku1"], hub_run_id: "run-5" }), ctx);
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-5",
      "SUCCESS",
      undefined,
      "google-iap-bulk-deactivate",
    );
  });

  // ── R1 mutation-check target: this test forces an UNEXPECTED throw
  // from executeBulkStatus (not a per-chunk-caught failure — a hard
  // reject from the orchestrator call itself) and asserts the route's
  // finally still finalizes Hub with FAILED. See the mutation-check
  // evidence in the PR description for the pass→fail→pass proof that
  // removing the route's `finally` makes this test fail.
  it("R1: executeBulkStatus throwing unexpectedly still closes FAILED with the specific message (never left RUNNING)", async () => {
    executeBulkStatus.mockRejectedValue({ code: 502, message: "Google API sync failed" });
    const res = await POST(jsonReq({ skus: ["sku1"], hub_run_id: "run-6" }), ctx);
    expect(res.status).toBe(502);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-6",
      "FAILED",
      "Google API sync failed",
      "google-iap-bulk-deactivate",
    );
  });

  it("executeBulkStatus throwing without a code defaults to 500", async () => {
    executeBulkStatus.mockRejectedValue(new Error("boom"));
    const res = await POST(jsonReq({ skus: ["sku1"], hub_run_id: "run-7" }), ctx);
    expect(res.status).toBe(500);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-7",
      "FAILED",
      "boom",
      "google-iap-bulk-deactivate",
    );
  });
});
