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

  // ─── F3 — the budget line names WHICH key spent it ───────────────────────

  it("the budget line carries key=<keyId>, and the legacy grep still matches", async () => {
    const { log } = await import("@/lib/logger");
    (log as ReturnType<typeof vi.fn>).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(200, { data: { id: "x" } }, {
          "x-rate-limit": "user-hour-lim:3600;user-hour-rem:1234;",
        }),
      ),
    );
    await appleFetch(creds, "GET", "/v1/apps/x");
    const line = (log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[1] as string)
      .find((m) => typeof m === "string" && m.includes("[asc-client]"))!;

    // The new field.
    expect(line).toContain("key=TESTKEY12");

    // ⚠ AND THE OLD PATTERN STILL MATCHES. The Manager's audit grep
    // (`[asc-client] … budget=`) predates this field; appending must not
    // redefine it. Asserted as the actual regex, not as a substring, so a
    // future edit that reorders the line fails here.
    expect(line).toMatch(/\[asc-client\] .* budget=/);

    // Field order is part of the contract for anyone parsing with awk.
    expect(line).toMatch(
      /^\[asc-client\] GET \/v1\/apps\/x → 200 budget=1234\/3600 duration=\d+ms key=TESTKEY12$/,
    );
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

// ─── F1 — an unreadable component is NOT a reading of zero ─────────────────

/**
 * ⚠ THE BUG THIS PINS IS `Number("")` === 0, NOT NaN.
 *
 * The old guard was `if (!Number.isFinite(Number(value))) continue;`, which
 * lets an EMPTY value through as the number 0. So `user-hour-rem:;` parsed
 * as `remaining: 0` — indistinguishable from a genuinely exhausted budget.
 *
 * Two different facts, and only one of them is a reason to stop working:
 *   "0"  → Apple says the budget is gone.
 *   ""   → we could not read the budget at all.
 *
 * Right now the only consumer is a Railway log line, so the cost is one
 * wrong log. The moment anything reads `remaining` to decide whether to keep
 * dispatching, the same confusion freezes a job for no reason. Hence the fix
 * lands before that consumer exists, not after.
 *
 * ⚠ Header FORMAT below is Apple's, sourced from the "Identifying Rate
 * Limits" docs page (a single `X-Rate-Limit` header whose value is a
 * `;`-delimited list of `key:value` components):
 *     X-Rate-Limit: user-hour-lim:3600; user-hour-rem:500;
 * These fixtures are hand-written to that spec — they prove the parser is
 * self-consistent with the documented shape, NOT that the header is named
 * this on the wire. That is only knowable from a live response.
 */
describe("parseRateLimit — unreadable ≠ zero (F1)", () => {
  const rl = (v: string) => parseRateLimit(new Headers({ "x-rate-limit": v }));

  it("⚠ an EMPTY value must not parse as zero — it is not a reading", () => {
    // Number("") === 0 is the whole bug. This is the regression anchor.
    expect(rl("user-hour-lim:3600;user-hour-rem:;")).toBeNull();
  });

  it("a whitespace-only value is empty too (value is trimmed first)", () => {
    expect(rl("user-hour-lim:3600;user-hour-rem:   ;")).toBeNull();
  });

  it("an empty LIMIT is equally unreadable — the rule is not rem-specific", () => {
    expect(rl("user-hour-lim:;user-hour-rem:500;")).toBeNull();
  });

  it("a non-numeric value stays unreadable", () => {
    expect(rl("user-hour-lim:3600;user-hour-rem:abc;")).toBeNull();
  });

  it("a NEGATIVE value is rejected — a negative budget is not a thing", () => {
    // Number("-5") is finite, so the old guard accepted it and reported a
    // remaining of -5. Nothing Apple can mean by that.
    expect(rl("user-hour-lim:3600;user-hour-rem:-5;")).toBeNull();
  });

  it("exponent / hex notation is rejected — finite, but not what Apple sends", () => {
    expect(rl("user-hour-lim:3600;user-hour-rem:1e3;")).toBeNull();
    expect(rl("user-hour-lim:3600;user-hour-rem:0x10;")).toBeNull();
  });

  it("a REAL zero still parses — exhausted is a reading, and must survive", () => {
    // ⚠ The mirror of the headline case. A fix that swallowed "0" would
    // trade a false "exhausted" for a false "unknown" and be just as wrong.
    expect(rl("user-hour-lim:3600;user-hour-rem:0;")).toEqual({
      limit: 3600,
      remaining: 0,
    });
  });

  it("one bad component does not poison a good one — the OTHER key still reads", () => {
    // rem is unreadable, so the whole result is null (both fields required),
    // but the loop must not abort early: lim is still parsed on the way past.
    // Proven by flipping which key is broken and getting null both ways.
    expect(rl("user-hour-rem:;user-hour-lim:3600;")).toBeNull();
    expect(rl("user-hour-lim:;user-hour-rem:500;")).toBeNull();
  });

  it("the documented format with a space after ';' still parses (docs verbatim)", () => {
    expect(rl("user-hour-lim:3600; user-hour-rem:500;")).toEqual({
      limit: 3600,
      remaining: 500,
    });
  });
});

// ─── K2 — key pool: rotation lives INSIDE the retry curve ──────────────────

/**
 * ⚠ WHAT THESE PROVE, AND WHY THE PLACEMENT IS THE WHOLE DESIGN.
 *
 * The pool could have been wired in three places: inside `withRetry`
 * (changes `fn`'s signature at ~37 call sites), in a wrapper around each
 * orchestrator (five copies of the same state), or here — at the one point
 * where a JWT is minted. Here wins because `withRetry` re-runs the entire
 * `fn()` on every attempt, so selection is reached again per attempt and a
 * retry naturally gets a different key. Nothing else changes: no signature,
 * no call site, and no latch contract — "an AppleRateLimitError escaped
 * withRetry" now means the budget ran out on up to four DIFFERENT keys,
 * which is a stronger claim than the old one rather than a conflicting one.
 *
 * That property is invisible in the source, so it is asserted by watching
 * which key signs each attempt.
 */
describe("appleFetch — key pool (K2)", () => {
  const poolCreds = (keyId: string) => ({ ...creds, keyId, privateKey: `pk-${keyId}` });

  /** Records the keyId used for each attempt, in order. */
  function makePool(keys: string[]) {
    const attempts: string[] = [];
    const cooled = new Set<string>();
    const pool = {
      select: vi.fn(async (account: typeof creds) => {
        const free = keys.filter((k) => !cooled.has(k));
        if (free.length === 0) {
          return { creds: account, fromPool: false, missReason: "exhausted" };
        }
        // ⚠ Always the first key not yet cooled down. An index derived from
        // `attempts.length` looks equivalent and is not: `free` SHRINKS as
        // keys cool, so the modulo walks past keys it has not used. That is a
        // bug in the fake, not in the code under test — and it is the kind
        // that makes a green suite meaningless, so the fake stays trivial.
        const k = free[0];
        attempts.push(k);
        return { creds: poolCreds(k), fromPool: true };
      }),
      onRateLimited: vi.fn((_acct: string, keyId: string) => {
        cooled.add(keyId);
      }),
    };
    return { pool, attempts };
  }

  function rateLimitedResponse() {
    return mockResponse(429, "too many", { "retry-after": "0" });
  }

  it("⚠ EACH RETRY ATTEMPT IS SIGNED BY A DIFFERENT KEY", async () => {
    // The headline property. If selection were hoisted above withRetry, all
    // four attempts would share one key and this fails.
    const { pool, attempts } = makePool(["K1", "K2", "K3", "K4"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rateLimitedResponse()));

    await expect(
      withRetry(
        () => appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool }),
        { sleep: vi.fn().mockResolvedValue(undefined) },
      ),
    ).rejects.toBeInstanceOf(AppleRateLimitError);

    expect(attempts).toEqual(["K1", "K2", "K3", "K4"]);
    expect(new Set(attempts).size).toBe(4);
  });

  it("⚠ the spent key is marked BEFORE the throw, so the retry skips it", async () => {
    // Marking after the throw is too late by exactly one attempt: withRetry
    // catches, sleeps, and calls back into selection immediately.
    const { pool } = makePool(["K1", "K2"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rateLimitedResponse()));

    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool }).catch(
      () => {},
    );

    expect(pool.onRateLimited).toHaveBeenCalledWith(creds.id, "K1", 0);
  });

  it("a NON-429 failure does not cool the key down", async () => {
    const { pool } = makePool(["K1"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(409, "conflict")));
    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool }).catch(
      () => {},
    );
    expect(pool.onRateLimited).not.toHaveBeenCalled();
  });

  it("a successful call does not cool the key down", async () => {
    const { pool } = makePool(["K1"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: {} })));
    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool });
    expect(pool.onRateLimited).not.toHaveBeenCalled();
  });

  it("⚠ the budget log names the SELECTED key, not the account's own", async () => {
    // Otherwise attribution per key becomes a lie exactly when the pool
    // starts having more than one key — when it is needed most.
    const { log } = await import("@/lib/logger");
    (log as ReturnType<typeof vi.fn>).mockClear();
    const { pool } = makePool(["K7"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(200, { data: {} }, { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:12;" }),
      ),
    );

    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool });
    const line = (log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[1] as string)
      .find((m) => typeof m === "string" && m.includes("[asc-client]"))!;

    expect(line).toContain("key=K7");
    expect(line).not.toContain(`key=${creds.keyId}`);
  });

  it('an "exhausted" pool falls back AND says so — it is not silent', async () => {
    const { log } = await import("@/lib/logger");
    (log as ReturnType<typeof vi.fn>).mockClear();
    const pool = {
      select: vi.fn(async (a: typeof creds) => ({
        creds: a,
        fromPool: false,
        missReason: "exhausted" as const,
      })),
      onRateLimited: vi.fn(),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: {} })));

    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool });
    const warned = (log as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => typeof c[1] === "string" && c[1].includes("ALL POOL KEYS COOLING DOWN"),
    );
    expect(warned).toBe(true);
  });

  it('an "empty" pool falls back SILENTLY — most accounts are simply not pooled', async () => {
    const { log } = await import("@/lib/logger");
    (log as ReturnType<typeof vi.fn>).mockClear();
    const pool = {
      select: vi.fn(async (a: typeof creds) => ({
        creds: a,
        fromPool: false,
        missReason: "empty" as const,
      })),
      onRateLimited: vi.fn(),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: {} })));

    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "iap-apple", { keyPool: pool });
    const warned = (log as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => typeof c[1] === "string" && c[1].includes("ALL POOL KEYS COOLING DOWN"),
    );
    expect(warned).toBe(false);
  });

  it("⚠ WITHOUT a pool, the selector is never consulted — this is CPP's path", async () => {
    // `ascFetch` calls appleFetch with no options object at all. The pool is
    // a VALUE it does not import, so this cannot regress by someone flipping
    // a flag; the assertion pins the behaviour anyway.
    const { pool } = makePool(["K1"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: {} })));

    await appleFetch(creds, "GET", "/v1/apps/x", undefined, "asc-client");

    expect(pool.select).not.toHaveBeenCalled();
    expect(pool.onRateLimited).not.toHaveBeenCalled();
  });
});
