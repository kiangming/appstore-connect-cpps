/**
 * Unit tests for the Apple ASC fetch primitives. Mocks @/lib/asc-jwt (no
 * actual JWT signing) and @/lib/logger, then stubs global fetch so we can
 * drive specific HTTP status codes + response shapes per case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  iapFetch,
  withRetry,
  AppleApiError,
  AppleRateLimitError,
} from "./fetch";
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

describe("iapFetch", () => {
  it("returns parsed JSON on 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { data: { id: "abc", type: "inAppPurchases" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await iapFetch<{ data: { id: string } }>(
      creds,
      "GET",
      "/v2/inAppPurchases/abc",
    );
    expect(result.data.id).toBe("abc");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.appstoreconnect.apple.com/v2/inAppPurchases/abc");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer fake-jwt-token",
      "Content-Type": "application/json",
    });
  });

  it("serialises body to JSON for non-GET methods", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(201, {}));
    vi.stubGlobal("fetch", fetchMock);

    await iapFetch(creds, "POST", "/v2/inAppPurchases", {
      data: { type: "x", attributes: { name: "n" } },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).body).toBe(
      JSON.stringify({ data: { type: "x", attributes: { name: "n" } } }),
    );
  });

  it("returns undefined on 204 (DELETE no-content)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(204, "")));
    const result = await iapFetch<void>(creds, "DELETE", "/v2/inAppPurchases/x");
    expect(result).toBeUndefined();
  });

  it("throws AppleApiError on non-429 4xx with status + body preserved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(422, '{"errors":[{"detail":"validation failed"}]}'),
      ),
    );
    let thrown: unknown;
    try {
      await iapFetch(creds, "POST", "/v2/inAppPurchases", { data: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppleApiError);
    expect(thrown).not.toBeInstanceOf(AppleRateLimitError);
    const apiErr = thrown as AppleApiError;
    expect(apiErr.status).toBe(422);
    expect(apiErr.method).toBe("POST");
    expect(apiErr.body).toContain("validation failed");
  });

  it("throws AppleRateLimitError on 429 with parsed Retry-After (seconds)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(429, "rate limited", { "retry-after": "30" }),
      ),
    );
    let thrown: unknown;
    try {
      await iapFetch(creds, "GET", "/v2/inAppPurchases/x");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppleRateLimitError);
    const rlErr = thrown as AppleRateLimitError;
    expect(rlErr.retryAfterMs).toBe(30_000);
  });

  it("AppleRateLimitError extends AppleApiError (so generic catch works)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(429, "")),
    );
    let thrown: unknown;
    try {
      await iapFetch(creds, "GET", "/x");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppleRateLimitError);
    expect(thrown).toBeInstanceOf(AppleApiError); // inheritance check
  });

  it("429 without Retry-After yields null retryAfterMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(429, "")),
    );
    let thrown: unknown;
    try {
      await iapFetch(creds, "GET", "/x");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as AppleRateLimitError).retryAfterMs).toBeNull();
  });
});

describe("withRetry", () => {
  const sleep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    sleep.mockClear();
  });

  it("returns immediately when fn succeeds on first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on 429 and returns when later attempt succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppleRateLimitError("GET", "/x", "", 100))
      .mockRejectedValueOnce(new AppleRateLimitError("GET", "/x", "", 200))
      .mockResolvedValueOnce("eventually-ok");

    const result = await withRetry(fn, { sleep, backoffMs: [50, 100, 200] });
    expect(result).toBe("eventually-ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // Sleep called twice (before attempts 2 + 3); each honours Retry-After
    // hint over the backoff curve.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("re-throws last AppleRateLimitError after exhausting retries", async () => {
    const last = new AppleRateLimitError("GET", "/x", "", 500);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppleRateLimitError("GET", "/x", "", 100))
      .mockRejectedValueOnce(new AppleRateLimitError("GET", "/x", "", 200))
      .mockRejectedValueOnce(new AppleRateLimitError("GET", "/x", "", 300))
      .mockRejectedValueOnce(last);

    await expect(
      withRetry(fn, { sleep, backoffMs: [10, 20, 30] }),
    ).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("does NOT retry non-rate-limit AppleApiError", async () => {
    const err = new AppleApiError(422, "POST", "/x", "validation");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry generic Error (non-AppleApiError)", async () => {
    const err = new Error("network broke");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("caps Retry-After at 10s ceiling (RETRY_DELAY_CEILING_MS)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        new AppleRateLimitError("GET", "/x", "", 60_000), // 60s
      )
      .mockResolvedValueOnce("ok");

    await withRetry(fn, { sleep });
    expect(sleep).toHaveBeenCalledWith(10_000); // capped at 10s
  });

  it("falls back to backoff curve when Retry-After is null", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new AppleRateLimitError("GET", "/x", "", null))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, { sleep, backoffMs: [777] });
    expect(sleep).toHaveBeenCalledWith(777);
  });
});

describe("AppleApiError / AppleRateLimitError construction", () => {
  it("AppleApiError carries status + endpoint + method + body fields", () => {
    const err = new AppleApiError(404, "GET", "/v2/inAppPurchases/xyz", "not found");
    expect(err.status).toBe(404);
    expect(err.endpoint).toBe("/v2/inAppPurchases/xyz");
    expect(err.method).toBe("GET");
    expect(err.body).toBe("not found");
    expect(err.name).toBe("AppleApiError");
    expect(err.message).toContain("Apple ASC API error 404");
  });

  it("AppleRateLimitError name + retryAfterMs visible", () => {
    const err = new AppleRateLimitError("POST", "/v1/x", "body", 1500);
    expect(err.name).toBe("AppleRateLimitError");
    expect(err.retryAfterMs).toBe(1500);
    expect(err.status).toBe(429);
  });
});
