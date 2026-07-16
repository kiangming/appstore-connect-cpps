/**
 * lib/google-iap-management/hub-tracking/hub-client.ts — Server-side only.
 *
 * Thin REST client for the VNGGames Hub run-tracking API
 * (docs/integrate-rest-vnggames-hub.md). Identical implementation to
 * lib/iap-management/hub-tracking/hub-client.ts (Apple) — every call is
 * wrapped in a REAL AbortController + setTimeout hard abort (mirrors
 * lib/google-iap-management/client/refresh-fetch.ts's fetchWithTimeout) —
 * a hung Hub call is aborted at HUB_TIMEOUT_MS regardless of what the
 * network is doing, so it can never hang the caller (bulk-import execute,
 * the wizard's step transition, or a Settings save).
 *
 * `hubFetch` never throws — it returns a discriminated result so callers
 * can log-and-swallow (hubStartRun/hubCloseRun) or distinguish a rejected
 * credential from a network blip (hubValidateCredentials). `timeoutMs` and
 * `fetchImpl` are injectable for tests only; production call sites never
 * override them.
 */

import { log } from "@/lib/logger";

export type HubTerminalStatus = "SUCCESS" | "FAILED" | "CANCELLED" | "PARTIAL";

/** Hard ceiling — genuinely aborts the in-flight request, not a soft option. */
export const HUB_TIMEOUT_MS = 3000;

export const HUB_API_BASE = "https://workflowhub-api.vnggames.net/api/v1";

type HubFetchResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; kind: "timeout" | "network" | "http"; status?: number; detail: string };

async function hubFetch(
  path: string,
  init: { method: string; token: string; body?: unknown },
  timeoutMs: number = HUB_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<HubFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${HUB_API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, kind: "http", status: res.status, detail: text.slice(0, 300) };
    }
    const json = await res.json().catch(() => null);
    return { ok: true, status: res.status, json };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: isAbort ? "timeout" : "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Distinguishes Railway log lines from Apple's own hub-tracking module —
 *  the [hub-tracking] message prefix stays identical, only the log()
 *  feature tag differs. */
const LOG_FEATURE = "google-iap-hub-tracking";

/** Formats a failed HubFetchResult into the ATTEMPT/OUTCOME log vocabulary
 *  the Manager asked for: TIMEOUT(3s) | FAILED <status> | ERROR <msg>. */
function describeFailure(res: Extract<HubFetchResult, { ok: false }>): string {
  if (res.kind === "timeout") return `TIMEOUT (${HUB_TIMEOUT_MS / 1000}s)`;
  if (res.kind === "http") return `FAILED ${res.status}`;
  return `ERROR ${res.detail}`;
}

/** POST /runs/start — best-effort. Never throws; null means "no run opened"
 *  (config absent/disabled is filtered out before this is called; here it's
 *  timeout/network/http failure). Logs ATTEMPT before the call and the
 *  OUTCOME after — a hung call shows as ATTEMPT with no OUTCOME in Railway
 *  logs, distinguishing it from a fast no-op. Never logs the token. */
export async function hubStartRun(
  args: { workflowId: string; token: string; actor?: string },
  timeoutMs?: number,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  await log(
    LOG_FEATURE,
    `[hub-tracking] start: POST /runs/start workflow_id=${args.workflowId} → ATTEMPT`,
  );
  const startedAt = Date.now();
  const res = await hubFetch(
    "/runs/start",
    {
      method: "POST",
      token: args.token,
      body: { workflow_id: args.workflowId, ...(args.actor ? { actor: args.actor } : {}) },
    },
    timeoutMs,
    fetchImpl,
  );
  const elapsedMs = Date.now() - startedAt;
  if (!res.ok) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] start: POST /runs/start workflow_id=${args.workflowId} → ${describeFailure(res)} (${elapsedMs}ms)`,
      "WARN",
    );
    return null;
  }
  const runId = (res.json as { id?: unknown } | null)?.id;
  if (typeof runId !== "string" || runId.length === 0) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] start: POST /runs/start workflow_id=${args.workflowId} → ERROR response missing id (${elapsedMs}ms)`,
      "WARN",
    );
    return null;
  }
  await log(
    LOG_FEATURE,
    `[hub-tracking] start: POST /runs/start workflow_id=${args.workflowId} → SUCCESS run_id=${runId} (${elapsedMs}ms)`,
  );
  return runId;
}

/** PATCH /runs/:id — best-effort. Never throws. Used for both the execute
 *  route's terminal close and the explicit/beforeunload cancel path (the
 *  `status` field in the log line distinguishes them). Logs ATTEMPT before
 *  the call and the OUTCOME after; never logs the token. */
export async function hubCloseRun(
  args: { token: string; runId: string; status: HubTerminalStatus; errorMessage?: string },
  timeoutMs?: number,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await log(
    LOG_FEATURE,
    `[hub-tracking] finalize: PATCH /runs/${args.runId} status=${args.status} → ATTEMPT`,
  );
  const startedAt = Date.now();
  const res = await hubFetch(
    `/runs/${args.runId}`,
    {
      method: "PATCH",
      token: args.token,
      body: {
        status: args.status,
        ...(args.errorMessage ? { error_message: args.errorMessage } : {}),
      },
    },
    timeoutMs,
    fetchImpl,
  );
  const elapsedMs = Date.now() - startedAt;
  if (!res.ok) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] finalize: PATCH /runs/${args.runId} status=${args.status} → ${describeFailure(res)} (${elapsedMs}ms)`,
      "WARN",
    );
    return;
  }
  await log(
    LOG_FEATURE,
    `[hub-tracking] finalize: PATCH /runs/${args.runId} status=${args.status} → SUCCESS (${elapsedMs}ms)`,
  );
}

export type HubValidationResult =
  | { ok: true }
  | { ok: false; reason: "rejected" | "network-error"; detail?: string };

/**
 * Settings save-time validation ONLY — opens a throwaway run and
 * immediately closes it CANCELLED, to surface a bad/unregistered
 * workflow_id's 422 (or a bad token's 401) to the admin right away. This
 * is a WARNING signal for the caller to show, never a save-blocker: a
 * rejected credential still returns a result (the caller decides what to
 * do), and a network/timeout failure is distinguished from an actual
 * rejection so the caller can say "couldn't verify" instead of "invalid".
 */
export async function hubValidateCredentials(
  args: { workflowId: string; token: string },
  timeoutMs?: number,
  fetchImpl?: typeof fetch,
): Promise<HubValidationResult> {
  const startRes = await hubFetch(
    "/runs/start",
    { method: "POST", token: args.token, body: { workflow_id: args.workflowId } },
    timeoutMs,
    fetchImpl,
  );
  if (!startRes.ok) {
    if (startRes.kind === "http") {
      return { ok: false, reason: "rejected", detail: startRes.detail };
    }
    return { ok: false, reason: "network-error", detail: startRes.detail };
  }

  const runId = (startRes.json as { id?: unknown } | null)?.id;
  if (typeof runId === "string" && runId.length > 0) {
    // Best-effort cleanup — a failure here must not change the verdict.
    await hubCloseRun(
      { token: args.token, runId, status: "CANCELLED" },
      timeoutMs,
      fetchImpl,
    );
  }
  return { ok: true };
}
