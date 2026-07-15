import { describe, it, expect, vi, beforeEach } from "vitest";

const getHubTrackingGate = vi.hoisted(() => vi.fn());
vi.mock("./config", () => ({ getHubTrackingGate }));

const hubStartRun = vi.hoisted(() => vi.fn());
const hubCloseRun = vi.hoisted(() => vi.fn());
vi.mock("./hub-client", () => ({ hubStartRun, hubCloseRun }));

const log = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ log }));

import { startBulkImportTracking, finalizeHubTracking } from "./tracking";

function gate(overrides: {
  configured?: boolean;
  enabled?: boolean;
  credentials?: { workflowId: string; token: string } | null;
} = {}) {
  return {
    configured: overrides.configured ?? false,
    enabled: overrides.enabled ?? false,
    credentials: overrides.credentials ?? null,
  };
}

beforeEach(() => {
  getHubTrackingGate.mockReset();
  hubStartRun.mockReset();
  hubCloseRun.mockReset();
  log.mockReset();
});

function loggedMessages(): string[] {
  return log.mock.calls.map((c) => String(c[1]));
}

describe("startBulkImportTracking", () => {
  it("returns null and never calls hubStartRun when unconfigured", async () => {
    getHubTrackingGate.mockResolvedValue(gate({ configured: false, enabled: false }));
    const result = await startBulkImportTracking("a@b.com");
    expect(result).toBeNull();
    expect(hubStartRun).not.toHaveBeenCalled();
  });

  it("returns null and never calls hubStartRun when configured but disabled", async () => {
    getHubTrackingGate.mockResolvedValue(gate({ configured: true, enabled: false }));
    const result = await startBulkImportTracking("a@b.com");
    expect(result).toBeNull();
    expect(hubStartRun).not.toHaveBeenCalled();
  });

  it("calls hubStartRun with the stored creds + actor and returns its result", async () => {
    getHubTrackingGate.mockResolvedValue(
      gate({ configured: true, enabled: true, credentials: { workflowId: "wf", token: "tok" } }),
    );
    hubStartRun.mockResolvedValue("run-123");
    const result = await startBulkImportTracking("a@b.com");
    expect(result).toBe("run-123");
    expect(hubStartRun).toHaveBeenCalledWith({ workflowId: "wf", token: "tok", actor: "a@b.com" });
  });

  it("passes actor as undefined when not given (session email missing)", async () => {
    getHubTrackingGate.mockResolvedValue(
      gate({ configured: true, enabled: true, credentials: { workflowId: "wf", token: "tok" } }),
    );
    hubStartRun.mockResolvedValue("run-123");
    await startBulkImportTracking(null);
    expect(hubStartRun).toHaveBeenCalledWith({ workflowId: "wf", token: "tok", actor: undefined });
  });

  it("returns null (never throws) when the config read fails", async () => {
    getHubTrackingGate.mockRejectedValue(new Error("db down"));
    await expect(startBulkImportTracking("a@b.com")).resolves.toBeNull();
    expect(hubStartRun).not.toHaveBeenCalled();
  });
});

describe("finalizeHubTracking", () => {
  it("no-ops (no config read, no Hub call) when runId is null", async () => {
    await finalizeHubTracking(null, "SUCCESS");
    expect(getHubTrackingGate).not.toHaveBeenCalled();
    expect(hubCloseRun).not.toHaveBeenCalled();
  });

  it("closes the run with the stored creds when runId + config are present", async () => {
    getHubTrackingGate.mockResolvedValue(
      gate({ configured: true, enabled: true, credentials: { workflowId: "wf", token: "tok" } }),
    );
    await finalizeHubTracking("run-1", "PARTIAL", "2/5 rows failed");
    expect(hubCloseRun).toHaveBeenCalledWith({
      token: "tok",
      runId: "run-1",
      status: "PARTIAL",
      errorMessage: "2/5 rows failed",
    });
  });

  it("skips the Hub call when config is now unavailable/disabled (can't authenticate)", async () => {
    getHubTrackingGate.mockResolvedValue(gate({ configured: false, enabled: false }));
    await finalizeHubTracking("run-1", "SUCCESS");
    expect(hubCloseRun).not.toHaveBeenCalled();
  });

  it("never throws when the config read fails on finalize", async () => {
    getHubTrackingGate.mockRejectedValue(new Error("db down"));
    await expect(finalizeHubTracking("run-1", "FAILED", "boom")).resolves.toBeUndefined();
    expect(hubCloseRun).not.toHaveBeenCalled();
  });
});

describe("Railway GATE logging — [hub-tracking] SKIP vs PROCEEDING", () => {
  it("start: logs SKIP (no-op) with enabled/configured when unconfigured", async () => {
    getHubTrackingGate.mockResolvedValue(gate({ configured: false, enabled: false }));
    await startBulkImportTracking("a@b.com");
    expect(loggedMessages()).toEqual([
      "[hub-tracking] start: enabled=false configured=false → SKIP (no-op)",
    ]);
  });

  it("start: logs SKIP (no-op) with enabled=false configured=true when disabled", async () => {
    getHubTrackingGate.mockResolvedValue(gate({ configured: true, enabled: false }));
    await startBulkImportTracking("a@b.com");
    expect(loggedMessages()).toEqual([
      "[hub-tracking] start: enabled=false configured=true → SKIP (no-op)",
    ]);
  });

  it("start: logs PROCEEDING with workflow_id when configured + enabled — never the token", async () => {
    getHubTrackingGate.mockResolvedValue(
      gate({ configured: true, enabled: true, credentials: { workflowId: "wf-log", token: "shh-secret" } }),
    );
    hubStartRun.mockResolvedValue("run-1");
    await startBulkImportTracking("a@b.com");
    const messages = loggedMessages();
    expect(messages).toEqual([
      "[hub-tracking] start: enabled=true configured=true → PROCEEDING workflow_id=wf-log",
    ]);
    expect(messages.join("\n")).not.toContain("shh-secret");
  });

  it("finalize: logs SKIP (no run_id) when runId is null", async () => {
    await finalizeHubTracking(null, "SUCCESS");
    expect(loggedMessages()).toEqual(["[hub-tracking] finalize: status=SUCCESS → SKIP (no run_id)"]);
  });

  it("finalize: logs SKIP (config unavailable/disabled) with the gate booleans when creds are gone", async () => {
    getHubTrackingGate.mockResolvedValue(gate({ configured: true, enabled: false }));
    await finalizeHubTracking("run-1", "FAILED", "boom");
    expect(loggedMessages()).toEqual([
      "[hub-tracking] finalize: run_id=run-1 status=FAILED enabled=false configured=true → SKIP (config unavailable/disabled)",
    ]);
  });
});
