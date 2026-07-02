import { describe, it, expect, vi } from "vitest";
import {
  fetchWithTimeout,
  describeRefreshError,
  RefreshTimeoutError,
  REFRESH_TIMEOUT_MS,
} from "./refresh-fetch";

describe("fetchWithTimeout", () => {
  it("resolves normally when the fetch completes before the timeout", async () => {
    const ok = new Response("{}", { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValue(ok);
    const res = await fetchWithTimeout("/x", { method: "POST" }, 1000, fetchImpl);
    expect(res).toBe(ok);
    // Signal was threaded through.
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts and throws RefreshTimeoutError when the fetch outruns the timeout", async () => {
    // fetch that rejects with an AbortError once its signal fires.
    const fetchImpl = (_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });

    await expect(
      fetchWithTimeout("/x", { method: "POST" }, 10, fetchImpl as typeof fetch),
    ).rejects.toBeInstanceOf(RefreshTimeoutError);
  });

  it("propagates non-abort errors unchanged", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("DNS boom"));
    await expect(
      fetchWithTimeout("/x", {}, 1000, fetchImpl),
    ).rejects.toThrow("DNS boom");
  });
});

describe("describeRefreshError", () => {
  it("renders a clear, actionable message for a timeout", () => {
    const msg = describeRefreshError(new RefreshTimeoutError(120_000));
    expect(msg).toContain("timed out after 120s");
    expect(msg).toMatch(/try again/i);
  });

  it("passes through a normal Error message", () => {
    expect(describeRefreshError(new Error("HTTP 500"))).toBe("HTTP 500");
  });

  it("falls back to a generic message for unknown throwables", () => {
    expect(describeRefreshError("weird")).toBe("Network error");
  });

  it("default ceiling is a sane bound", () => {
    expect(REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
