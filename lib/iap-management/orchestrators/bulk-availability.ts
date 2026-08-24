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
 *
 * Per-territory availability — STOP AND PRESERVE (Manager decision 3).
 * Fail-soft still governs ordinary failures, but rate-limit exhaustion is
 * different in kind: it predicts that every subsequent call will also
 * fail, so the run stops and reports the untouched remainder instead of
 * spending the rest of the budget discovering the same thing 85 more
 * times. Three row states result — SUCCESS / FAILED / NOT_ATTEMPTED —
 * and only the last is safe to resume blindly, because nothing was sent
 * and no audit row was written for it.
 *
 * ⚠ NOTHING HERE DEPENDS ON APPLE'S HOURLY CAP. That number is
 * unresolved (KB §4.9 — Hotfix 25 says 250/h, Hotfix 26 says ~3,600/h).
 * The orchestrator does not pre-compute budgets or pace itself against a
 * guessed ceiling; it reacts to `AppleRateLimitError` after `withRetry`
 * has exhausted the backoff curve, which is true regardless of which
 * figure is right.
 *
 * ⚠ THROTTLE — this orchestrator shares Hotfix 26's CONCURRENCY NUMBER
 * (2) but NOT its implementation: the 1s `INTER_ROW_DELAY_MS` lives only
 * in `bulk-import/execute/route.ts` and is a separate constant in a
 * separate module. Nothing in this file can speed that throttle up, and
 * nothing here should grow its own copy of it.
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { runStoppablePool } from "@/lib/iap-management/stoppable-pool";
import { iapDb } from "@/lib/iap-management/db";
import {
  getAllTerritoryIds,
  setAvailabilityTerritories,
} from "@/lib/iap-management/apple/availabilities";
import {
  allTerritoriesSelection,
  noTerritoriesSelection,
  type TerritorySelection,
} from "@/lib/iap-management/apple/territory-selection";
import {
  availabilityActionType,
  availabilityAuditProvenance,
  type PreviousAvailability,
} from "@/lib/iap-management/apple/availability-audit";
import {
  withRetry,
  AppleRateLimitError,
} from "@/lib/iap-management/apple/fetch";
import type { IapActionType } from "@/lib/iap-management/action-types";

/**
 * `set-territories` (per-territory availability) carries an explicit
 * selection; the other two are presets the orchestrator expands itself.
 * This is the Manager's UI MODE — it is NOT the audit action type, which
 * is derived from what was actually sent (P5, see availability-audit.ts).
 */
export type BulkAvailabilityAction = "set-all" | "remove" | "set-territories";

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
  /**
   * Required when `action === "set-territories"`, ignored otherwise. The
   * territory ids are Apple's, passed straight through — see
   * `setAvailabilityTerritories`.
   */
  selection?: TerritorySelection;
  /** Email or session identifier captured into actions_log.actor. */
  actor: string;
  /** Concurrency ceiling — defaults to DEFAULT_CONCURRENCY (Phase A: 2). */
  concurrency?: number;
  /**
   * What the caller already knew about each item's availability, keyed by
   * internal IAP id. Surface A's modal reads every listed item on open
   * (client queue, concurrency 3) so this costs no extra Apple calls; it
   * exists purely so the audit row can state what changed.
   *
   * ⚠ Absent or missing entries are recorded as `previous_known: false`,
   * never backfilled with a plausible number. The orchestrator does NOT
   * read Apple to fill this in — a second read per item to decorate an
   * audit row would be the wrong trade against the rate-limit budget.
   */
  previousByIapId?: Readonly<Record<string, PreviousAvailability | null>>;
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

/**
 * Three states, deliberately not two.
 *
 *   SUCCESS       — Apple accepted the write. Never resend: a re-POST is a
 *                   full replace, so re-running a success is a real Apple
 *                   write, not a harmless no-op.
 *   FAILED        — we called Apple (or refused to, for a local draft) and
 *                   it did not work. Resuming needs a human to read WHY.
 *   NOT_ATTEMPTED — the run stopped before this item's turn. Nothing was
 *                   sent, nothing was logged. This is the ONLY state that
 *                   is safe to resume blindly, which is exactly why it must
 *                   not be folded into FAILED.
 */
export type BulkAvailabilityRowStatus =
  | "SUCCESS"
  | "FAILED"
  | "NOT_ATTEMPTED";

/** Why a row failed, so the UI can speak per-case rather than per-summary. */
export type BulkAvailabilityFailureKind =
  | "NOT_SYNCED"
  | "RATE_LIMITED"
  | "APPLE_REJECTED";

export interface BulkAvailabilityRowResult {
  iapId: string;
  apple_iap_id?: string;
  ok: boolean;
  status: BulkAvailabilityRowStatus;
  /** Present on FAILED rows only. Drives per-case copy, not a generic list. */
  failure_kind?: BulkAvailabilityFailureKind;
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
  /** Items the run never got to. `remainder` carries their ids. */
  not_attempted: number;
  /** Per-IAP results in input order. */
  results: BulkAvailabilityRowResult[];
  /**
   * The unprocessed remainder, in input order — Manager decision 3.
   * Feed this straight back as `iapIds` with the SAME selection to resume.
   * Successful and failed rows are absent by construction, so a resume can
   * never re-send a success.
   */
  remainder: string[];
  /** Convenience roll-up for the API response. */
  overall:
    | "SUCCESS"
    | "PARTIAL"
    | "FAILURE"
    | "NO_OP"
    | "STOPPED_RATE_LIMITED";
  /**
   * Set when the run stopped early. Distinct from `overall` because a
   * stopped run may still have succeeded on most of its items — the status
   * has to reflect what really happened, not the worst thing that happened
   * (P5).
   */
  stopped_reason?: "RATE_LIMIT";
  summary: string;
  /** Cycle 40 Phase A — batch-level 429 telemetry roll-up so the modal
   *  renders a single amber chip without iterating per-row counters.
   *  Mirrors Hotfix 26 Bulk Import shape. */
  rate_limit_total: RetryCounters & { rows_throttled: number };
}

export async function executeBulkAvailability(
  args: BulkAvailabilityArgs,
): Promise<BulkAvailabilityOutcome> {
  const {
    creds,
    iapIds,
    action,
    actor,
    concurrency = DEFAULT_CONCURRENCY,
    previousByIapId,
  } = args;

  if (iapIds.length === 0) {
    return {
      action,
      total: 0,
      succeeded: 0,
      failed: 0,
      not_attempted: 0,
      results: [],
      remainder: [],
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

  // ── Resolve ONE selection for the whole batch ─────────────────────────
  // Every item gets exactly the same territories (Manager decision 1:
  // replace, no per-row variation). Building it once here means the
  // per-row work is just the Apple POST + the audit insert.
  //
  // `getAllTerritoryIds` is the per-process 1h cache, so this is at most
  // one extra Apple call per batch — and "remove" skips it entirely since
  // an empty selection can never be ALL.
  let selection: TerritorySelection;
  let catalogue: readonly string[] = [];
  if (action === "remove") {
    selection = noTerritoriesSelection();
  } else if (action === "set-all") {
    catalogue = await getAllTerritoryIds(creds);
    selection = allTerritoriesSelection(catalogue);
  } else {
    if (!args.selection) {
      throw new Error(
        'executeBulkAvailability: action "set-territories" requires a selection',
      );
    }
    selection = args.selection;
    // Needed to tell ALL from ALL_FROZEN/SUBSET when labelling the audit
    // row — the flag is not derivable from the list (KB §4.13).
    catalogue = await getAllTerritoryIds(creds);
  }

  // ⚠ Derived from what will actually be SENT, never from `action`
  // (P5 status principle). "set-territories" covering every territory with
  // the forward flag on is genuinely an "all" write and is labelled as one.
  const action_type = availabilityActionType(selection, catalogue);

  /**
   * ⚠ THE STOP LATCH (Manager decision 3) now lives in `runStoppablePool`,
   * which owns all three of its rules — checked before any I/O, settable
   * only by `shouldStop`, in-flight rows finish and are recorded honestly.
   * This file supplies the three Apple-specific pieces and nothing else:
   *
   *   shouldStop  — ONLY rate-limit exhaustion. A rejected territory or a
   *                 state guard on row 3 says nothing about row 4, so those
   *                 stay fail-soft (Q-K). An exhausted budget is the one
   *                 failure that predicts the next call fails too, and
   *                 burning the rest to prove it is what we are avoiding.
   *   skipped     — the NOT_ATTEMPTED row: no Apple call, no audit row, so
   *                 it is safe to resume blindly.
   *   onError     — the audit row + failure_kind for a row that WAS sent.
   *
   * The extraction is a parity move: behaviour is byte-for-byte what
   * `withConcurrency` + a local boolean did before, and the 37 existing
   * tests are the gate that says so.
   *
   * ⚠ `counters` is per-row telemetry mutated in place by `trackedWithRetry`
   * during `run`, and the FAILED row must carry it. `run` and `onError` are
   * separate callbacks now, so it is parked here keyed by row rather than
   * closed over — same values, same rows, just reachable from both halves.
   */
  const countersByIap = new Map<string, RetryCounters>();

  // ⚠ `stopped` is the pool's own latch state, not a re-derivation from the
  //    rows. Inferring it from "any row is NOT_ATTEMPTED" would be a second
  //    source of the same truth, free to drift.
  const { results, stopped: stoppedByRateLimit } =
    await runStoppablePool<string, BulkAvailabilityRowResult>({
    items: iapIds,
    concurrency,
    shouldStop: (err) => err instanceof AppleRateLimitError,
    skipped: (iapId) => ({ iapId, ok: false, status: "NOT_ATTEMPTED" }),
    run: async (iapId) => {
      const appleIapId = appleIdByRow.get(iapId);
      if (!appleIapId) {
        const error =
          "IAP not synced to Apple — local draft. Run Create on Apple first.";
        await writeAuditRow(actor, iapId, action_type, {
          result: "ERROR",
          error,
          ...availabilityAuditProvenance(selection, previousByIapId?.[iapId]),
        });
        return {
          iapId,
          ok: false,
          status: "FAILED",
          failure_kind: "NOT_SYNCED",
          error,
        };
      }
      const counters = createRetryCounters();
      countersByIap.set(iapId, counters);
      {
        // ⚠ EXACTLY ONE withRetry, over a retry-naive leaf.
        // `setAvailabilityTerritories` → `iapFetch`, which throws
        // AppleRateLimitError and never retries on its own (fetch.ts:13-17).
        // Do not add a second wrapper here or inside the leaf.
        //
        // THE CONTRACT LIVES AT THE HELPER, NOT IN THESE COMMENTS.
        // `listAllInAppPurchases`'s own docstring (client.ts:52-54) states
        // "Callers MUST NOT wrap this in their own `withRetry`" — that is the
        // single source to check before wrapping ANY Apple helper. Read it
        // there rather than trusting a comment like this one to be complete;
        // this family was swept twice and both sweeps missed a sibling.
        //
        // Known double-wrap sites, both over `listAllInAppPurchases`
        // (helper retries per page at client.ts:70) — ⚠ BOTH NOW FIXED:
        //   • sync-states/route.ts:91  — fixed (outer wrapper removed)
        //   • export/route.ts:68       — fixed (outer wrapper removed)
        // Each was 4 × 4 = 16 attempts, and because the outer retry restarts
        // the helper from page 1, a tail-page 429 also re-fetched every page
        // already read: up to 32 requests for a 5-page list.
        // Sites that were always correct and are the reference shape:
        // page.tsx:78, submit-batch/route.ts:353 + :432 (bare, no wrapper).
        const res = await trackedWithRetry(counters, () =>
          setAvailabilityTerritories(creds, appleIapId, selection),
        );
        const apple_availability_id = res.data?.id;
        await writeAuditRow(actor, iapId, action_type, {
          apple_iap_id: appleIapId,
          result: "SUCCESS",
          ...availabilityAuditProvenance(selection, previousByIapId?.[iapId]),
          ...(apple_availability_id ? { apple_availability_id } : {}),
          source: "bulk",
          rate_limit: counters,
        });
        return {
          iapId,
          apple_iap_id: appleIapId,
          ok: true,
          status: "SUCCESS",
          ...(apple_availability_id ? { apple_availability_id } : {}),
          rate_limit: counters,
        };
      }
    },
    onError: async (iapId, err) => {
      // Retries are already exhausted by the time this fires — `withRetry`
      // re-throws the LAST AppleRateLimitError only after burning the
      // whole backoff curve. Reacting to the error is the whole strategy:
      // nothing here pre-computes a budget from a guessed hourly cap,
      // because that number is unresolved (KB §4.9, 250 vs 3,600).
      //
      // ⚠ The latch is ALREADY set by the time this runs — the pool consults
      // `shouldStop` first (rule 2). Nothing here can stop the batch, and
      // nothing here needs to.
      const appleIapId = appleIdByRow.get(iapId);
      const counters = countersByIap.get(iapId) ?? createRetryCounters();
      const isRateLimited = err instanceof AppleRateLimitError;
      if (isRateLimited) {
        console.warn(
          `[bulk-availability] STOP — Apple rate limit exhausted on iap=${iapId}; remaining rows will not be attempted`,
        );
      }
      const error = err instanceof Error ? err.message : String(err);
      await writeAuditRow(actor, iapId, action_type, {
        apple_iap_id: appleIapId,
        result: "ERROR",
        ...availabilityAuditProvenance(selection, previousByIapId?.[iapId]),
        source: "bulk",
        error,
        rate_limit: counters,
      });
      return {
        iapId,
        apple_iap_id: appleIapId,
        ok: false,
        status: "FAILED",
        failure_kind: isRateLimited ? "RATE_LIMITED" : "APPLE_REJECTED",
        error,
        rate_limit: counters,
      };
    },
  });

  const succeeded = results.filter((r) => r.status === "SUCCESS").length;
  // ⚠ NOT `results.length - succeeded`. Not-attempted rows are not
  // failures — counting them as such would tell Manager 85 items broke
  // when in fact nothing was sent for them.
  const failed = results.filter((r) => r.status === "FAILED").length;
  const notAttempted = results.filter((r) => r.status === "NOT_ATTEMPTED");
  const remainder = notAttempted.map((r) => r.iapId);

  const overall: BulkAvailabilityOutcome["overall"] = stoppedByRateLimit
    ? "STOPPED_RATE_LIMITED"
    : succeeded === results.length
      ? "SUCCESS"
      : succeeded === 0
        ? "FAILURE"
        : "PARTIAL";

  const summary = `${succeeded}/${results.length} succeeded${
    failed > 0 ? ` · ${failed} failed` : ""
  }${remainder.length > 0 ? ` · ${remainder.length} not attempted` : ""}`;

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
    `[bulk-availability] complete action=${action} overall=${overall} ${summary} remainder=${remainder.length} throttled=${rate_limit_total.rows_throttled}/${results.length} retries=${rate_limit_total.rate429_count} backoff=${rate_limit_total.backoff_total_ms}ms`,
  );

  return {
    action,
    total: results.length,
    succeeded,
    failed,
    not_attempted: remainder.length,
    results,
    remainder,
    overall,
    ...(stoppedByRateLimit ? { stopped_reason: "RATE_LIMIT" as const } : {}),
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
  // P2 guard: typed, not `string` — see action-types.ts. The caller derives
  // this from a ternary, the exact shape the P2 recurrence hid in.
  action_type: IapActionType,
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
