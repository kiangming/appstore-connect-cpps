/**
 * Hub-tracking wiring tests for the IAP submit-batch route — the
 * multi-request finalize design (docs/iap-management/design-iap-submit-hub-tracking.md).
 *
 * NOT a re-test of the underlying submit business logic (bucketing,
 * state-guard, the reviewSubmissions v2 mechanics) — those are covered by
 * their own existing unit tests (bucket.test.ts, submit-v2.test.ts). These
 * tests prove the load-bearing tracking guarantees:
 *   - start fires once per real commit attempt (not on a confirmConflict resume)
 *   - status is computed from review-reaching outcome, not per-item add labels
 *   - SKIPPED_BY_STATE_GUARD rows never count toward succeeded/failed
 *   - the conflict/partial-fail branches leave the run RUNNING (no finalize)
 *   - every other exit (including an unhandled exception) finalizes exactly once
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

const listInAppPurchases = vi.hoisted(() => vi.fn());
const submitInAppPurchase = vi.hoisted(() => vi.fn());
const getInAppPurchase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/client", () => ({
  listInAppPurchases,
  submitInAppPurchase,
  getInAppPurchase,
}));

vi.mock("@/lib/iap-management/apple/fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/apple/fetch")>(
    "@/lib/iap-management/apple/fetch",
  );
  return { ...actual, withRetry: (fn: () => unknown) => fn() };
});

const v2ToggleDecision = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/submit-v2-toggle", () => ({ v2ToggleDecision }));

const checkForConflict = vi.hoisted(() => vi.fn());
const executeSubmitV2 = vi.hoisted(() => vi.fn());
const confirmSubmitV2 = vi.hoisted(() => vi.fn());
const rollbackOrLeaveSubmitV2 = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/submit-v2", () => ({
  checkForConflict,
  executeSubmitV2,
  confirmSubmitV2,
  rollbackOrLeaveSubmitV2,
}));

const startSubmitHubTracking = vi.hoisted(() => vi.fn());
const finalizeSubmitHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/hub-tracking/submit-tracking", () => ({
  startSubmitHubTracking,
  finalizeSubmitHubTracking,
}));

vi.mock("@/lib/logger", () => ({ log: vi.fn().mockResolvedValue(undefined) }));

// Generic chainable Supabase-query stub — every method returns `this`;
// awaiting the chain resolves the configured result. Mirrors
// lib/iap-management/queries/templates.test.ts's own convention.
function chainable(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.update = chain;
  b.insert = chain;
  b.eq = chain;
  b.in = chain;
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return b;
}

let localRowsResult: { data: unknown; error: unknown } = { data: [], error: null };
const iapDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb }));

import { POST } from "./route";
import { IapUnauthorizedError } from "@/lib/iap-management/auth";

const ctx = { params: { appId: "999" } };
const session = { user: { email: "a@b.com", role: "member" } };

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/iap-management/apps/999/iaps/submit-batch", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function localRow(id: string, appleIapId: string) {
  return { id, apple_iap_id: appleIapId, product_id: `com.x.${id}`, reference_name: id };
}

beforeEach(() => {
  requireIapSession.mockReset().mockResolvedValue(session);
  getActiveAccount.mockReset().mockResolvedValue({});
  listInAppPurchases.mockReset();
  submitInAppPurchase.mockReset();
  getInAppPurchase.mockReset();
  v2ToggleDecision.mockReset();
  checkForConflict.mockReset();
  executeSubmitV2.mockReset();
  confirmSubmitV2.mockReset();
  rollbackOrLeaveSubmitV2.mockReset();
  startSubmitHubTracking.mockReset().mockResolvedValue("run-1");
  finalizeSubmitHubTracking.mockReset().mockResolvedValue(undefined);
  localRowsResult = { data: [], error: null };
  iapDb.mockReset().mockImplementation(() => ({
    from: (table: string) => (table === "iaps" ? chainable(localRowsResult) : chainable()),
  }));
});

function readyAppleState(ids: string[]) {
  return {
    data: ids.map((id) => ({ id, attributes: { state: "READY_TO_SUBMIT" } })),
  };
}

describe("submit-batch — start timing", () => {
  it("does NOT call startSubmitHubTracking on preflight (execute:false) — no run exists while viewing preflight", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: false }), ctx);

    expect(startSubmitHubTracking).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).not.toHaveBeenCalled();
  });

  it("starts a run on the first execute:true POST (before confirmConflict exists)", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
    v2ToggleDecision.mockReturnValue({ enabled: false, reason: "allowlist empty" });
    submitInAppPurchase.mockResolvedValue(undefined);
    getInAppPurchase.mockResolvedValue({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(startSubmitHubTracking).toHaveBeenCalledTimes(1);
    expect(startSubmitHubTracking).toHaveBeenCalledWith("a@b.com");
  });

  it("confirmConflict:true resumes the client-provided hub_run_id — does NOT start a new run", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
    v2ToggleDecision.mockReturnValue({ enabled: true, reason: "allowlisted" });
    executeSubmitV2.mockResolvedValue({
      reviewSubmissionId: "sub-1",
      reused: true,
      items: [{ iapId: "11111111-1111-4111-8111-111111111111", appleIapId: "apple-1", status: "SUCCESS" }],
    });
    confirmSubmitV2.mockResolvedValue(undefined);

    await POST(
      buildRequest({
        iap_ids: ["11111111-1111-4111-8111-111111111111"],
        execute: true,
        confirmConflict: true,
        hub_run_id: "run-resumed",
      }),
      ctx,
    );

    expect(startSubmitHubTracking).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-resumed", "SUCCESS");
  });
});

describe("submit-batch — legacy path status computation", () => {
  beforeEach(() => {
    v2ToggleDecision.mockReturnValue({ enabled: false, reason: "allowlist empty" });
  });

  it("all succeed → SUCCESS", async () => {
    localRowsResult = {
      data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1"), localRow("22222222-2222-4222-8222-222222222222", "apple-2")],
      error: null,
    };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1", "apple-2"]));
    submitInAppPurchase.mockResolvedValue(undefined);
    getInAppPurchase.mockResolvedValue({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"], execute: true }), ctx);

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "SUCCESS", undefined);
  });

  it("mixed (one succeeds, one fails) → PARTIAL", async () => {
    localRowsResult = {
      data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1"), localRow("22222222-2222-4222-8222-222222222222", "apple-2")],
      error: null,
    };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1", "apple-2"]));
    submitInAppPurchase.mockImplementation((_creds: unknown, appleId: string) =>
      appleId === "apple-1" ? Promise.resolve(undefined) : Promise.reject(new Error("boom")),
    );
    getInAppPurchase.mockResolvedValue({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"], execute: true }), ctx);

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "PARTIAL", undefined);
  });

  it("all fail → FAIL", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
    submitInAppPurchase.mockRejectedValue(new Error("boom"));

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith(
      "run-1",
      "FAILED",
      expect.stringContaining("1/1"),
    );
  });

  it("SKIPPED_BY_STATE_GUARD rows are excluded — one skipped + one succeeds → SUCCESS, not PARTIAL", async () => {
    localRowsResult = {
      data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1"), localRow("22222222-2222-4222-8222-222222222222", "apple-2")],
      error: null,
    };
    // apple-1 not READY_TO_SUBMIT (skipped by state guard), apple-2 is.
    listInAppPurchases.mockResolvedValue({
      data: [
        { id: "apple-1", attributes: { state: "IN_REVIEW" } },
        { id: "apple-2", attributes: { state: "READY_TO_SUBMIT" } },
      ],
    });
    submitInAppPurchase.mockResolvedValue(undefined);
    getInAppPurchase.mockResolvedValue({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"], execute: true }), ctx);

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "SUCCESS", undefined);
  });

  it("entirely-skipped batch → SUCCESS/no-op, not FAIL", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listInAppPurchases.mockResolvedValue({
      data: [{ id: "apple-1", attributes: { state: "IN_REVIEW" } }],
    });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(submitInAppPurchase).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "SUCCESS", undefined);
  });
});

describe("submit-batch — v2 path: multi-request finalize", () => {
  beforeEach(() => {
    v2ToggleDecision.mockReturnValue({ enabled: true, reason: "allowlisted" });
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
  });

  it("no conflict, all adds + confirm succeed → finalize SUCCESS, response.hub_run_id is null (terminal)", async () => {
    checkForConflict.mockResolvedValue({ kind: "clear-no-existing" });
    executeSubmitV2.mockResolvedValue({
      reviewSubmissionId: "sub-1",
      reused: false,
      items: [{ iapId: "11111111-1111-4111-8111-111111111111", appleIapId: "apple-1", status: "SUCCESS" }],
    });
    confirmSubmitV2.mockResolvedValue(undefined);

    const res = await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);
    const json = await res.json();

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "SUCCESS");
    expect(json.phase).toBe("execute");
    expect(json.hub_run_id).toBeNull();
  });

  it("conflict detected → does NOT finalize, response carries the real hub_run_id (run stays RUNNING)", async () => {
    checkForConflict.mockResolvedValue({
      kind: "conflict",
      reviewSubmissionId: "sub-1",
      foreignItemsSummary: { count: 2, byKind: { appCustomProductPageVersion: 2 }, typesKnown: true },
    });

    const res = await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);
    const json = await res.json();

    expect(finalizeSubmitHubTracking).not.toHaveBeenCalled();
    expect(json.phase).toBe("conflict");
    expect(json.hub_run_id).toBe("run-1");
    expect(executeSubmitV2).not.toHaveBeenCalled();
  });

  it("some item-adds fail → does NOT finalize, response carries the real hub_run_id (run stays RUNNING)", async () => {
    checkForConflict.mockResolvedValue({ kind: "clear-no-existing" });
    executeSubmitV2.mockResolvedValue({
      reviewSubmissionId: "sub-1",
      reused: false,
      items: [
        { iapId: "11111111-1111-4111-8111-111111111111", appleIapId: "apple-1", status: "ERROR", error: "429" },
      ],
    });

    const res = await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);
    const json = await res.json();

    expect(finalizeSubmitHubTracking).not.toHaveBeenCalled();
    expect(confirmSubmitV2).not.toHaveBeenCalled();
    expect(json.phase).toBe("partial-fail");
    expect(json.hub_run_id).toBe("run-1");
  });

  it("all adds succeed but confirm PATCH fails → FAIL immediately (0 reached review), response.hub_run_id is null", async () => {
    checkForConflict.mockResolvedValue({ kind: "clear-no-existing" });
    executeSubmitV2.mockResolvedValue({
      reviewSubmissionId: "sub-1",
      reused: false,
      items: [{ iapId: "11111111-1111-4111-8111-111111111111", appleIapId: "apple-1", status: "SUCCESS" }],
    });
    confirmSubmitV2.mockRejectedValue(new Error("PATCH failed"));

    const res = await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);
    const json = await res.json();

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith(
      "run-1",
      "FAILED",
      expect.stringContaining("submit PATCH failed"),
    );
    // Every item still carries status:"SUCCESS" (add succeeded) — proves
    // status must be read from the Hub finalize call, NOT from item.status.
    expect(json.phase).toBe("partial-fail");
    expect(json.items[0].status).toBe("SUCCESS");
    expect(json.hub_run_id).toBeNull();
  });

  it("entirely-skipped v2 batch → finalize SUCCESS without ever calling checkForConflict/executeSubmitV2", async () => {
    listInAppPurchases.mockResolvedValue({
      data: [{ id: "apple-1", attributes: { state: "IN_REVIEW" } }],
    });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(checkForConflict).not.toHaveBeenCalled();
    expect(executeSubmitV2).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "SUCCESS");
  });

  it("an unhandled exception still finalizes FAIL exactly once, then propagates", async () => {
    getActiveAccount.mockRejectedValue(new Error("credentials unavailable"));

    await expect(POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx)).rejects.toThrow(
      "credentials unavailable",
    );

    expect(finalizeSubmitHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith(
      "run-1",
      "FAILED",
      expect.stringContaining("credentials unavailable"),
    );
  });
});

describe("submit-batch — v2 follow-up actions (proceedPartial / rollback)", () => {
  it("proceedPartial: confirm succeeds with a genuine mix → PARTIAL", async () => {
    confirmSubmitV2.mockResolvedValue(undefined);

    const res = await POST(
      buildRequest({
        iap_ids: ["11111111-1111-4111-8111-111111111111"],
        proceedPartial: {
          reviewSubmissionId: "sub-1",
          submittedIapIds: ["11111111-1111-4111-8111-111111111111"],
          failedIapIds: ["22222222-2222-4222-8222-222222222222"],
        },
        hub_run_id: "run-partial",
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-partial", "PARTIAL", undefined);
  });

  it("proceedPartial: confirm succeeds with zero failures → SUCCESS", async () => {
    confirmSubmitV2.mockResolvedValue(undefined);

    await POST(
      buildRequest({
        iap_ids: ["11111111-1111-4111-8111-111111111111"],
        proceedPartial: {
          reviewSubmissionId: "sub-1",
          submittedIapIds: ["11111111-1111-4111-8111-111111111111"],
          failedIapIds: [],
        },
        hub_run_id: "run-retry",
      }),
      ctx,
    );

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-retry", "SUCCESS", undefined);
  });

  it("proceedPartial: confirm itself fails → FAIL", async () => {
    confirmSubmitV2.mockRejectedValue(new Error("still rate limited"));

    await POST(
      buildRequest({
        iap_ids: ["11111111-1111-4111-8111-111111111111"],
        proceedPartial: {
          reviewSubmissionId: "sub-1",
          submittedIapIds: ["11111111-1111-4111-8111-111111111111"],
          failedIapIds: ["22222222-2222-4222-8222-222222222222"],
        },
        hub_run_id: "run-fail-retry",
      }),
      ctx,
    );

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith(
      "run-fail-retry",
      "FAILED",
      expect.stringContaining("confirm failed"),
    );
  });

  it("rollback: ALWAYS finalizes FAIL (never CANCEL) with counts in the message — deleted=true case", async () => {
    rollbackOrLeaveSubmitV2.mockResolvedValue({ deleted: true });

    await POST(
      buildRequest({
        iap_ids: ["11111111-1111-4111-8111-111111111111"],
        rollback: {
          reviewSubmissionId: "sub-1",
          reused: false,
          addedIapIds: ["11111111-1111-4111-8111-111111111111"],
          failedIapIds: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
        },
        hub_run_id: "run-rollback-1",
      }),
      ctx,
    );

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith(
      "run-rollback-1",
      "FAILED",
      "1/3 items added, submit cancelled before confirming",
    );
  });

  it("rollback: still FAIL (not CANCEL) when the submission was reused and left unsubmitted (deleted=false)", async () => {
    rollbackOrLeaveSubmitV2.mockResolvedValue({ deleted: false });

    await POST(
      buildRequest({
        iap_ids: ["11111111-1111-4111-8111-111111111111"],
        rollback: {
          reviewSubmissionId: "sub-1",
          reused: true,
          addedIapIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
          failedIapIds: [],
        },
        hub_run_id: "run-rollback-2",
      }),
      ctx,
    );

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith(
      "run-rollback-2",
      "FAILED",
      "2/2 items added, submit cancelled before confirming",
    );
  });
});

describe("submit-batch — auth failure", () => {
  it("401 unauthorized never starts a Hub run", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError());

    const res = await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(res.status).toBe(401);
    expect(startSubmitHubTracking).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).not.toHaveBeenCalled();
  });
});
