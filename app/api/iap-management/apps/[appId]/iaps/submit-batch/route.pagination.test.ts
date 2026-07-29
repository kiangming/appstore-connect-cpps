/**
 * ACCEPTANCE — submit-guard false-NOT_FOUND fix (pagination re-break).
 *
 * The un-truncation proof. Unlike route.test.ts (which mocks the whole client
 * module and therefore could never prove the tail is visible), this file drives
 * the REAL `listAllInAppPurchases` over a MULTI-PAGE mocked `iapFetch`: page 1
 * carries `links.next`, and a selected IAP's `apple_iap_id` exists ONLY on
 * page 2.
 *
 * Under the retired single-page `listInAppPurchases` the guard fetched only
 * page 1, so the page-2 IAP was absent from the live set and stamped
 * NOT_FOUND ("Apple no longer returns this IAP…") — the exact production
 * symptom on CookieRun (app 6739696719, >200 IAPs). These tests assert that
 * IAP is now bucketed READY in preflight and actually SUBMITTED in execute
 * (never SKIPPED_BY_STATE_GUARD).
 *
 * Also pins the fail-loud contract: when enumeration errors mid-pagination the
 * guard returns a retryable "couldn't verify" error, NOT a false NOT_FOUND.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Only iapFetch is mocked; the client (listAllInAppPurchases, submit,
//     getInAppPurchase) and withRetry run FOR REAL, so pagination is exercised.
const iapFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/fetch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/iap-management/apple/fetch")>();
  return { ...actual, iapFetch };
});
import { AppleApiError } from "@/lib/iap-management/apple/fetch";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/iap-management/auth")>(
      "@/lib/iap-management/auth",
    );
  return { ...actual, requireIapSession };
});

const getActiveAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));

const v2ToggleDecision = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/submit-v2-toggle", () => ({ v2ToggleDecision }));

// Legacy path only in these tests — stub the v2 module so it never loads live.
vi.mock("@/lib/iap-management/apple/submit-v2", () => ({
  checkForConflict: vi.fn(),
  executeSubmitV2: vi.fn(),
  confirmSubmitV2: vi.fn(),
  rollbackOrLeaveSubmitV2: vi.fn(),
}));

const startSubmitHubTracking = vi.hoisted(() => vi.fn());
const finalizeSubmitHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/hub-tracking/submit-tracking", () => ({
  startSubmitHubTracking,
  finalizeSubmitHubTracking,
}));

vi.mock("@/lib/logger", () => ({ log: vi.fn().mockResolvedValue(undefined) }));

// Chainable Supabase stub — mirrors route.test.ts's convention.
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

const APP_ID = "6739696719"; // CookieRun — the production app that surfaced this.
const ctx = { params: { appId: APP_ID } };
const session = { user: { email: "manager@vng.com.vn", role: "member" } };

// Two selected IAPs: HEAD lives on page 1, TAIL lives ONLY on page 2.
const HEAD = "11111111-1111-4111-8111-111111111111";
const TAIL = "22222222-2222-4222-8222-222222222222";
const NEXT_URL =
  "https://api.appstoreconnect.apple.com/v1/apps/6739696719/inAppPurchasesV2?cursor=PAGE2&limit=200";

function appleIap(id: string, state: string) {
  return {
    type: "inAppPurchases",
    id,
    attributes: {
      productId: `com.vng.sea.cos.${id}`,
      name: id,
      inAppPurchaseType: "CONSUMABLE",
      state,
    },
  };
}

function buildRequest(body: Record<string, unknown>): Request {
  return new Request(
    `http://localhost/api/iap-management/apps/${APP_ID}/iaps/submit-batch`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Default two-page enumeration: page1=[apple-head], links.next→page2=[apple-tail]. */
function twoPageAllReady() {
  iapFetch.mockImplementation((_creds: unknown, method: string, endpoint: string) => {
    if (method === "GET" && endpoint.includes("inAppPurchasesV2")) {
      if (endpoint.includes("cursor=PAGE2")) {
        return Promise.resolve({ data: [appleIap("apple-tail", "READY_TO_SUBMIT")] });
      }
      return Promise.resolve({
        data: [appleIap("apple-head", "READY_TO_SUBMIT")],
        links: { next: NEXT_URL },
      });
    }
    // Legacy submit + post-submit state read (execute path).
    if (method === "POST" && endpoint === "/v1/inAppPurchaseSubmissions") {
      return Promise.resolve({ data: { id: "sub-1", type: "inAppPurchaseSubmissions" } });
    }
    if (method === "GET" && endpoint.startsWith("/v2/inAppPurchases/")) {
      return Promise.resolve({ data: { attributes: { state: "WAITING_FOR_REVIEW" } } });
    }
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  requireIapSession.mockReset().mockResolvedValue(session);
  getActiveAccount
    .mockReset()
    .mockResolvedValue({ id: "acc", name: "N", keyId: "K", issuerId: "I", privateKey: "P" });
  v2ToggleDecision.mockReset().mockReturnValue({ enabled: false, reason: "legacy" });
  startSubmitHubTracking.mockReset().mockResolvedValue("run-1");
  finalizeSubmitHubTracking.mockReset().mockResolvedValue(undefined);
  iapFetch.mockReset();
  localRowsResult = {
    data: [
      { id: HEAD, apple_iap_id: "apple-head", product_id: "com.vng.sea.cos.head", reference_name: "Head" },
      { id: TAIL, apple_iap_id: "apple-tail", product_id: "com.vng.sea.cos.tail", reference_name: "Tail" },
    ],
    error: null,
  };
  iapDb.mockReset().mockImplementation(() => ({
    from: (table: string) => (table === "iaps" ? chainable(localRowsResult) : chainable()),
  }));
});

describe("submit-batch pagination — page-2 IAP is no longer a false NOT_FOUND", () => {
  it("PREFLIGHT: an IAP that exists only on page 2 is bucketed READY, not NOT_FOUND", async () => {
    twoPageAllReady();

    const res = await POST(buildRequest({ iap_ids: [HEAD, TAIL], execute: false }), ctx);
    const json = await res.json();

    expect(json.phase).toBe("preflight");
    // The enumerator actually followed links.next (page 1 + page 2).
    const listCalls = iapFetch.mock.calls.filter(
      (c) => c[1] === "GET" && String(c[2]).includes("inAppPurchasesV2"),
    );
    expect(listCalls).toHaveLength(2);

    const readyIds = json.ready.map((r: { iap_id: string }) => r.iap_id);
    expect(readyIds).toContain(TAIL); // ← the crux: page-2 item is visible + READY
    expect(readyIds).toContain(HEAD);

    // No NOT_FOUND anywhere — the tail is NOT in the "Cannot be submitted" bucket.
    expect(json.other).toHaveLength(0);
    const notFoundIds = json.other
      .filter((o: { state: string }) => o.state === "NOT_FOUND")
      .map((o: { iap_id: string }) => o.iap_id);
    expect(notFoundIds).not.toContain(TAIL);
  });

  it("EXECUTE: the page-2 IAP is actually submitted (never SKIPPED_BY_STATE_GUARD)", async () => {
    twoPageAllReady();

    const res = await POST(buildRequest({ iap_ids: [HEAD, TAIL], execute: true }), ctx);
    const json = await res.json();

    expect(json.phase).toBe("execute");
    expect(json.skipped).toBe(0);
    expect(json.submitted).toBe(2);

    const tail = json.results.find((r: { iap_id: string }) => r.iap_id === TAIL);
    expect(tail.status).toBe("SUCCESS");
    expect(tail.status).not.toBe("SKIPPED_BY_STATE_GUARD");
  });
});

describe("submit-batch pagination — fail-loud, never silent NOT_FOUND", () => {
  it("PREFLIGHT: an error mid-enumeration returns a retryable 'couldn't verify' error, not a false NOT_FOUND", async () => {
    // Page 1 ok (with links.next), page 2 errors → whole enumeration throws.
    iapFetch.mockImplementation((_creds: unknown, method: string, endpoint: string) => {
      if (method === "GET" && endpoint.includes("cursor=PAGE2")) {
        return Promise.reject(new AppleApiError(500, "GET", endpoint, "apple down"));
      }
      if (method === "GET" && endpoint.includes("inAppPurchasesV2")) {
        return Promise.resolve({
          data: [appleIap("apple-head", "READY_TO_SUBMIT")],
          links: { next: NEXT_URL },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const res = await POST(buildRequest({ iap_ids: [HEAD, TAIL], execute: false }), ctx);
    const json = await res.json();

    // Surfaced as an error (502 for a 5xx), NOT a preflight with NOT_FOUND rows.
    expect(res.status).toBe(502);
    expect(json.error).toMatch(/Couldn't verify/i);
    expect(json.phase).toBeUndefined();
    expect(json).not.toHaveProperty("other");
  });
});
