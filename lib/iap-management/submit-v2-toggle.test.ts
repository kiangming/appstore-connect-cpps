import { describe, it, expect } from "vitest";
import { parseAllowlist, v2ToggleDecision, isV2SubmitEnabled } from "./submit-v2-toggle";

describe("parseAllowlist", () => {
  it("parses a comma-separated list", () => {
    const { wildcard, ids } = parseAllowlist("app1,app2,app3");
    expect(wildcard).toBe(false);
    expect(ids).toEqual(new Set(["app1", "app2", "app3"]));
  });

  it("trims whitespace around each entry", () => {
    const { ids } = parseAllowlist("app1, app2 ,  app3");
    expect(ids).toEqual(new Set(["app1", "app2", "app3"]));
  });

  it("detects the wildcard anywhere in the list", () => {
    expect(parseAllowlist("*").wildcard).toBe(true);
    expect(parseAllowlist("app1,*,app2").wildcard).toBe(true);
  });

  it("drops empty entries from stray commas", () => {
    const { ids } = parseAllowlist("app1,,app2,");
    expect(ids).toEqual(new Set(["app1", "app2"]));
  });

  it("returns empty for a blank string", () => {
    const { wildcard, ids } = parseAllowlist("");
    expect(wildcard).toBe(false);
    expect(ids.size).toBe(0);
  });
});

describe("v2ToggleDecision — three states", () => {
  it("unset env → OFF for every app, reason 'allowlist empty'", () => {
    expect(v2ToggleDecision("app1", undefined)).toEqual({
      enabled: false,
      reason: "allowlist empty",
    });
  });

  it("empty string env → OFF, reason 'allowlist empty'", () => {
    expect(v2ToggleDecision("app1", "")).toEqual({
      enabled: false,
      reason: "allowlist empty",
    });
  });

  it("whitespace-only env → OFF, reason 'allowlist empty'", () => {
    expect(v2ToggleDecision("app1", "   ")).toEqual({
      enabled: false,
      reason: "allowlist empty",
    });
  });

  it("'*' → ON for any app id, including one never explicitly listed", () => {
    expect(v2ToggleDecision("some-random-app-id-999", "*")).toEqual({
      enabled: true,
      reason: "allowlist=*",
    });
  });

  it("'*' mixed with other entries still enables everything", () => {
    expect(v2ToggleDecision("anything", "app1,*,app2")).toEqual({
      enabled: true,
      reason: "allowlist=*",
    });
  });

  it("does NOT literal-match '*' as an app id — dogfood list without wildcard stays scoped", () => {
    // Regression guard: an allowlist containing a literal app id that
    // happens to equal the string used for the wildcard check elsewhere
    // must not accidentally enable everything.
    expect(v2ToggleDecision("*", "app1,app2").enabled).toBe(false);
  });

  it("exact match in a dogfood list → ON, reason 'allowlisted'", () => {
    expect(v2ToggleDecision("app2", "app1,app2,app3")).toEqual({
      enabled: true,
      reason: "allowlisted",
    });
  });

  it("app id not in a dogfood list → OFF, reason 'not in allowlist'", () => {
    expect(v2ToggleDecision("app-not-listed", "app1,app2,app3")).toEqual({
      enabled: false,
      reason: "not in allowlist",
    });
  });

  it("dogfood list entries are trimmed before matching", () => {
    expect(v2ToggleDecision("app2", "app1, app2 , app3").enabled).toBe(true);
  });
});

describe("isV2SubmitEnabled — boolean convenience wrapper", () => {
  it("matches v2ToggleDecision.enabled", () => {
    expect(isV2SubmitEnabled("app1", "*")).toBe(true);
    expect(isV2SubmitEnabled("app1", "")).toBe(false);
    expect(isV2SubmitEnabled("app1", "app1")).toBe(true);
    expect(isV2SubmitEnabled("app2", "app1")).toBe(false);
  });
});
