import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isStale } from "./staleness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isStale", () => {
  it("null/undefined → stale (defensive: never block a refresh)", () => {
    expect(isStale(null, 90)).toBe(true);
    expect(isStale(undefined, 90)).toBe(true);
  });

  it("unparseable date → stale (defensive)", () => {
    expect(isStale("garbage", 90)).toBe(true);
    expect(isStale("", 90)).toBe(true);
  });

  it("exactly now → fresh", () => {
    expect(isStale(new Date().toISOString(), 90)).toBe(false);
  });

  it("89s ago + threshold 90s → fresh", () => {
    const ts = new Date(Date.now() - 89_000).toISOString();
    expect(isStale(ts, 90)).toBe(false);
  });

  it("91s ago + threshold 90s → stale", () => {
    const ts = new Date(Date.now() - 91_000).toISOString();
    expect(isStale(ts, 90)).toBe(true);
  });

  it("threshold 0 + any non-now timestamp → stale", () => {
    const ts = new Date(Date.now() - 1).toISOString();
    expect(isStale(ts, 0)).toBe(true);
  });
});
