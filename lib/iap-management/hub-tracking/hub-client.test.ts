import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ log }));

import {
  hubStartRun,
  hubCloseRun,
  hubValidateCredentials,
  HUB_TIMEOUT_MS,
  HUB_API_BASE,
} from "./hub-client";

function hangingFetchImpl() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): unknown {
  const init = fetchImpl.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("hub-client", () => {
  beforeEach(() => {
    log.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("hard timeout — the load-bearing non-blocking guarantee", () => {
    it("HUB_TIMEOUT_MS pins the documented hard ceiling at 3000ms", () => {
      expect(HUB_TIMEOUT_MS).toBe(3000);
    });

    it("aborts a hanging call at a short injected timeout and resolves null promptly", async () => {
      const fetchImpl = hangingFetchImpl();
      const startedAt = Date.now();
      const result = await hubStartRun({ workflowId: "wf", token: "tok" }, 15, fetchImpl);
      expect(result).toBeNull();
      // Resolved near the 15ms ceiling, not hung indefinitely.
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it("genuinely aborts at the REAL 3000ms default when no override is passed", async () => {
      vi.useFakeTimers();
      let signalSeen: AbortSignal | undefined;
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signalSeen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      });
      vi.stubGlobal("fetch", fetchImpl);

      // No timeoutMs/fetchImpl override — exercises the production default
      // path exactly as the start/execute/cancel routes call it.
      const pending = hubStartRun({ workflowId: "wf", token: "tok" });

      await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS - 1);
      expect(signalSeen?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signalSeen?.aborted).toBe(true);

      const result = await pending;
      expect(result).toBeNull();
    });
  });

  describe("hubStartRun", () => {
    it("returns the run id on success and sends workflow_id + actor", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(201, { id: "run-123" }));
      const result = await hubStartRun(
        { workflowId: "wf", token: "tok", actor: "a@b.com" },
        1000,
        fetchImpl,
      );
      expect(result).toBe("run-123");
      expect(fetchImpl).toHaveBeenCalledWith(
        `${HUB_API_BASE}/runs/start`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        }),
      );
      expect(bodyOf(fetchImpl)).toEqual({ workflow_id: "wf", actor: "a@b.com" });
    });

    it("omits actor when not given", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(201, { id: "run-1" }));
      await hubStartRun({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(bodyOf(fetchImpl)).toEqual({ workflow_id: "wf" });
    });

    it("returns null (never throws) on a rejected 422 response", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(422, { error: "unregistered" }));
      const result = await hubStartRun({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(result).toBeNull();
    });

    it("returns null (never throws) on a network error", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNRESET");
      });
      const result = await hubStartRun({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(result).toBeNull();
    });

    it("returns null when the success response is missing an id", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(201, {}));
      const result = await hubStartRun({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(result).toBeNull();
    });
  });

  describe("hubCloseRun", () => {
    it("PATCHes the run with the terminal status", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      await hubCloseRun(
        { token: "tok", runId: "run-1", status: "SUCCESS" },
        1000,
        fetchImpl,
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        `${HUB_API_BASE}/runs/run-1`,
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(bodyOf(fetchImpl)).toEqual({ status: "SUCCESS" });
    });

    it("includes error_message when given (FAILED)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      await hubCloseRun(
        { token: "tok", runId: "run-1", status: "FAILED", errorMessage: "boom" },
        1000,
        fetchImpl,
      );
      expect(bodyOf(fetchImpl)).toEqual({ status: "FAILED", error_message: "boom" });
    });

    it("never throws even when Hub returns an error", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "boom" }));
      await expect(
        hubCloseRun({ token: "tok", runId: "run-1", status: "CANCELLED" }, 1000, fetchImpl),
      ).resolves.toBeUndefined();
    });

    it("never throws on a network/timeout failure", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      });
      await expect(
        hubCloseRun({ token: "tok", runId: "run-1", status: "PARTIAL" }, 1000, fetchImpl),
      ).resolves.toBeUndefined();
    });
  });

  describe("hubValidateCredentials — Settings save-time check", () => {
    it("returns reason:rejected on an HTTP rejection (422 unregistered workflow_id)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(422, { error: "unregistered" }));
      const result = await hubValidateCredentials({ workflowId: "bad", token: "tok" }, 1000, fetchImpl);
      expect(result).toEqual({ ok: false, reason: "rejected", detail: expect.any(String) });
    });

    it("returns reason:rejected on a 401 (bad token)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
      const result = await hubValidateCredentials({ workflowId: "wf", token: "bad" }, 1000, fetchImpl);
      expect(result).toEqual({ ok: false, reason: "rejected", detail: expect.any(String) });
    });

    it("returns reason:network-error on a network/timeout failure — distinct from rejected, never blocks save", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      });
      const result = await hubValidateCredentials({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(result).toEqual({ ok: false, reason: "network-error", detail: expect.any(String) });
    });

    it("on success, opens then immediately closes (CANCELLED) the throwaway run", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(201, { id: "run-throwaway" }))
        .mockResolvedValueOnce(jsonResponse(200, {}));
      const result = await hubValidateCredentials({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(result).toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1][0]).toBe(`${HUB_API_BASE}/runs/run-throwaway`);
      expect(bodyOf(fetchImpl, 1)).toEqual({ status: "CANCELLED" });
    });

    it("still returns ok:true when the cleanup close fails (verdict isn't affected by cleanup)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(201, { id: "run-throwaway" }))
        .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
      const result = await hubValidateCredentials({ workflowId: "wf", token: "tok" }, 1000, fetchImpl);
      expect(result).toEqual({ ok: true });
    });
  });

  describe("Railway logging — [hub-tracking] ATTEMPT/OUTCOME, token never logged", () => {
    function loggedMessages(): string[] {
      return log.mock.calls.map((c) => String(c[1]));
    }

    it("hubStartRun success logs ATTEMPT then SUCCESS with workflow_id + run_id", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(201, { id: "run-abc" }));
      await hubStartRun({ workflowId: "wf-1", token: "super-secret-token", actor: "a@b.com" }, 1000, fetchImpl);

      const messages = loggedMessages();
      expect(messages).toEqual([
        "[hub-tracking] start: POST /runs/start workflow_id=wf-1 → ATTEMPT",
        expect.stringMatching(/^\[hub-tracking] start: POST \/runs\/start workflow_id=wf-1 → SUCCESS run_id=run-abc \(\d+ms\)$/),
      ]);
      expect(messages.join("\n")).not.toContain("super-secret-token");
    });

    it("hubStartRun timeout logs ATTEMPT then TIMEOUT (3s)", async () => {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      });
      await hubStartRun({ workflowId: "wf-2", token: "another-secret" }, 15, fetchImpl);

      const messages = loggedMessages();
      expect(messages[0]).toBe("[hub-tracking] start: POST /runs/start workflow_id=wf-2 → ATTEMPT");
      expect(messages[1]).toMatch(/→ TIMEOUT \(3s\) \(\d+ms\)$/);
      expect(messages.join("\n")).not.toContain("another-secret");
    });

    it("hubStartRun HTTP rejection logs ATTEMPT then FAILED <status>", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(422, { error: "unregistered" }));
      await hubStartRun({ workflowId: "wf-3", token: "tok-3" }, 1000, fetchImpl);

      const messages = loggedMessages();
      expect(messages[1]).toMatch(/→ FAILED 422 \(\d+ms\)$/);
    });

    it("hubCloseRun success logs ATTEMPT then SUCCESS with the run's status", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      await hubCloseRun({ token: "close-secret", runId: "run-9", status: "SUCCESS" }, 1000, fetchImpl);

      const messages = loggedMessages();
      expect(messages).toEqual([
        "[hub-tracking] finalize: PATCH /runs/run-9 status=SUCCESS → ATTEMPT",
        expect.stringMatching(/^\[hub-tracking] finalize: PATCH \/runs\/run-9 status=SUCCESS → SUCCESS \(\d+ms\)$/),
      ]);
      expect(messages.join("\n")).not.toContain("close-secret");
    });

    it("hubCloseRun for a CANCELLED close logs status=CANCELLED (distinguishes cancel from a real completion)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
      await hubCloseRun({ token: "tok", runId: "run-10", status: "CANCELLED" }, 1000, fetchImpl);

      const messages = loggedMessages();
      expect(messages.some((m) => m.includes("status=CANCELLED"))).toBe(true);
    });

    it("the token never appears in ANY log line across start/close/validate", async () => {
      const secretToken = "sekrit-token-xyz-999";
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(201, { id: "run-x" }))
        .mockResolvedValueOnce(jsonResponse(200, {}))
        .mockResolvedValueOnce(jsonResponse(201, { id: "run-y" }))
        .mockResolvedValueOnce(jsonResponse(200, {}));

      await hubStartRun({ workflowId: "wf", token: secretToken }, 1000, fetchImpl);
      await hubCloseRun({ token: secretToken, runId: "run-x", status: "SUCCESS" }, 1000, fetchImpl);
      await hubValidateCredentials({ workflowId: "wf", token: secretToken }, 1000, fetchImpl);

      const allMessages = loggedMessages().join("\n");
      expect(allMessages).not.toContain(secretToken);
    });
  });
});
