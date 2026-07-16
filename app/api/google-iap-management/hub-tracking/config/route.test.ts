import { describe, it, expect, vi, beforeEach } from "vitest";

const requireGoogleIapAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-iap-management/auth")>(
    "@/lib/google-iap-management/auth",
  );
  return { ...actual, requireGoogleIapAdmin };
});

const getHubTrackingConfigPublic = vi.hoisted(() => vi.fn());
const saveHubTrackingConfig = vi.hoisted(() => vi.fn());
const resolveTokenForValidation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/hub-tracking/config", () => ({
  getHubTrackingConfigPublic,
  saveHubTrackingConfig,
  resolveTokenForValidation,
}));

const hubValidateCredentials = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/hub-tracking/hub-client", () => ({ hubValidateCredentials }));

import { GET, POST } from "./route";
import { GoogleIapForbiddenError, GoogleIapUnauthorizedError } from "@/lib/google-iap-management/auth";

const adminSession = { user: { email: "admin@b.com", role: "admin" } };

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireGoogleIapAdmin.mockReset();
  getHubTrackingConfigPublic.mockReset();
  saveHubTrackingConfig.mockReset();
  resolveTokenForValidation.mockReset();
  hubValidateCredentials.mockReset();
  getHubTrackingConfigPublic.mockResolvedValue({
    workflow_id: "wf",
    configured: true,
    enabled: true,
    updated_at: "2026-07-01T00:00:00.000Z",
  });
  saveHubTrackingConfig.mockResolvedValue(undefined);
});

describe("GET /api/google-iap-management/hub-tracking/config", () => {
  it("401 when unauthenticated", async () => {
    requireGoogleIapAdmin.mockRejectedValue(new GoogleIapUnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("403 when authenticated but not admin", async () => {
    requireGoogleIapAdmin.mockRejectedValue(new GoogleIapForbiddenError());
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("200 with the public config shape (never a token field) for an admin", async () => {
    requireGoogleIapAdmin.mockResolvedValue(adminSession);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      workflow_id: "wf",
      configured: true,
      enabled: true,
      updated_at: "2026-07-01T00:00:00.000Z",
    });
  });
});

describe("POST /api/google-iap-management/hub-tracking/config — save-time validation never blocks save", () => {
  beforeEach(() => {
    requireGoogleIapAdmin.mockResolvedValue(adminSession);
  });

  it("400 when workflow_id is missing — save never attempted", async () => {
    const res = await POST(postReq({ token: "tok", enabled: true }));
    expect(res.status).toBe(400);
    expect(saveHubTrackingConfig).not.toHaveBeenCalled();
  });

  it("rejected credentials (422-style) still save — response surfaces reason:rejected", async () => {
    resolveTokenForValidation.mockResolvedValue("tok");
    hubValidateCredentials.mockResolvedValue({ ok: false, reason: "rejected", detail: "unregistered" });
    const res = await POST(postReq({ workflow_id: "bad-wf", token: "tok", enabled: true }));
    expect(res.status).toBe(200);
    expect(saveHubTrackingConfig).toHaveBeenCalledWith({
      workflowId: "bad-wf",
      token: "tok",
      enabled: true,
      updatedBy: "admin@b.com",
    });
    const body = await res.json();
    expect(body.validation).toEqual({ ok: false, reason: "rejected", detail: "unregistered" });
  });

  it("a network/timeout failure during validation still saves — reason:network-error, never blocks", async () => {
    resolveTokenForValidation.mockResolvedValue("tok");
    hubValidateCredentials.mockResolvedValue({ ok: false, reason: "network-error", detail: "ETIMEDOUT" });
    const res = await POST(postReq({ workflow_id: "wf", token: "tok", enabled: true }));
    expect(res.status).toBe(200);
    expect(saveHubTrackingConfig).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.validation).toEqual({ ok: false, reason: "network-error", detail: "ETIMEDOUT" });
  });

  it("hubValidateCredentials throwing outright is treated as network-error and still saves", async () => {
    resolveTokenForValidation.mockResolvedValue("tok");
    hubValidateCredentials.mockRejectedValue(new Error("boom"));
    const res = await POST(postReq({ workflow_id: "wf", token: "tok", enabled: true }));
    expect(res.status).toBe(200);
    expect(saveHubTrackingConfig).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.validation).toEqual({ ok: false, reason: "network-error" });
  });

  it("valid credentials save with validation.ok true", async () => {
    resolveTokenForValidation.mockResolvedValue("tok");
    hubValidateCredentials.mockResolvedValue({ ok: true });
    const res = await POST(postReq({ workflow_id: "wf", token: "tok", enabled: true }));
    const body = await res.json();
    expect(body.validation).toEqual({ ok: true });
  });

  it("skips validation entirely when there's no token to validate (blank submit, nothing stored)", async () => {
    resolveTokenForValidation.mockResolvedValue(null);
    const res = await POST(postReq({ workflow_id: "wf", enabled: true }));
    expect(hubValidateCredentials).not.toHaveBeenCalled();
    expect(saveHubTrackingConfig).toHaveBeenCalledWith({
      workflowId: "wf",
      token: undefined,
      enabled: true,
      updatedBy: "admin@b.com",
    });
    const body = await res.json();
    expect(body.validation).toEqual({ ok: true });
  });

  it("400 when saveHubTrackingConfig rejects (e.g. first-time save without a token)", async () => {
    resolveTokenForValidation.mockResolvedValue(null);
    saveHubTrackingConfig.mockRejectedValue(new Error("Token is required when configuring Hub tracking for the first time."));
    const res = await POST(postReq({ workflow_id: "wf", enabled: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Token is required/);
  });
});
