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
import { readFileSync } from "fs";
import { join } from "path";

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

describe("Google bulk-import execute — per-item custom prices (SC4)", () => {
  const templateRow = {
    ...validRow,
    customPrices: {
      entries: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
      baselineTier: "tier_999",
      editedAt: "2026-08-07T10:00:00.000Z",
    },
  };
  const okResult = {
    batchId: "b1",
    rowsTotal: 1,
    rowsCreated: 1,
    rowsOverwritten: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    rowsRefused: 0,
    refusedRows: [],
    customPricedRows: 1,
    customRefusedRows: 0,
    durationMs: 10,
  };

  it("forwards a valid custom set to the orchestrator", async () => {
    executeBulkImport.mockResolvedValue(okResult);
    const res = await POST(
      jsonReq({ hub_run_id: "run-c1", pricingSource: "default_template", rows: [templateRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPrices).toEqual({
      entries: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
      baselineTier: "tier_999",
      editedAt: "2026-08-07T10:00:00.000Z",
    });
  });

  it("400s a custom set under Google Conversion — a silent ignore would misreport what shipped", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-c2", pricingSource: "google_default", rows: [templateRow] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("Google Conversion"),
    });
    expect(executeBulkImport).not.toHaveBeenCalled();
  });

  it("SERVER-SIDE RE-VALIDATION rejects what the dialog would have caught (client state is untrusted)", async () => {
    executeBulkImport.mockResolvedValue({ ...okResult, customPricedRows: 0, customRefusedRows: 1 });
    // VND takes no decimals — the dialog blocks this, a stale tab wouldn't.
    const res = await POST(
      jsonReq({
        hub_run_id: "run-c3",
        pricingSource: "default_template",
        rows: [
          {
            ...validRow,
            customPrices: {
              entries: [{ region: "VN", currency: "VND", priceDecimal: "199000.55" }],
            },
          },
        ],
      }),
      ctx,
    );
    // Not a 400 — the ROW is refused, the batch still runs.
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPriceRefusal).toMatchObject({ kind: "custom_invalid_price" });
    expect(arg.rows[0].customPriceRefusal.reason).toContain("199000.55");
    expect(arg.rows[0].customPrices.entries).toEqual([]);
  });

  it("one malformed custom row does NOT 400 the batch — 99 good rows still proceed", async () => {
    executeBulkImport.mockResolvedValue({ ...okResult, rowsTotal: 2, customRefusedRows: 1 });
    const good = { ...templateRow, rowNumber: 2, sku: "good" };
    const bad = {
      ...validRow,
      rowNumber: 3,
      sku: "bad",
      customPrices: { entries: [{ region: "", currency: "VND", priceDecimal: "199000" }] },
    };
    const res = await POST(
      jsonReq({ hub_run_id: "run-c4", pricingSource: "default_template", rows: [good, bad] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPriceRefusal ?? null).toBeNull();
    expect(arg.rows[1].customPriceRefusal).toMatchObject({ kind: "custom_invalid_price" });
  });

  it("400s an empty entries array", async () => {
    const res = await POST(
      jsonReq({
        hub_run_id: "run-c5",
        pricingSource: "default_template",
        rows: [{ ...validRow, customPrices: { entries: [] } }],
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("P5/Q5: a refused CUSTOM row closes the Hub run FAILED, not SUCCESS", async () => {
    // Zero Google-side failures, one custom refusal. Pre-Q5 this closed
    // SUCCESS because refusals folded into "skipped" — reporting an
    // outcome that plainly did not happen.
    executeBulkImport.mockResolvedValue({
      ...okResult,
      rowsCreated: 0,
      rowsFailed: 0,
      rowsRefused: 1,
      customPricedRows: 0,
      customRefusedRows: 1,
      refusedRows: [
        { sku: "sku1", rowNumber: 1, reason: "no VND entry", kind: "custom_no_app_currency_entry" },
      ],
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-c6", pricingSource: "default_template", rows: [templateRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-c6", "FAILED", expect.any(String));
  });

  it("cross-currency refusal semantics are UNCHANGED — still a soft skip closing SUCCESS", async () => {
    executeBulkImport.mockResolvedValue({
      ...okResult,
      rowsCreated: 1,
      rowsFailed: 0,
      rowsRefused: 1,
      customPricedRows: 0,
      customRefusedRows: 0,
      refusedRows: [
        { sku: "x", rowNumber: 9, reason: "cross-currency", kind: "template_miss" },
      ],
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-c7", pricingSource: "default_template", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-c7", "SUCCESS", undefined);
  });
});

/**
 * Static posture guard (same genre as lib/iap-management/rbac-posture.test.ts).
 *
 * Phase 3 sends per-item custom prices as a full ~170-entry set per row,
 * which puts a 100-row batch at 0.96-1.07 MB — right on the 1 MB body
 * limit Next.js applies to SERVER ACTIONS (route handlers have none).
 * Converting this endpoint to a Server Action would silently start
 * rejecting custom-heavy batches at ~95 rows.
 *
 * The route's own docstring says so, but a docstring is not a guard: this
 * codebase has already had a documented-then-reintroduced bug (the
 * listInAppPurchases warning), which is why that function was deleted
 * rather than re-annotated. This makes the conversion go red instead.
 */
describe("bulk-import execute route — posture", () => {
  it("is a Route Handler, never a Server Action (1 MB body-limit boundary)", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).not.toMatch(/^\s*["']use server["']/m);
  });
});
