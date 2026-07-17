/**
 * Tests for the IAP v2 submit orchestration (reviewSubmissions-based),
 * covering the build's core acceptance criteria:
 *   - version-read path: reads existing version, doesn't create in the
 *     common path; fallback create only when absent, logged + flagged as
 *     an orphan risk if the subsequent add then fails.
 *   - checkForConflict is read-only (Decision A) and correctly classifies
 *     clear vs conflict.
 *   - rollback never deletes a REUSED submission.
 *
 * `withRetry` is mocked to call straight through (pass-through) — its own
 * retry/backoff behavior is covered by lib/shared/apple-fetch.test.ts;
 * these tests focus on orchestration logic, not retry timing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkForConflict,
  executeSubmitV2,
  confirmSubmitV2,
  rollbackOrLeaveSubmitV2,
} from "./submit-v2";
import type { AscCredentials } from "@/lib/asc-jwt";

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

const findOpenReviewSubmission = vi.fn();
const createOrReuseReviewSubmission = vi.fn();
const getReviewSubmissionItems = vi.fn();
const addReviewSubmissionItem = vi.fn();
const submitReviewSubmission = vi.fn();
const deleteReviewSubmission = vi.fn();
const summarizeForeignItems = vi.fn();

vi.mock("@/lib/shared/review-submission", () => ({
  findOpenReviewSubmission: (...args: unknown[]) => findOpenReviewSubmission(...args),
  createOrReuseReviewSubmission: (...args: unknown[]) => createOrReuseReviewSubmission(...args),
  getReviewSubmissionItems: (...args: unknown[]) => getReviewSubmissionItems(...args),
  addReviewSubmissionItem: (...args: unknown[]) => addReviewSubmissionItem(...args),
  submitReviewSubmission: (...args: unknown[]) => submitReviewSubmission(...args),
  deleteReviewSubmission: (...args: unknown[]) => deleteReviewSubmission(...args),
  summarizeForeignItems: (...args: unknown[]) => summarizeForeignItems(...args),
}));

const listInAppPurchaseVersions = vi.fn();
const createInAppPurchaseVersion = vi.fn();

vi.mock("./client", () => ({
  listInAppPurchaseVersions: (...args: unknown[]) => listInAppPurchaseVersions(...args),
  createInAppPurchaseVersion: (...args: unknown[]) => createInAppPurchaseVersion(...args),
}));

const creds = {} as AscCredentials;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkForConflict — Decision A, read-only", () => {
  it("returns clear-no-existing when the app has no open submission (zero writes)", async () => {
    findOpenReviewSubmission.mockResolvedValue(null);
    const result = await checkForConflict(creds, "app1");
    expect(result).toEqual({ kind: "clear-no-existing" });
    expect(getReviewSubmissionItems).not.toHaveBeenCalled();
    expect(addReviewSubmissionItem).not.toHaveBeenCalled();
    expect(createOrReuseReviewSubmission).not.toHaveBeenCalled();
  });

  it("returns clear-reuse when the existing submission is empty", async () => {
    findOpenReviewSubmission.mockResolvedValue({ id: "sub1" });
    getReviewSubmissionItems.mockResolvedValue([]);
    summarizeForeignItems.mockReturnValue({ count: 0, byKind: {}, typesKnown: true });
    const result = await checkForConflict(creds, "app1");
    expect(result).toEqual({ kind: "clear-reuse", reviewSubmissionId: "sub1" });
  });

  it("returns conflict when the existing submission has foreign items", async () => {
    findOpenReviewSubmission.mockResolvedValue({ id: "sub1" });
    getReviewSubmissionItems.mockResolvedValue([{ id: "item1" }]);
    const foreignSummary = {
      count: 3,
      byKind: { appCustomProductPageVersion: 3 },
      typesKnown: true,
    };
    summarizeForeignItems.mockReturnValue(foreignSummary);
    const result = await checkForConflict(creds, "app1");
    expect(result).toEqual({
      kind: "conflict",
      reviewSubmissionId: "sub1",
      foreignItemsSummary: foreignSummary,
    });
  });

  it("never calls any write function (addReviewSubmissionItem, submitReviewSubmission, createOrReuse)", async () => {
    findOpenReviewSubmission.mockResolvedValue({ id: "sub1" });
    getReviewSubmissionItems.mockResolvedValue([{ id: "item1" }]);
    summarizeForeignItems.mockReturnValue({ count: 1, byKind: { unknown: 1 }, typesKnown: false });
    await checkForConflict(creds, "app1");
    expect(addReviewSubmissionItem).not.toHaveBeenCalled();
    expect(submitReviewSubmission).not.toHaveBeenCalled();
    expect(createOrReuseReviewSubmission).not.toHaveBeenCalled();
  });
});

describe("executeSubmitV2 — version resolution", () => {
  const items = [{ iapId: "iap-1", appleIapId: "apple-1", productId: "prod.1" }];

  it("reads the existing PREPARE_FOR_SUBMISSION version and does NOT create one", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({
      submission: { id: "sub1" },
      reused: false,
    });
    listInAppPurchaseVersions.mockResolvedValue({
      data: [{ id: "ver-1", attributes: { state: "PREPARE_FOR_SUBMISSION", version: 1 } }],
    });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    const result = await executeSubmitV2(creds, "app1", items);

    expect(createInAppPurchaseVersion).not.toHaveBeenCalled();
    expect(addReviewSubmissionItem).toHaveBeenCalledWith(
      creds, "sub1", "inAppPurchaseVersion", "inAppPurchaseVersions", "ver-1", "iap-submit-v2",
    );
    expect(result.items[0]).toMatchObject({ status: "SUCCESS", usedFallbackVersionCreate: false });
  });

  it("also accepts READY_FOR_REVIEW as a submittable existing version", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({ submission: { id: "sub1" }, reused: false });
    listInAppPurchaseVersions.mockResolvedValue({
      data: [{ id: "ver-2", attributes: { state: "READY_FOR_REVIEW", version: 2 } }],
    });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    await executeSubmitV2(creds, "app1", items);
    expect(createInAppPurchaseVersion).not.toHaveBeenCalled();
    expect(addReviewSubmissionItem).toHaveBeenCalledWith(
      creds, "sub1", "inAppPurchaseVersion", "inAppPurchaseVersions", "ver-2", "iap-submit-v2",
    );
  });

  it("falls back to creating a version only when none exists (rare defensive path)", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({ submission: { id: "sub1" }, reused: false });
    listInAppPurchaseVersions.mockResolvedValue({ data: [] });
    createInAppPurchaseVersion.mockResolvedValue({ data: { id: "fallback-ver" } });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    const result = await executeSubmitV2(creds, "app1", items);
    expect(createInAppPurchaseVersion).toHaveBeenCalledWith(creds, "apple-1");
    expect(result.items[0]).toMatchObject({ status: "SUCCESS", usedFallbackVersionCreate: true });

    const { log } = await import("@/lib/logger");
    expect(log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "iap-submit-v2",
      expect.stringContaining("created fallback version"),
      "WARN",
    );
  });

  it("ignores an APPROVED/REJECTED version — only PREPARE_FOR_SUBMISSION/READY_FOR_REVIEW count as submittable", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({ submission: { id: "sub1" }, reused: false });
    listInAppPurchaseVersions.mockResolvedValue({
      data: [{ id: "old-ver", attributes: { state: "APPROVED", version: 1 } }],
    });
    createInAppPurchaseVersion.mockResolvedValue({ data: { id: "fallback-ver" } });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-1" });

    await executeSubmitV2(creds, "app1", items);
    expect(createInAppPurchaseVersion).toHaveBeenCalled();
  });

  it("surfaces an orphan warning when a fallback-created version's item-add then fails", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({ submission: { id: "sub1" }, reused: false });
    listInAppPurchaseVersions.mockResolvedValue({ data: [] });
    createInAppPurchaseVersion.mockResolvedValue({ data: { id: "fallback-ver" } });
    addReviewSubmissionItem.mockRejectedValue(new Error("429: rate limited"));

    const result = await executeSubmitV2(creds, "app1", items);
    expect(result.items[0].status).toBe("ERROR");
    expect(result.items[0].orphanedVersionWarning).toBe(true);
    expect(result.items[0].error).toContain("cannot be auto-removed");
  });

  it("does NOT flag orphanedVersionWarning when the version already existed and the add fails", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({ submission: { id: "sub1" }, reused: false });
    listInAppPurchaseVersions.mockResolvedValue({
      data: [{ id: "ver-1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }],
    });
    addReviewSubmissionItem.mockRejectedValue(new Error("422: validation error"));

    const result = await executeSubmitV2(creds, "app1", items);
    expect(result.items[0].status).toBe("ERROR");
    expect(result.items[0].orphanedVersionWarning).toBe(false);
    expect(result.items[0].error).not.toContain("cannot be auto-removed");
  });

  it("processes multiple items sequentially and reports reused/reviewSubmissionId from create-or-reuse", async () => {
    createOrReuseReviewSubmission.mockResolvedValue({ submission: { id: "sub-shared" }, reused: true });
    listInAppPurchaseVersions.mockResolvedValue({
      data: [{ id: "ver-x", attributes: { state: "PREPARE_FOR_SUBMISSION" } }],
    });
    addReviewSubmissionItem.mockResolvedValue({ id: "item-x" });

    const twoItems = [
      { iapId: "iap-1", appleIapId: "apple-1", productId: "p1" },
      { iapId: "iap-2", appleIapId: "apple-2", productId: "p2" },
    ];
    const result = await executeSubmitV2(creds, "app1", twoItems);
    expect(result.reviewSubmissionId).toBe("sub-shared");
    expect(result.reused).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.status === "SUCCESS")).toBe(true);
  });
});

describe("confirmSubmitV2", () => {
  it("submits the reviewSubmission via PATCH submitted:true", async () => {
    submitReviewSubmission.mockResolvedValue(undefined);
    await confirmSubmitV2(creds, "sub1");
    expect(submitReviewSubmission).toHaveBeenCalledWith(creds, "sub1", "iap-submit-v2");
  });
});

describe("rollbackOrLeaveSubmitV2 — never deletes a shared/reused submission", () => {
  it("deletes a freshly-created submission (safe — contains only this flow's items)", async () => {
    deleteReviewSubmission.mockResolvedValue(undefined);
    const result = await rollbackOrLeaveSubmitV2(creds, "sub1", false);
    expect(result.deleted).toBe(true);
    expect(deleteReviewSubmission).toHaveBeenCalledWith(creds, "sub1", "iap-submit-v2");
  });

  it("does NOT delete a reused submission — leaves it in place", async () => {
    const result = await rollbackOrLeaveSubmitV2(creds, "sub1", true);
    expect(result.deleted).toBe(false);
    expect(deleteReviewSubmission).not.toHaveBeenCalled();
  });
});
