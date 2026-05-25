/**
 * Cycle 39 Phase 2 — Bulk Availabilities orchestrator.
 *
 * Iterates a set of internal IAP UUIDs and flips each one's Apple-side
 * availability to either ALL territories or "Remove from Sales", reusing
 * the Phase 1 Apple helpers + audit action types so dashboards stay in
 * sync with single-item edits.
 *
 * Discipline mirrors the §4.4 multi-stage pattern + Q-K fail-soft:
 *   • One Apple POST per IAP via withConcurrency<T,R> — Cycle 40 Phase A
 *     dropped from 5 → 2 to align with Hotfix 26 Bulk Import (Apple
 *     ASC ~1 req/sec hourly budget protection).
 *   • Per-IAP try/catch — a single failure never cancels siblings.
 *   • One actions_log row per IAP (success or error severity).
 *   • Aggregate roll-up returned to the API route so the modal can render
 *     per-row + summary in the same response.
 *
 * Cycle 40 Phase A — Apple calls now wrap in `withRetry` so 429s honour
 * Retry-After + exponential backoff (matches Hotfix 26 Bulk Import). The
 * `onRetry` hook mutates a per-row RetryCounters bag so the audit row
 * captures 429 telemetry (rate429_count, retry_attempts, backoff_total_ms,
 * longest_backoff_ms) and the modal renders an amber summary chip when
 * Apple throttled the batch. Before Phase A the orchestrator called Apple
 * with bare `iapFetch`: every 429 surfaced as a per-row error with no
 * retry attempt, which is the gap Manager surfaced post-Hotfix-26.
 *
 * Input is internal `iap_mgmt.iaps.id` rows; the orchestrator resolves
 * each row's `apple_iap_id` before calling Apple. Rows without an
 * apple_iap_id are surfaced as per-row failures (caller may filter local
 * drafts upstream, but the orchestrator is defensive about it).
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import { iapDb } from "@/lib/iap-management/db";
import {
  setAvailabilityToAllTerritories,
  setAvailabilityRemoveFromSales,
} from "@/lib/iap-management/apple/availabilities";
import { withRetry } from "@/lib/iap-management/apple/fetch";

export type BulkAvailabilityAction = "set-all" | "remove";

/**
 * Cycle 40 Phase A — Apple ASC ~1 req/sec hourly budget. Concurrency 2
 * matches Hotfix 26 Bulk Import (verified safe under empirical Manager
 * workloads). Was 5 in Cycle 39 Phase 2; Phase A dropped to align cross-
 * flow.
 */
const DEFAULT_CONCURRENCY = 2;

export interface BulkAvailabilityArgs {
  creds: AscCredentials;
  /** Internal `iap_mgmt.iaps.id` rows targeted by Manager's selection. */
  iapIds: readonly string[];
  action: BulkAvailabilityAction;
  /** Email or session identifier captured into actions_log.actor. */
  actor: string;
  /** Concurrency ceiling — defaults to DEFAULT_CONCURRENCY (Phase A: 2). */
  concurrency?: number;
}

/**
 * Cycle 40 Phase A — per-row Apple 429 telemetry. Shape mirrors the
 * Hotfix 26 Bulk Import counters so audit + UI surfaces stay consistent
 * cross-flow and a future Phase B universal refactor can hoist this to
 * a shared module without churn.
 */
export interface RetryCounters {
  rate429_count: number;
  retry_attempts: number;
  backoff_total_ms: number;
  longest_backoff_ms: number;
}

function createRetryCounters(): RetryCounters {
  return {
    rate429_count: 0,
    retry_attempts: 0,
    backoff_total_ms: 0,
    longest_backoff_ms: 0,
  };
}

/**
 * Thin wrapper around `withRetry` that mutates a counters bag in place
 * each time the 429 backoff path fires. Pass the SAME counters instance
 * through every Apple call in a single row's orchestration so the
 * per-row audit captures cumulative retry impact. Mirrors the Hotfix 26
 * Bulk Import helper of the same shape.
 */
function trackedWithRetry<T>(
  counters: RetryCounters,
  fn: () => Promise<T>,
): Promise<T> {
  return withRetry(fn, {
    onRetry: ({ delayMs }) => {
      counters.rate429_count += 1;
      counters.retry_attempts += 1;
      counters.backoff_total_ms += delayMs;
      if (delayMs > counters.longest_backoff_ms) {
        counters.longest_backoff_ms = delayMs;
      }
    },
  });
}

export interface BulkAvailabilityRowResult {
  iapId: string;
  apple_iap_id?: string;
  ok: boolean;
  /** Apple's availability resource id after a successful POST. */
  apple_availability_id?: string;
  error?: string;
  /** Cycle 40 Phase A — per-row 429 telemetry. Absent on rows that never
   *  touched Apple (local-draft surfaced as per-row failure before the
   *  Apple call); zeroes when Apple responded without 429. */
  rate_limit?: RetryCounters;
}

export interface BulkAvailabilityOutcome {
  action: BulkAvailabilityAction;
  total: number;
  succeeded: number;
  failed: number;
  /** Per-IAP results in input order. */
  results: BulkAvailabilityRowResult[];
  /** Convenience roll-up for the API response. */
  overall: "SUCCESS" | "PARTIAL" | "FAILURE" | "NO_OP";
  summary: string;
  /** Cycle 40 Phase A — batch-level 429 telemetry roll-up so the modal
   *  renders a single amber chip without iterating per-row counters.
   *  Mirrors Hotfix 26 Bulk Import shape. */
  rate_limit_total: RetryCounters & { rows_throttled: number };
}

export async function executeBulkAvailability(
  args: BulkAvailabilityArgs,
): Promise<BulkAvailabilityOutcome> {
  const { creds, iapIds, action, actor, concurrency = DEFAULT_CONCURRENCY } = args;

  if (iapIds.length === 0) {
    return {
      action,
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      overall: "NO_OP",
      summary: "No IAPs selected.",
      rate_limit_total: { ...createRetryCounters(), rows_throttled: 0 },
    };
  }

  console.log(
    `[bulk-availability] start action=${action} count=${iapIds.length} actor=${actor} concurrency=${concurrency}`,
  );

  // Resolve apple_iap_id once up front so the per-row work is just the
  // Apple POST + audit insert. One DB round-trip beats N individual reads
  // inside the workers.
  const appleIdByRow = await resolveAppleIapIds(iapIds);

  const action_type =
    action === "set-all"
      ? "AVAILABILITY_SET_ALL_TERRITORIES"
      : "AVAILABILITY_REMOVE_FROM_SALES";

  const results = await withConcurrency<string, BulkAvailabilityRowResult>(
    iapIds,
    concurrency,
    async (iapId) => {
      const appleIapId = appleIdByRow.get(iapId);
      if (!appleIapId) {
        const error =
          "IAP not synced to Apple — local draft. Run Create on Apple first.";
        await writeAuditRow(actor, iapId, action_type, {
          result: "ERROR",
          error,
          target: action === "set-all" ? "ALL" : "NONE",
        });
        return { iapId, ok: false, error };
      }
      const counters = createRetryCounters();
      try {
        const res = await trackedWithRetry(counters, () =>
          action === "set-all"
            ? setAvailabilityToAllTerritories(creds, appleIapId)
            : setAvailabilityRemoveFromSales(creds, appleIapId),
        );
        const apple_availability_id = res.data?.id;
        await writeAuditRow(actor, iapId, action_type, {
          apple_iap_id: appleIapId,
          result: "SUCCESS",
          target: action === "set-all" ? "ALL" : "NONE",
          ...(apple_availability_id ? { apple_availability_id } : {}),
          source: "bulk",
          rate_limit: counters,
        });
        return {
          iapId,
          apple_iap_id: appleIapId,
          ok: true,
          ...(apple_availability_id ? { apple_availability_id } : {}),
          rate_limit: counters,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await writeAuditRow(actor, iapId, action_type, {
          apple_iap_id: appleIapId,
          result: "ERROR",
          target: action === "set-all" ? "ALL" : "NONE",
          source: "bulk",
          error,
          rate_limit: counters,
        });
        return {
          iapId,
          apple_iap_id: appleIapId,
          ok: false,
          error,
          rate_limit: counters,
        };
      }
    },
  );

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const overall: BulkAvailabilityOutcome["overall"] =
    succeeded === results.length
      ? "SUCCESS"
      : succeeded === 0
        ? "FAILURE"
        : "PARTIAL";
  const summary = `${succeeded}/${results.length} succeeded${
    failed > 0 ? ` · ${failed} failed` : ""
  }`;

  const rate_limit_total = results.reduce(
    (acc, r) => {
      const rl = r.rate_limit;
      if (!rl) return acc;
      acc.rate429_count += rl.rate429_count;
      acc.retry_attempts += rl.retry_attempts;
      acc.backoff_total_ms += rl.backoff_total_ms;
      if (rl.longest_backoff_ms > acc.longest_backoff_ms) {
        acc.longest_backoff_ms = rl.longest_backoff_ms;
      }
      if (rl.rate429_count > 0) acc.rows_throttled += 1;
      return acc;
    },
    { ...createRetryCounters(), rows_throttled: 0 },
  );

  console.log(
    `[bulk-availability] complete action=${action} overall=${overall} ${summary} throttled=${rate_limit_total.rows_throttled}/${results.length} retries=${rate_limit_total.rate429_count} backoff=${rate_limit_total.backoff_total_ms}ms`,
  );

  return {
    action,
    total: results.length,
    succeeded,
    failed,
    results,
    overall,
    summary,
    rate_limit_total,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveAppleIapIds(
  iapIds: readonly string[],
): Promise<Map<string, string>> {
  const db = iapDb();
  const { data, error } = await db
    .from("iaps")
    .select("id, apple_iap_id")
    .in("id", iapIds as string[]);
  const out = new Map<string, string>();
  if (error || !data) return out;
  for (const row of data as Array<{ id: string; apple_iap_id: string | null }>) {
    if (row.apple_iap_id) out.set(row.id, row.apple_iap_id);
  }
  return out;
}

async function writeAuditRow(
  actor: string,
  iapId: string,
  action_type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await iapDb().from("actions_log").insert({
      iap_id: iapId,
      actor,
      action_type,
      payload,
    });
    if (error) {
      console.error(
        `[bulk-availability] audit insert error iap=${iapId} action=${action_type}: ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[bulk-availability] audit insert threw iap=${iapId} action=${action_type}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
