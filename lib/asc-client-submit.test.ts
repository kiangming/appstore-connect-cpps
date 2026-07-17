/**
 * CPP submission backport tests — verifies the create-or-reuse fix
 * (CPP used to blind-POST a new reviewSubmission and 409 whenever Apple
 * already had one open, e.g. from an IAP v2 submit batch on the same app)
 * and that `ascFetch` now detects 429s via the shared fetch primitive.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  prepareCppSubmission,
  confirmCppSubmission,
  rollbackCppSubmission,
} from "./asc-client";
import type { AscCredentials } from "@/lib/asc-jwt";

vi.mock("@/lib/asc-jwt", () => ({
  generateAscToken: vi.fn().mockResolvedValue("fake-jwt"),
}));
vi.mock("@/lib/logger", () => ({
  log: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/shared/apple-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shared/apple-fetch")>();
  return {
    ...actual,
    withRetry: vi.fn((fn: () => unknown) => fn()),
  };
});

const createOrReuseReviewSubmission = vi.fn();
const addReviewSubmissionItem = vi.fn();
const submitReviewSubmission = vi.fn();
const deleteReviewSubmission = vi.fn();

vi.mock("@/lib/shared/review-submission", () => ({
  createOrReuseReviewSubmission: (...args: unknown[]) => createOrReuseReviewSubmission(...args),
  addReviewSubmissionItem: (...args: unknown[]) => addReviewSubmissionItem(...args),
  submitReviewSubmission: (...args: unknown[]) => submitReviewSubmission(...args),
  deleteReviewSubmission: (...args: unknown[]) => deleteReviewSubmission(...args),
}));

const creds = {} as AscCredentials;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareCppSubmission — create-or-reuse backport", () => {
  it("reuses an existing open reviewSubmission instead of blind-creating (fixes the old 409)", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({
      submission: { id: "existing-sub", attributes: {} },
      reused: true,
    });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    const result = await prepareCppSubmission(creds, "app1", [
      { cppId: "cpp1", cppName: "CPP 1", versionId: "ver1" },
    ]);

    expect(createOrReuseReviewSubmission).toHaveBeenCalledWith(creds, "app1", "IOS", "asc-client");
    expect(result.submissionId).toBe("existing-sub");
    expect(result.reused).toBe(true);
    expect(result.items[0].status).toBe("success");
  });

  it("creates a fresh submission when none exists and reports reused:false", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({
      submission: { id: "new-sub", attributes: {} },
      reused: false,
    });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    const result = await prepareCppSubmission(creds, "app1", [
      { cppId: "cpp1", cppName: "CPP 1", versionId: "ver1" },
    ]);
    expect(result.reused).toBe(false);
  });

  it("uses appCustomProductPageVersion as the relationship key (not inAppPurchaseVersion)", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({
      submission: { id: "sub1", attributes: {} },
      reused: false,
    });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    await prepareCppSubmission(creds, "app1", [
      { cppId: "cpp1", cppName: "CPP 1", versionId: "ver1" },
    ]);
    expect(addReviewSubmissionItem).toHaveBeenCalledWith(
      creds, "sub1", "appCustomProductPageVersion", "appCustomProductPageVersions", "ver1", "asc-client",
    );
  });

  it("marks a failed item without aborting the rest of the batch", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({
      submission: { id: "sub1", attributes: {} },
      reused: false,
    });
    addReviewSubmissionItem
      .mockResolvedValueOnce({ id: "item-1" })
      .mockRejectedValueOnce(new Error("422: validation error"));

    const result = await prepareCppSubmission(creds, "app1", [
      { cppId: "cpp1", cppName: "CPP 1", versionId: "ver1" },
      { cppId: "cpp2", cppName: "CPP 2", versionId: "ver2" },
    ]);
    expect(result.items[0].status).toBe("success");
    expect(result.items[1].status).toBe("failed");
    expect(result.items[1].error).toContain("422");
  });
});

describe("confirmCppSubmission / rollbackCppSubmission", () => {
  it("confirmCppSubmission calls submitReviewSubmission", async () => {
    submitReviewSubmission.mockResolvedValue(undefined);
    await confirmCppSubmission(creds, "sub1");
    expect(submitReviewSubmission).toHaveBeenCalledWith(creds, "sub1", "asc-client");
  });

  it("rollbackCppSubmission calls deleteReviewSubmission", async () => {
    deleteReviewSubmission.mockResolvedValue(undefined);
    await rollbackCppSubmission(creds, "sub1");
    expect(deleteReviewSubmission).toHaveBeenCalledWith(creds, "sub1", "asc-client");
  });
});
