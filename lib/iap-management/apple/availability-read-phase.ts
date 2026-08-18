/**
 * A′ — the READ phase. Reads current availability for the items the Manager
 * SELECTED, at the moment they ask to proceed. Bounded, cancellable, and it
 * STOPS on rate-limit exhaustion instead of burning the rest of the budget.
 *
 * Design: docs/iap-management/design-set-availabilities-item-list.md PART 3.
 *
 * ⚠ WHY THERE IS A READ PHASE AT ALL.
 * The modal used to read every item in the list on OPEN — 2 Apple requests per
 * item, unbatchable and uncached, before the Manager had clicked anything. At
 * N=500 that is ~1,000 requests (worst case 4,000); at N=1000, ~2,000 (worst
 * 8,000). Against Hotfix 25's 250/h figure it blows the hour's budget at ~125
 * items; against Hotfix 26's ~3,600/h it survives one open and fails on the
 * second. Both cap figures give the same verdict, so this does not depend on
 * KB §4.9 ever being resolved.
 *
 * ⚠ THE HONEST LIMIT, WHICH THE UI MUST ALSO STATE.
 * This does not make a full-catalogue sweep cheap. Selecting all 1,000 items
 * still costs ~2,000 reads. What changes is that the cost is now PROPORTIONAL
 * TO WHAT THE MANAGER ASKED FOR instead of to the size of the app's catalogue.
 * Do not describe this as an optimisation; it converts an unconditional cost
 * into a chosen one.
 *
 * ⚠ DECISION 3 (stop and preserve) NOW GOVERNS TWO PHASES, INDEPENDENTLY.
 * The write loop already stopped on rate-limit exhaustion and preserved its
 * remainder (bulk-availability.ts). Under A′ the READ is where a 429 cascade
 * starts, so it needs the same rule — and the two stops are separate events:
 * a read can stop with the write never having begun. The states that result
 * are deliberately the same three SC3 established, because they mean the same
 * things:
 *
 *   read OK           → we know this item's current territories
 *   read RATE-LIMITED → Apple was asked and refused after `withRetry`
 *                       exhausted its backoff. This item is EXCLUDED from the
 *                       write and NAMED at confirm — never silently dropped.
 *   NOT READ          → nothing was sent for this item, because the phase had
 *                       already stopped. The only bucket safe to retry blindly.
 *
 * ⚠ A RATE-LIMITED ITEM IS NOT A NOT-READ ITEM. It was asked. Folding it into
 * the retryable remainder would re-send a request Apple just refused, which is
 * precisely what SC3 forbade on the write side.
 *
 * Concurrency is owned HERE (worker count), while the slot itself comes from
 * the shared Hotfix-25 client queue — so the row cells and this phase draw on
 * one budget rather than two. The worker count is what makes "not yet started"
 * a well-defined set: spawning a task per target and letting the queue throttle
 * them would mean every target had already been claimed, and there would be no
 * remainder left to preserve.
 */

import type { AvailabilityForIap } from "./availabilities";

export interface ReadPhaseTarget {
  appleIapId: string;
  internalId: string;
}

export type ReadOutcome =
  | { kind: "ok"; state: AvailabilityForIap | null }
  | { kind: "rate_limited" }
  | { kind: "failed"; reason: string };

export interface ReadPhaseResult {
  /** Successfully read, keyed by Apple id. `null` = Apple has no availability
   *  resource (the "Removed from Sales" surface), which is a real answer. */
  states: Map<string, AvailabilityForIap | null>;
  /** Asked and refused, keyed by Apple id. Value is `"rate_limited"` or the
   *  failure reason. These are EXCLUDED from the write and named at confirm. */
  errors: Map<string, string>;
  /** Never sent, because the phase stopped first. Retryable as-is. */
  notRead: ReadPhaseTarget[];
  /** True when a rate-limit exhaustion ended the phase early. */
  stoppedByRateLimit: boolean;
}

export interface RunAvailabilityReadPhaseArgs {
  targets: readonly ReadPhaseTarget[];
  /** One item's read. Injected so this is testable without a network. */
  readOne: (t: ReadPhaseTarget) => Promise<ReadOutcome>;
  /** The shared client-fetch-queue slot. */
  acquire: () => Promise<void>;
  release: () => void;
  onProgress?: (done: number, total: number) => void;
  /** Modal closed / selection changed mid-flight. */
  isCancelled?: () => boolean;
  /** Workers, not total fan-out. Defaults to the shared queue's own ceiling. */
  concurrency?: number;
}

/** Matches `MAX_CONCURRENT_CLIENT_FETCHES`. Kept as a default rather than an
 *  import so a caller can lower it without touching the queue everyone shares. */
const DEFAULT_READ_CONCURRENCY = 3;

export async function runAvailabilityReadPhase(
  args: RunAvailabilityReadPhaseArgs,
): Promise<ReadPhaseResult> {
  const {
    targets,
    readOne,
    acquire,
    release,
    onProgress,
    isCancelled,
    concurrency = DEFAULT_READ_CONCURRENCY,
  } = args;

  const states = new Map<string, AvailabilityForIap | null>();
  const errors = new Map<string, string>();
  const attempted = new Set<string>();
  let stoppedByRateLimit = false;
  let done = 0;
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(concurrency, targets.length));

  async function worker(): Promise<void> {
    for (;;) {
      // ⚠ Checked BEFORE claiming an index, so a stopped phase leaves every
      // remaining target genuinely unclaimed and therefore preservable.
      if (stoppedByRateLimit || isCancelled?.()) return;
      const i = cursor;
      if (i >= targets.length) return;
      cursor = i + 1;
      const t = targets[i];

      await acquire();
      try {
        // Re-checked after the (possibly long) queue wait: the phase may have
        // stopped while this worker was parked. Leaving `attempted` unmarked is
        // what routes this target to `notRead`.
        if (stoppedByRateLimit || isCancelled?.()) return;
        attempted.add(t.appleIapId);
        const outcome = await readOne(t);
        if (outcome.kind === "ok") {
          states.set(t.appleIapId, outcome.state);
        } else if (outcome.kind === "rate_limited") {
          // Asked and refused ⇒ an error, NOT a remainder. Then stop: the next
          // call would predictably meet the same wall.
          errors.set(t.appleIapId, "rate_limited");
          stoppedByRateLimit = true;
        } else {
          // An ordinary failure is fail-soft — it does not predict the next
          // item's outcome, so the phase continues (Q-K discipline).
          errors.set(t.appleIapId, outcome.reason);
        }
        done += 1;
        onProgress?.(done, targets.length);
      } catch (err) {
        errors.set(
          t.appleIapId,
          err instanceof Error ? err.message : String(err),
        );
        done += 1;
        onProgress?.(done, targets.length);
      } finally {
        release();
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const notRead = targets.filter((t) => !attempted.has(t.appleIapId));
  return { states, errors, notRead, stoppedByRateLimit };
}
