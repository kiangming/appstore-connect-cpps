/**
 * Per-row Apple retry telemetry for Bulk Import, and the one place that
 * decides a row exhausted Apple's rate-limit budget.
 *
 * Extracted from `bulk-import/execute/route.ts` at C2. It was module-private
 * inside a 1,400-line route, which meant the distinction it now carries —
 * "a 429 happened" vs "a 429 outlived the retry curve" — had no way to be
 * asserted. That distinction is the entire stop signal, so it needed a seam.
 * Same reason `stoppable-pool.ts` was extracted from `bulk-availability.ts`.
 */
import { withRetry, AppleRateLimitError } from "@/lib/iap-management/apple/fetch";

/**
 * Per-row 429-aware retry telemetry. Mutated by `trackedWithRetry` and
 * persisted to `actions_log.payload` for each row so Manager can audit
 * rate-limit impact after a batch completes.
 */
export interface RetryCounters {
  rate429_count: number;
  retry_attempts: number;
  backoff_total_ms: number;
  longest_backoff_ms: number;
  /**
   * C2 — an `AppleRateLimitError` survived the FULL retry curve somewhere in
   * this row.
   *
   * ⚠ NOT THE SAME FACT AS `rate429_count > 0`, and the difference is the
   * whole point. `rate429_count` comes from `withRetry`'s `onRetry` hook,
   * which fires on every 429 that leads to a backoff sleep — **including the
   * ones that then succeed on the next attempt**. Hotfix 26 shipped it as
   * throttling telemetry, and `bulk-availability.test.ts` pins that reading
   * ("429 → success recovery: counters populated, row reports ok=true").
   *
   * Using it as a stop signal would halt a batch every time Apple throttled
   * one call and then answered. `exhausted` is set only after the retries ran
   * out, which is the one thing that predicts the NEXT row fails too.
   */
  exhausted: boolean;
}

export function createRetryCounters(): RetryCounters {
  return {
    rate429_count: 0,
    retry_attempts: 0,
    backoff_total_ms: 0,
    longest_backoff_ms: 0,
    exhausted: false,
  };
}

/**
 * Thin wrapper around `withRetry` that mutates a counters bag in place. Pass
 * the SAME instance through every Apple call in one row's orchestration so
 * the per-row audit captures cumulative retry impact across all stages
 * (create + locales + screenshot + pricing + availability + submit).
 */
export function trackedWithRetry<T>(
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
  }).catch((err) => {
    // ⚠ ONE CHOKE POINT, NOT ELEVEN CATCH BLOCKS. Every Apple call in a row's
    // orchestration already routes through here, and each of those call sites
    // sits in its own `catch` that deliberately swallows the error to keep the
    // row going. Recording the fact here means none of those eleven blocks has
    // to change — which is what keeps C2 out of C3's territory.
    if (err instanceof AppleRateLimitError) counters.exhausted = true;
    // ⚠ RE-THROW, ALWAYS. Swallowing here would change the control flow inside
    // the row — the very thing C2 promises not to touch. The caller's own
    // catch must still run and still decide what this stage's failure means.
    throw err;
  });
}

/**
 * The stop predicate for Bulk Import's outer pool.
 *
 * ⚠ IT READS A RESULT, NOT A THROWN ERROR, and that is forced by the code it
 * guards: `orchestrateOne` has no path that throws — every exit is
 * `return await persistResult(...)`, including the fatal create failure. So
 * `runStoppablePool`'s `shouldStop`, which only ever sees throws, is deaf to
 * 100% of a row's Apple traffic. The signal has to ride back on the row's own
 * result via `shouldStopOnResult`.
 */
export function rowExhaustedRateLimitBudget(row: {
  rate_limit?: RetryCounters;
}): boolean {
  return row.rate_limit?.exhausted === true;
}
