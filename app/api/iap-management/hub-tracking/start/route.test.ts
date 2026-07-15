import { describe, it, expect, vi, beforeEach } from "vitest";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/auth")>(
    "@/lib/iap-management/auth",
  );
  return { ...actual, requireIapSession };
});

const startBulkImportTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/hub-tracking/tracking", () => ({ startBulkImportTracking }));

import { POST } from "./route";
import { IapUnauthorizedError } from "@/lib/iap-management/auth";

beforeEach(() => {
  requireIapSession.mockReset();
  startBulkImportTracking.mockReset();
});

describe("POST /api/iap-management/hub-tracking/start", () => {
  it("401 when unauthenticated — never calls startBulkImportTracking", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError());
    const res = await POST();
    expect(res.status).toBe(401);
    expect(startBulkImportTracking).not.toHaveBeenCalled();
  });

  it("returns { run_id } from startBulkImportTracking, actor from the session email", async () => {
    requireIapSession.mockResolvedValue({ user: { email: "a@b.com", role: "member" } });
    startBulkImportTracking.mockResolvedValue("run-123");
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ run_id: "run-123" });
    expect(startBulkImportTracking).toHaveBeenCalledWith("a@b.com");
  });

  it("returns { run_id: null } when tracking is unconfigured/disabled or the Hub call fails", async () => {
    requireIapSession.mockResolvedValue({ user: { email: "a@b.com", role: "member" } });
    startBulkImportTracking.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ run_id: null });
  });
});
