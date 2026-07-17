/**
 * submit-tracking.ts is a thin ATTEMPT/OUTCOME logging wrapper over the
 * EXISTING Bulk Import tracking orchestration (./tracking.ts), reused as-is
 * per the design doc's Q1 decision. These tests prove: (a) it delegates
 * correctly, (b) it logs under its own distinct feature tag
 * ("iap-submit-hub-tracking") so Submit and Bulk Import stay separable in
 * Railway even though they share one Hub workflow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const startBulkImportTracking = vi.hoisted(() => vi.fn());
const finalizeHubTracking = vi.hoisted(() => vi.fn());
vi.mock("./tracking", () => ({ startBulkImportTracking, finalizeHubTracking }));

vi.mock("@/lib/logger", () => ({ log: vi.fn().mockResolvedValue(undefined) }));

import { startSubmitHubTracking, finalizeSubmitHubTracking } from "./submit-tracking";

beforeEach(async () => {
  startBulkImportTracking.mockReset();
  finalizeHubTracking.mockReset();
  const { log } = await import("@/lib/logger");
  (log as ReturnType<typeof vi.fn>).mockClear();
});

describe("startSubmitHubTracking", () => {
  it("delegates to the existing startBulkImportTracking with the actor email", async () => {
    startBulkImportTracking.mockResolvedValue("run-123");
    const runId = await startSubmitHubTracking("manager@vng.com.vn");
    expect(startBulkImportTracking).toHaveBeenCalledWith("manager@vng.com.vn");
    expect(runId).toBe("run-123");
  });

  it("logs under the distinct 'iap-submit-hub-tracking' tag", async () => {
    startBulkImportTracking.mockResolvedValue("run-123");
    const { log } = await import("@/lib/logger");
    await startSubmitHubTracking("a@b.com");
    const tags = (log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tags).toEqual(["iap-submit-hub-tracking", "iap-submit-hub-tracking"]);
  });

  it("returns null (no-op) when the underlying tracking returns null", async () => {
    startBulkImportTracking.mockResolvedValue(null);
    const runId = await startSubmitHubTracking("a@b.com");
    expect(runId).toBeNull();
  });
});

describe("finalizeSubmitHubTracking", () => {
  it("delegates to the existing finalizeHubTracking with status + errorMessage", async () => {
    await finalizeSubmitHubTracking("run-1", "PARTIAL", "1/2 items added");
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-1", "PARTIAL", "1/2 items added");
  });

  it("logs under the distinct tag even when runId is null (no-op case)", async () => {
    const { log } = await import("@/lib/logger");
    await finalizeSubmitHubTracking(null, "CANCELLED");
    const tags = (log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tags.every((t) => t === "iap-submit-hub-tracking")).toBe(true);
  });
});
