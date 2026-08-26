/**
 * `AppleFetchOptions.onRateLimitInfo` — the additive observer added for the
 * pool-key Test button ([POOL-key-management-UI], Manager Q1).
 *
 * ⚠ THE GATE CONDITION FOR THIS FEATURE IS "NOTHING ELSE MOVES". This file is
 * shared with CPP Manager and sits on the single line in the repo that mints
 * an Apple JWT. So the first describe below is not about the new option at
 * all — it pins that a call WITHOUT the option behaves exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appleFetch } from "./apple-fetch";
import type { AscCredentials } from "@/lib/asc-jwt";

vi.mock("@/lib/asc-jwt", () => ({
  generateAscToken: vi.fn().mockResolvedValue("fake-jwt-token"),
}));
const log = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/logger", () => ({ log }));

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "TESTKEY12",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

const BUDGET = { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3599;" };

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
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  log.mockClear().mockResolvedValue(undefined);
});

describe("⚠ omitting the option leaves behaviour byte-identical", () => {
  it("returns the same parsed body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: [1, 2] }, BUDGET)));
    const out = await appleFetch<{ data: number[] }>(creds, "GET", "/v1/apps");
    expect(out).toEqual({ data: [1, 2] });
  });

  it("emits the same [asc-client] budget line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, BUDGET)));
    await appleFetch(creds, "GET", "/v1/apps");
    const lines = log.mock.calls.map((c) => String(c[1]));
    expect(lines.some((l) => l.includes("[asc-client] GET /v1/apps → 200 budget=3599/3600"))).toBe(true);
  });

  it("⚠ emits NO extra log line when no observer is passed", async () => {
    // The observer branch must be inert when unused — a stray line here
    // would change every CPP log grep.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, BUDGET)));
    await appleFetch(creds, "GET", "/v1/apps");
    expect(log.mock.calls.some((c) => String(c[1]).includes("onRateLimitInfo"))).toBe(false);
  });

  it("still throws on a non-2xx exactly as before", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(404, { errors: [] })));
    await expect(appleFetch(creds, "GET", "/v1/apps")).rejects.toThrow();
  });
});

describe("the observer reports the budget", () => {
  it("receives limit and remaining when Apple sent the header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, BUDGET)));
    const seen: unknown[] = [];
    await appleFetch(creds, "GET", "/v1/territories?limit=1", undefined, "t", {
      onRateLimitInfo: (info) => seen.push(info),
    });
    expect(seen).toEqual([{ limit: 3600, remaining: 3599 }]);
  });

  it("⚠ receives null when Apple sent no header — absence is reportable", async () => {
    // KB §4.9: the two IAP endpoints omit the header entirely. A caller that
    // could not tell "no header" from "never called" would render a blank
    // budget as if it were a measurement.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, {})));
    const seen: unknown[] = [];
    await appleFetch(creds, "GET", "/v2/inAppPurchases/x", undefined, "t", {
      onRateLimitInfo: (info) => seen.push(info),
    });
    expect(seen).toEqual([null]);
  });

  it("is called exactly once per request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, BUDGET)));
    const obs = vi.fn();
    await appleFetch(creds, "GET", "/v1/apps", undefined, "t", { onRateLimitInfo: obs });
    expect(obs).toHaveBeenCalledTimes(1);
  });
});

describe("⚠ (f) a throwing observer cannot break the request", () => {
  it("the Apple call still succeeds and returns its body", async () => {
    // The request is already sent and Apple has answered. Letting an
    // observer's bug fail it would turn a success into a failure — and on a
    // retry-wrapped path, into three more requests at Apple.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { ok: 1 }, BUDGET)));
    const out = await appleFetch<{ ok: number }>(creds, "GET", "/v1/apps", undefined, "t", {
      onRateLimitInfo: () => {
        throw new Error("observer blew up");
      },
    });
    expect(out).toEqual({ ok: 1 });
  });

  it("⚠ and the failure is logged, not swallowed silently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, BUDGET)));
    await appleFetch(creds, "GET", "/v1/apps", undefined, "t", {
      onRateLimitInfo: () => {
        throw new Error("observer blew up");
      },
    });
    const warned = log.mock.calls.find((c) => String(c[1]).includes("onRateLimitInfo"));
    expect(warned).toBeDefined();
    expect(String(warned?.[1])).toContain("observer blew up");
    expect(warned?.[2]).toBe("WARN");
  });

  it("the budget line is still emitted after an observer throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {}, BUDGET)));
    await appleFetch(creds, "GET", "/v1/apps", undefined, "t", {
      onRateLimitInfo: () => {
        throw new Error("boom");
      },
    });
    expect(log.mock.calls.some((c) => String(c[1]).includes("budget=3599/3600"))).toBe(true);
  });
});
