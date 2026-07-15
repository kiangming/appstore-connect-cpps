import { describe, it, expect, vi, beforeEach } from "vitest";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/auth")>(
    "@/lib/iap-management/auth",
  );
  return { ...actual, requireIapSession };
});

const finalizeHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/hub-tracking/tracking", () => ({ finalizeHubTracking }));

import { POST } from "./route";
import { IapUnauthorizedError } from "@/lib/iap-management/auth";

function req(body: string): Request {
  return new Request("http://localhost/api/x", { method: "POST", body });
}

beforeEach(() => {
  requireIapSession.mockReset();
  finalizeHubTracking.mockReset();
  requireIapSession.mockResolvedValue({ user: { email: "a@b.com", role: "member" } });
});

describe("POST /api/iap-management/hub-tracking/cancel", () => {
  it("401 when unauthenticated", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError());
    const res = await POST(req(JSON.stringify({ run_id: "run-1" })));
    expect(res.status).toBe(401);
    expect(finalizeHubTracking).not.toHaveBeenCalled();
  });

  it("closes the run CANCELLED when run_id is present", async () => {
    const res = await POST(req(JSON.stringify({ run_id: "run-1" })));
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-1", "CANCELLED");
  });

  it("no-ops (still 200) on a malformed body — mirrors a best-effort sendBeacon payload", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "CANCELLED");
  });

  it("no-ops when run_id is missing from an otherwise-valid JSON body", async () => {
    const res = await POST(req(JSON.stringify({})));
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "CANCELLED");
  });
});
