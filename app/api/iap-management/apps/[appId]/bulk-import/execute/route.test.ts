/**
 * Hub-tracking wiring tests for the bulk-import execute route — NOT a test
 * of the Apple orchestration itself (that has no pre-existing test harness
 * and building one is out of scope for additive tracking instrumentation).
 * These prove the load-bearing guarantee: the outer `POST` wrapper's
 * `finally` calls `finalizeHubTracking` exactly once on every representative
 * exit path (401 / 400×3 / 422 / 502), with the correct run id + FAILED
 * status + reason. The SUCCESS/PARTIAL/total===0 status formula itself is
 * covered in isolation by hub-tracking/status-mapping.test.ts.
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

// route.ts transitively imports queries/templates.ts → asc-account-repository.ts
// → lib/supabase.ts, which instantiates a real Supabase client at module
// scope (throws without env vars in test). Stub it so import stays
// hermetic — mirrors queries/templates.test.ts's own convention.
vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn() }));

const parseIapItemsXlsx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/parsers/iap-items", () => ({ parseIapItemsXlsx }));

const finalizeHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/hub-tracking/tracking", () => ({ finalizeHubTracking }));

import { POST } from "./route";
import { IapUnauthorizedError } from "@/lib/iap-management/auth";

function buildRequest(entries: Array<[string, string | File]>): Request {
  const fd = new FormData();
  for (const [k, v] of entries) {
    if (typeof v === "string") fd.append(k, v);
    else fd.append(k, v);
  }
  return new Request("http://localhost/api/iap-management/apps/999/bulk-import/execute", {
    method: "POST",
    body: fd,
  });
}

const ctx = { params: { appId: "999" } };
const session = { user: { email: "a@b.com", role: "member" } };

beforeEach(() => {
  requireIapSession.mockReset();
  getActiveAccount.mockReset();
  parseIapItemsXlsx.mockReset();
  finalizeHubTracking.mockReset();
  parseIapItemsXlsx.mockResolvedValue({ items: [], skipped_locales: [] });
});

describe("bulk-import execute — Hub tracking closes on every exit exactly once", () => {
  it("401 unauthorized: closes FAILED; no run id available yet (body never parsed)", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError());
    const res = await POST(buildRequest([]), ctx);
    expect(res.status).toBe(401);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", expect.any(String));
  });

  it("400 invalid form body (non-multipart request): closes FAILED", async () => {
    requireIapSession.mockResolvedValue(session);
    const badReq = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not multipart",
    });
    const res = await POST(badReq, ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", "Invalid form body");
  });

  it("400 missing excel field: hub_run_id is parsed EVEN THOUGH excel is missing (read before the excel check)", async () => {
    requireIapSession.mockResolvedValue(session);
    const res = await POST(buildRequest([["hub_run_id", "run-abc"]]), ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-abc",
      "FAILED",
      expect.stringContaining("excel"),
    );
  });

  it("blank hub_run_id field is treated as no run (null), not an empty-string run id", async () => {
    requireIapSession.mockResolvedValue(session);
    const res = await POST(buildRequest([["hub_run_id", ""]]), ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", expect.any(String));
  });

  it("400 invalid config JSON: closes FAILED", async () => {
    requireIapSession.mockResolvedValue(session);
    const excel = new File(["x"], "a.xlsx");
    const res = await POST(
      buildRequest([
        ["hub_run_id", "run-1"],
        ["excel", excel],
        ["config", "not-json"],
      ]),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-1",
      "FAILED",
      expect.stringContaining("config"),
    );
  });

  it("422 excel parse failure: closes FAILED with the parser's message", async () => {
    requireIapSession.mockResolvedValue(session);
    parseIapItemsXlsx.mockRejectedValue(new Error("bad header row"));
    const excel = new File(["x"], "a.xlsx");
    const res = await POST(
      buildRequest([
        ["hub_run_id", "run-2"],
        ["excel", excel],
        ["config", JSON.stringify({ default_mode: "OVERWRITE" })],
      ]),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-2", "FAILED", "bad header row");
  });

  it("502 Apple resolve failure: closes FAILED with the Apple error message", async () => {
    requireIapSession.mockResolvedValue(session);
    getActiveAccount.mockRejectedValue(new Error("no active ASC account"));
    const excel = new File(["x"], "a.xlsx");
    const res = await POST(
      buildRequest([
        ["hub_run_id", "run-3"],
        ["excel", excel],
        ["config", JSON.stringify({ default_mode: "OVERWRITE" })],
      ]),
      ctx,
    );
    expect(res.status).toBe(502);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-3",
      "FAILED",
      "no active ASC account",
    );
  });
});
