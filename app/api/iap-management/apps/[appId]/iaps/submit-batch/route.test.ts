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

const listAllInAppPurchases = vi.hoisted(() => vi.fn());
const submitInAppPurchase = vi.hoisted(() => vi.fn());
const getInAppPurchase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/client", () => ({
  listAllInAppPurchases,
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
import {
  AppleApiError,
  AppleRateLimitError,
} from "@/lib/iap-management/apple/fetch";

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
  listAllInAppPurchases.mockReset();
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
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: false }), ctx);

    expect(startSubmitHubTracking).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).not.toHaveBeenCalled();
  });

  it("starts a run on the first execute:true POST (before confirmConflict exists)", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
    v2ToggleDecision.mockReturnValue({ enabled: false, reason: "allowlist empty" });
    submitInAppPurchase.mockResolvedValue(undefined);
    getInAppPurchase.mockResolvedValue({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(startSubmitHubTracking).toHaveBeenCalledTimes(1);
    expect(startSubmitHubTracking).toHaveBeenCalledWith("a@b.com");
  });

  it("confirmConflict:true resumes the client-provided hub_run_id — does NOT start a new run", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
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
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1", "apple-2"]));
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
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1", "apple-2"]));
    submitInAppPurchase.mockImplementation((_creds: unknown, appleId: string) =>
      appleId === "apple-1" ? Promise.resolve(undefined) : Promise.reject(new Error("boom")),
    );
    getInAppPurchase.mockResolvedValue({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"], execute: true }), ctx);

    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "PARTIAL", undefined);
  });

  it("all fail → FAIL", async () => {
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
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
    listAllInAppPurchases.mockResolvedValue({
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
    listAllInAppPurchases.mockResolvedValue({
      data: [{ id: "apple-1", attributes: { state: "IN_REVIEW" } }],
    });

    await POST(buildRequest({ iap_ids: ["11111111-1111-4111-8111-111111111111"], execute: true }), ctx);

    expect(submitInAppPurchase).not.toHaveBeenCalled();
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "SUCCESS", undefined);
  });
});

// ─── C1 — the stop latch on the legacy write loop ──────────────────────────

const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ID_C = "cccccccc-3333-4333-8333-cccccccccccc";
const ID_D = "dddddddd-4444-4444-8444-dddddddddddd";

/**
 * ⚠ WHAT THIS PROVES, AND WHY IT NEEDED A TEST AT ALL.
 *
 * Before C1 the legacy loop was `withConcurrency` with a per-row try/catch.
 * A 429 that had already survived `withRetry`'s full backoff failed its row
 * and the orchestrator then fired **every remaining row** at an API that had
 * just said no — spending budget it did not have, to collect errors it could
 * predict. Nothing in the suite noticed, because no test in this file ever
 * threw a rate limit at the legacy path.
 *
 * ⚠ `withRetry` is mocked to a pass-through at the top of this file, so an
 * `AppleRateLimitError` from the mock reaches `shouldStop` on the first
 * throw. That is the same error object the real curve re-throws after 4
 * attempts — the latch cannot tell the difference and must not try to.
 *
 * ⚠ Mocks are keyed on the Apple id, never on call ORDER. Concurrency is 2,
 * so `mockResolvedValueOnce` chains would bind outcomes to whichever worker
 * happened to fire first — the test would then pass or fail on scheduling.
 */
describe("submit-batch — C1 stop latch (legacy path)", () => {
  beforeEach(() => {
    v2ToggleDecision.mockReturnValue({ enabled: false, reason: "allowlist empty" });
    localRowsResult = {
      data: [localRow(ID_A, "apple-a"), localRow(ID_B, "apple-b"), localRow(ID_C, "apple-c")],
      error: null,
    };
    listAllInAppPurchases.mockResolvedValue(
      readyAppleState(["apple-a", "apple-b", "apple-c"]),
    );
    getInAppPurchase.mockResolvedValue({
      data: { attributes: { state: "WAITING_FOR_REVIEW" } },
    });
  });

  const post = () =>
    POST(buildRequest({ iap_ids: [ID_A, ID_B, ID_C], execute: true }), ctx);

  /** apple-a succeeds, apple-b is rate-limited. Concurrency is 2, so those
   *  two are the in-flight pair and apple-c is the row the latch protects. */
  function rateLimitOnB() {
    submitInAppPurchase.mockImplementation((_c: unknown, appleId: string) =>
      appleId === "apple-b"
        ? Promise.reject(new AppleRateLimitError("POST", "/x", "", null))
        : Promise.resolve(undefined),
    );
  }

  it("⚠ a 429 that survived retry STOPS the batch — the later row gets zero Apple calls", async () => {
    rateLimitOnB();
    const body = await (await post()).json();

    // ⚠ THE LOAD-BEARING ASSERTION IS THE CALL COUNT, not the status. A
    // status can be right while the request was still sent; only the count
    // proves nothing went out.
    expect(submitInAppPurchase).toHaveBeenCalledTimes(2);
    expect(submitInAppPurchase).not.toHaveBeenCalledWith(expect.anything(), "apple-c");
    expect(body.not_attempted).toBe(1);
  });

  it("every row is accounted for exactly once — nothing is dropped", async () => {
    rateLimitOnB();
    const body = await (await post()).json();

    expect(body.results).toHaveLength(3);
    expect(body.submitted + body.failed + body.not_attempted).toBe(3);
  });

  it("the not-attempted row is named individually, not just counted", async () => {
    rateLimitOnB();
    const body = await (await post()).json();

    const notAttempted = body.results.filter(
      (r: { status: string }) => r.status === "NOT_ATTEMPTED",
    );
    expect(notAttempted).toHaveLength(1);
    expect(notAttempted[0].iap_id).toBe(ID_C);
    expect(notAttempted[0].error).toMatch(/safe to submit again/i);
  });

  it("a NON-429 failure does NOT stop the batch — one bad row is not a halted batch", async () => {
    submitInAppPurchase.mockImplementation((_c: unknown, appleId: string) =>
      appleId === "apple-b"
        ? Promise.reject(new AppleApiError(409, "POST", "/x", "conflict"))
        : Promise.resolve(undefined),
    );
    const body = await (await post()).json();

    expect(submitInAppPurchase).toHaveBeenCalledTimes(3);
    expect(body.failed).toBe(1);
    expect(body.not_attempted).toBe(0);
  });

  it("a clean run reports not_attempted: 0", async () => {
    submitInAppPurchase.mockResolvedValue(undefined);
    const body = await (await post()).json();

    expect(body.submitted).toBe(3);
    expect(body.not_attempted).toBe(0);
  });

  it("a stopped batch is PARTIAL, not FAIL — the untouched row is neither success nor failure", async () => {
    rateLimitOnB();
    await post();

    // The 429 row IS a failure (it was asked and refused); the not-attempted
    // row is not. 1 success + 1 failure ⇒ PARTIAL. Counting the untouched row
    // as failed would drag a batch that stopped cleanly toward FAIL.
    expect(finalizeSubmitHubTracking).toHaveBeenCalledWith("run-1", "PARTIAL", undefined);
  });
});

/**
 * ⚠ TWO DIFFERENT "SKIPS" IN ONE BATCH — the fixture exists so the two can
 * be told apart by something other than the developer's memory.
 *
 *   SKIPPED_BY_STATE_GUARD — Apple WAS asked (state recheck) and said this
 *                            row is not READY_TO_SUBMIT. Re-submitting now
 *                            changes nothing.
 *   NOT_ATTEMPTED          — Apple was NOT asked. Safe to submit again.
 *
 * Merging them (e.g. reusing SKIPPED_BY_STATE_GUARD for the latch) would
 * pass any test that only counts "skips", so the assertions below are
 * deliberately about MEMBERSHIP: which specific row landed in which bucket.
 */
describe("submit-batch — C1: NOT_ATTEMPTED must not be confused with SKIPPED_BY_STATE_GUARD", () => {
  beforeEach(() => {
    v2ToggleDecision.mockReturnValue({ enabled: false, reason: "allowlist empty" });
  });

  /**
   * ⚠ FOUR rows, not three, and the reason is `SUBMIT_CONCURRENCY = 2`.
   * With only two ELIGIBLE rows both are already in flight when the 429
   * lands, so there is no row left behind the latch and nothing to observe —
   * that is stoppable-pool Rule 3 working correctly (in-flight siblings run
   * to completion and keep their real results), not a bug. A third eligible
   * row is what makes "never dispatched" a distinguishable state at all.
   */
  it("guard-skip + rate-limit + in-flight sibling + untouched row land in FOUR distinct buckets", async () => {
    localRowsResult = {
      data: [
        localRow(ID_A, "apple-guard"),
        localRow(ID_B, "apple-hit"),
        localRow(ID_C, "apple-sibling"),
        localRow(ID_D, "apple-untouched"),
      ],
      error: null,
    };
    // `apple-guard` is NOT ready ⇒ partitionByStateGuard skips it upfront,
    // before Apple is written to at all.
    listAllInAppPurchases.mockResolvedValue({
      data: [
        { id: "apple-guard", attributes: { state: "IN_REVIEW" } },
        { id: "apple-hit", attributes: { state: "READY_TO_SUBMIT" } },
        { id: "apple-sibling", attributes: { state: "READY_TO_SUBMIT" } },
        { id: "apple-untouched", attributes: { state: "READY_TO_SUBMIT" } },
      ],
    });
    getInAppPurchase.mockResolvedValue({
      data: { attributes: { state: "WAITING_FOR_REVIEW" } },
    });
    submitInAppPurchase.mockImplementation((_c: unknown, appleId: string) =>
      appleId === "apple-hit"
        ? Promise.reject(new AppleRateLimitError("POST", "/x", "", null))
        : Promise.resolve(undefined),
    );

    const body = await (
      await POST(buildRequest({ iap_ids: [ID_A, ID_B, ID_C, ID_D], execute: true }), ctx)
    ).json();

    const byId = new Map<string, string>(
      body.results.map((r: { iap_id: string; status: string }) => [r.iap_id, r.status]),
    );

    // ⚠ Membership, not counts. A collapsed implementation gets the counts
    // right and this wrong.
    expect(byId.get(ID_A)).toBe("SKIPPED_BY_STATE_GUARD"); // Apple asked, said no
    expect(byId.get(ID_B)).toBe("ERROR");                  // Apple asked, refused
    expect(byId.get(ID_C)).toBe("SUCCESS");                // in flight when the latch fell
    expect(byId.get(ID_D)).toBe("NOT_ATTEMPTED");          // never dispatched

    // And the two "skip" counters stay separate on the response.
    expect(body.skipped).toBe(1);
    expect(body.not_attempted).toBe(1);

    // Both un-sent rows were un-sent — for two different reasons, decided at
    // two different times (preflight vs mid-run).
    expect(submitInAppPurchase).not.toHaveBeenCalledWith(expect.anything(), "apple-guard");
    expect(submitInAppPurchase).not.toHaveBeenCalledWith(expect.anything(), "apple-untouched");
  });
});

describe("submit-batch — v2 path: multi-request finalize", () => {
  beforeEach(() => {
    v2ToggleDecision.mockReturnValue({ enabled: true, reason: "allowlisted" });
    localRowsResult = { data: [localRow("11111111-1111-4111-8111-111111111111", "apple-1")], error: null };
    listAllInAppPurchases.mockResolvedValue(readyAppleState(["apple-1"]));
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
    listAllInAppPurchases.mockResolvedValue({
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
