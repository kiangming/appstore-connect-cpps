import { describe, it, expect, vi, beforeEach } from "vitest";

const getActiveHubTrackingCredentials = vi.hoisted(() => vi.fn());
vi.mock("./config", () => ({ getActiveHubTrackingCredentials }));

const hubStartRun = vi.hoisted(() => vi.fn());
const hubCloseRun = vi.hoisted(() => vi.fn());
vi.mock("./hub-client", () => ({ hubStartRun, hubCloseRun }));

import { startBulkImportTracking, finalizeHubTracking } from "./tracking";

beforeEach(() => {
  getActiveHubTrackingCredentials.mockReset();
  hubStartRun.mockReset();
  hubCloseRun.mockReset();
});

describe("startBulkImportTracking", () => {
  it("returns null and never calls hubStartRun when tracking is unconfigured/disabled", async () => {
    getActiveHubTrackingCredentials.mockResolvedValue(null);
    const result = await startBulkImportTracking("a@b.com");
    expect(result).toBeNull();
    expect(hubStartRun).not.toHaveBeenCalled();
  });

  it("calls hubStartRun with the stored creds + actor and returns its result", async () => {
    getActiveHubTrackingCredentials.mockResolvedValue({ workflowId: "wf", token: "tok" });
    hubStartRun.mockResolvedValue("run-123");
    const result = await startBulkImportTracking("a@b.com");
    expect(result).toBe("run-123");
    expect(hubStartRun).toHaveBeenCalledWith({ workflowId: "wf", token: "tok", actor: "a@b.com" });
  });

  it("passes actor as undefined when not given (session email missing)", async () => {
    getActiveHubTrackingCredentials.mockResolvedValue({ workflowId: "wf", token: "tok" });
    hubStartRun.mockResolvedValue("run-123");
    await startBulkImportTracking(null);
    expect(hubStartRun).toHaveBeenCalledWith({ workflowId: "wf", token: "tok", actor: undefined });
  });

  it("returns null (never throws) when the config read fails", async () => {
    getActiveHubTrackingCredentials.mockRejectedValue(new Error("db down"));
    await expect(startBulkImportTracking("a@b.com")).resolves.toBeNull();
    expect(hubStartRun).not.toHaveBeenCalled();
  });
});

describe("finalizeHubTracking", () => {
  it("no-ops (no config read, no Hub call) when runId is null", async () => {
    await finalizeHubTracking(null, "SUCCESS");
    expect(getActiveHubTrackingCredentials).not.toHaveBeenCalled();
    expect(hubCloseRun).not.toHaveBeenCalled();
  });

  it("closes the run with the stored creds when runId + config are present", async () => {
    getActiveHubTrackingCredentials.mockResolvedValue({ workflowId: "wf", token: "tok" });
    await finalizeHubTracking("run-1", "PARTIAL", "2/5 rows failed");
    expect(hubCloseRun).toHaveBeenCalledWith({
      token: "tok",
      runId: "run-1",
      status: "PARTIAL",
      errorMessage: "2/5 rows failed",
    });
  });

  it("skips the Hub call when config is now unavailable/disabled (can't authenticate)", async () => {
    getActiveHubTrackingCredentials.mockResolvedValue(null);
    await finalizeHubTracking("run-1", "SUCCESS");
    expect(hubCloseRun).not.toHaveBeenCalled();
  });

  it("never throws when the config read fails on finalize", async () => {
    getActiveHubTrackingCredentials.mockRejectedValue(new Error("db down"));
    await expect(finalizeHubTracking("run-1", "FAILED", "boom")).resolves.toBeUndefined();
    expect(hubCloseRun).not.toHaveBeenCalled();
  });
});
