/**
 * Unit tests for the shared Apple ASC fetch primitive — extracted from
 * lib/iap-management/apple/fetch.ts during the IAP reviewSubmissions v2
 * migration so CPP's ascFetch gains the same 429 detection it always
 * lacked. Mirrors lib/iap-management/apple/fetch.test.ts's structure for
 * the parts that moved here; adds logTag-specific coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appleFetch,
  withRetry,
  parseRateLimit,
  AppleApiError,
  AppleRateLimitError,
} from "./apple-fetch";
import type { AscCredentials } from "@/lib/asc-jwt";

vi.mock("@/lib/asc-jwt", () => ({
  generateAscToken: vi.fn().mockResolvedValue("fake-jwt-token"),
}));

vi.mock("@/lib/logger", () => ({
  log: vi.fn().mockResolvedValue(undefined),
}));

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "TESTKEY12",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

function mockResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(bodyText),
    json: () => Promise.resolve(typeof body === "string" ? JSON.parse(body) : body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("appleFetch", () => {
  it("returns parsed JSON on 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { data: { id: "abc", type: "apps" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await appleFetch<{ data: { id: string } }>(
      creds,
      "GET",
      "/v1/apps/abc",
      undefined,
      "asc-client",
    );
    expect(result.data.id).toBe("abc");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.appstoreconnect.apple.com/v1/apps/abc");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer fake-jwt-token",
      "Content-Type": "application/json",
    });
  });

  it("accepts a full URL (Apple's links.next cursor form) without double-prefixing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await appleFetch(
      creds,
      "GET",
      "https://api.appstoreconnect.apple.com/v1/apps?cursor=P2",
      undefined,
      "asc-client",
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.appstoreconnect.apple.com/v1/apps?cursor=P2",
    );
  });

  it("returns undefined on 204", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(204, "")));
    const result = await appleFetch<void>(creds, "DELETE", "/v1/apps/x", undefined, "asc-client");
    expect(result).toBeUndefined();
  });

  it("throws AppleApiError on non-429 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(409, '{"errors":[{"detail":"conflict"}]}')),
    );
    let thrown: unknown;
    try {
      await appleFetch(creds, "POST", "/v1/reviewSubmissions", { data: {} }, "asc-client");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppleApiError);
    expect(thrown).not.toBeInstanceOf(AppleRateLimitError);
    expect((thrown as AppleApiError).status).toBe(409);
  });

  it("throws AppleRateLimitError on 429 — CPP's ascFetch now has 429 protection it never had", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(429, "rate limited", { "retry-after": "12" })),
    );
    let thrown: unknown;
    try {
      await appleFetch(creds, "POST", "/v1/reviewSubmissionItems", { data: {} }, "asc-client");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppleRateLimitError);
    expect((thrown as AppleRateLimitError).retryAfterMs).toBe(12_000);
  });

  it("emits the [asc-client] budget line regardless of logTag (unified grep marker)", async () => {
    const { log } = await import("@/lib/logger");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(200, { data: { id: "x" } }, {
          "x-rate-limit": "user-hour-lim:3600;user-hour-rem:1234;",
        }),
      ),
    );
    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-submit-v2");
    const budgetCall = (log as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("[asc-client]"),
    );
    expect(budgetCall).toBeDefined();
    expect(budgetCall![0]).toBe("iap-submit-v2");
    expect(budgetCall![1]).toContain("budget=1234/3600");
  });

  it("defaults logTag to 'apple-fetch' when omitted", async () => {
    const { log } = await import("@/lib/logger");
    (log as ReturnType<typeof vi.fn>).mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: {} })));
    await appleFetch(creds, "GET", "/v1/apps/x");
    expect((log as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("apple-fetch");
  });
});

describe("withRetry (re-exported unchanged)", () => {
  it("retries only on 429 and honors Retry-After", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppleRateLimitError("POST", "/x", "", 250))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { sleep });
    expect(result).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does not retry non-429 errors", async () => {
    const err = new AppleApiError(422, "POST", "/x", "bad");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep: vi.fn() })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("parseRateLimit (re-exported unchanged)", () => {
  it("parses canonical Apple format", () => {
    expect(
      parseRateLimit(new Headers({ "x-rate-limit": "user-hour-lim:3600;user-hour-rem:1450;" })),
    ).toEqual({ limit: 3600, remaining: 1450 });
  });

  it("returns null when header absent", () => {
    expect(parseRateLimit(new Headers())).toBeNull();
  });
});
