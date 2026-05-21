import { describe, it, expect } from "vitest";

import { resolveActiveAccountId } from "./active-account";

const verified = (id: string) => ({ id, status: "verified" });
const pending = (id: string) => ({ id, status: "pending" });
const invalid = (id: string) => ({ id, status: "invalid" });

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
