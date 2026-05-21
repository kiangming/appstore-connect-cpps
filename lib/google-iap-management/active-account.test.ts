import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  ACTIVE_ACCOUNT_COOKIE,
  resolveActiveAccountId,
} from "./active-account";

// Spy on the cookies() store across both read + write paths so we can
// regression-test that writeActiveAccountId emits exactly one set()
// call. The Hotfix 7 bug was a second set() in writeActiveAccountId
// that collided with the first in ResponseCookies' name-keyed Map and
// silently nuked the new cookie — a unit-level guard catches a
// recurrence at the function boundary.
const setSpy = vi.fn();
const getSpy = vi.fn(() => undefined);
vi.mock("next/headers", () => ({
  cookies: () => ({
    set: setSpy,
    get: getSpy,
    getAll: () => [],
    delete: () => undefined,
  }),
}));

beforeEach(() => {
  setSpy.mockClear();
  getSpy.mockClear();
});

const verified = (id: string) => ({ id, status: "verified" });
const pending = (id: string) => ({ id, status: "pending" });
const invalid = (id: string) => ({ id, status: "invalid" });

describe("writeActiveAccountId (Hotfix 7 regression)", () => {
  it("emits exactly one cookies().set() call per invocation", async () => {
    const { writeActiveAccountId } = await import("./active-account");
    writeActiveAccountId("acct-uuid-123");
    expect(setSpy).toHaveBeenCalledTimes(1);
    const args = setSpy.mock.calls[0][0];
    expect(args).toMatchObject({
      name: ACTIVE_ACCOUNT_COOKIE,
      value: "acct-uuid-123",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    expect(args.maxAge).toBeGreaterThan(0);
  });

  it("uses the renamed `g_iap_active_v2` cookie name", () => {
    expect(ACTIVE_ACCOUNT_COOKIE).toBe("g_iap_active_v2");
  });
});

describe("resolveActiveAccountId", () => {
  it("returns null when accounts list is empty", () => {
    expect(resolveActiveAccountId([], null)).toBeNull();
    expect(resolveActiveAccountId([], "stale-id")).toBeNull();
  });

  it("returns the cookie id when it matches an account", () => {
    const accounts = [verified("a"), pending("b"), verified("c")];
    expect(resolveActiveAccountId(accounts, "b")).toBe("b");
    expect(resolveActiveAccountId(accounts, "c")).toBe("c");
  });

  it("falls back to first verified when cookie is missing", () => {
    const accounts = [pending("p1"), verified("v1"), verified("v2")];
    expect(resolveActiveAccountId(accounts, null)).toBe("v1");
  });

  it("falls back to first verified when cookie id is stale (account deleted)", () => {
    const accounts = [pending("p1"), verified("v1")];
    expect(resolveActiveAccountId(accounts, "deleted-id")).toBe("v1");
  });

  it("falls back to first account regardless of status when no verified exists", () => {
    const accounts = [pending("p1"), invalid("i1")];
    expect(resolveActiveAccountId(accounts, null)).toBe("p1");
  });

  it("preserves cookie even when status would not be auto-selected", () => {
    // If Manager explicitly pinned an invalid/pending account, respect it
    // — the switcher / Settings page can surface the bad status.
    const accounts = [verified("v1"), invalid("i1")];
    expect(resolveActiveAccountId(accounts, "i1")).toBe("i1");
  });
});
