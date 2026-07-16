/**
 * Hub-tracking wiring tests for the Google bulk-import execute route —
 * mirrors app/api/iap-management/apps/[appId]/bulk-import/execute/route.test.ts
 * (Apple). NOT a test of the Google orchestrator itself (executeBulkImport
 * is mocked) — these prove the load-bearing guarantee: the try/finally
 * wrapper calls finalizeHubTracking exactly once on every exit path (each
 * early return + the success/failure of executeBulkImport), with the
 * correct run id + terminal status + reason.
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

const executeBulkImport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/orchestration/bulk-import", () => ({ executeBulkImport }));

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

const validRow = {
  rowNumber: 1,
  sku: "sku1",
  baseCurrency: "USD",
  basePriceDecimal: "0.99",
  decision: "create",
};

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { email: "a@b.com" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  getEncryptedCredentials.mockReset().mockResolvedValue({ enc: "x" });
  getAppByPackage.mockReset().mockResolvedValue({ id: "app1", default_currency: "USD" });
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  jwtClientFromEncrypted.mockReset().mockReturnValue({});
  executeBulkImport.mockReset();
  finalizeHubTracking.mockReset();
});

describe("Google bulk-import execute — Hub tracking closes on every exit exactly once", () => {
  it("401 unauthorized: closes FAILED; no run id available yet (body never parsed)", async () => {
    getServerSession.mockResolvedValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(401);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", "Unauthorized");
  });

  it("400 no Google Console account configured: closes FAILED", async () => {
    resolveActiveAccountId.mockReturnValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.stringContaining("Google Console"),
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
    );
  });

  it("400 invalid JSON body: closes FAILED", async () => {
    const badReq = new Request("http://localhost/api/x", { method: "POST", body: "not json" });
    const res = await POST(badReq, ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", "Invalid JSON body.");
  });

  it("hub_run_id is parsed as soon as the JSON body is available — closed even on a later validation failure", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-abc", pricingSource: "bogus", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-abc",
      "FAILED",
      expect.stringContaining("pricingSource"),
    );
  });

  it("blank hub_run_id is treated as no run (null), not an empty-string run id", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "", pricingSource: "bogus", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", expect.any(String));
  });

  it("400 empty rows: closes FAILED", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-1", pricingSource: "google_default", rows: [] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-1", "FAILED", "rows is required.");
  });

  it("400 per-row validation failure (missing sku): closes FAILED", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-1", pricingSource: "google_default", rows: [{ rowNumber: 1 }] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-1",
      "FAILED",
      expect.stringContaining("sku"),
    );
  });

  it("success (all created): closes SUCCESS", async () => {
    executeBulkImport.mockResolvedValue({
      rowsTotal: 2,
      rowsCreated: 2,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      rowsRefused: 0,
      refusedRows: [],
      durationMs: 10,
    });
    const res = await POST(
      jsonReq({
        hub_run_id: "run-2",
        pricingSource: "google_default",
        rows: [validRow, { ...validRow, rowNumber: 2, sku: "sku2" }],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-2", "SUCCESS", undefined);
  });

  it("mixed result (some created, some failed): closes PARTIAL", async () => {
    executeBulkImport.mockResolvedValue({
      rowsTotal: 4,
      rowsCreated: 2,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 2,
      rowsRefused: 0,
      refusedRows: [],
      durationMs: 10,
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-3", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-3", "PARTIAL", undefined);
  });

  it("all rows refused (cross-currency fail-soft, folded into skipped): closes SUCCESS, not FAILED", async () => {
    executeBulkImport.mockResolvedValue({
      rowsTotal: 3,
      rowsCreated: 0,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      rowsRefused: 3,
      refusedRows: [{ sku: "sku1", rowNumber: 1, reason: "no match", kind: "template_miss" }],
      durationMs: 10,
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-4", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-4", "SUCCESS", undefined);
  });

  it("executeBulkImport throwing closes FAILED with the specific message + maps err.code to HTTP status", async () => {
    executeBulkImport.mockRejectedValue({ code: 502, message: "Google API sync failed" });
    const res = await POST(
      jsonReq({ hub_run_id: "run-5", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(502);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-5", "FAILED", "Google API sync failed");
  });

  it("executeBulkImport throwing without a code defaults to 500", async () => {
    executeBulkImport.mockRejectedValue(new Error("boom"));
    const res = await POST(
      jsonReq({ hub_run_id: "run-6", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-6", "FAILED", "boom");
  });
});
