/**
 * Guards the T1-1/T1-2 shim's fallback behavior (review 2026-07-27, review
 * follow-up): when React's request-scoped `cache()` is missing, the module must
 * fall back to identity LOUDLY at a real runtime and quietly only under tests —
 * a silent no-op would turn off the dedupe with nobody noticing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/logger");
});

describe("requestScopedCache fallback loudness", () => {
  it("WARNs (does not silently no-op) when React cache() is missing outside tests", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("react", () => ({ cache: undefined })); // client-style build: cache absent
    const logSpy = vi.fn();
    vi.doMock("@/lib/logger", () => ({ log: logSpy }));

    const mod = await import("@/lib/react-request-cache");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "react-request-cache",
      expect.stringContaining("dedupe DISABLED"),
      "WARN",
    );
    // Still degrades safely to identity — never crashes the import.
    const fn = async (x: number) => x;
    expect(mod.requestScopedCache(fn)).toBe(fn);
  });

  it("stays silent under NODE_ENV=test (the expected fallback)", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.doMock("react", () => ({ cache: undefined }));
    const logSpy = vi.fn();
    vi.doMock("@/lib/logger", () => ({ log: logSpy }));

    await import("@/lib/react-request-cache");

    expect(logSpy).not.toHaveBeenCalled();
  });
});
