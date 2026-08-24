/**
 * Bounded-concurrency pool that STOPS DISPATCHING once a failure proves the
 * remaining work cannot succeed — and reports what it never attempted.
 *
 * Extracted from `orchestrators/bulk-availability.ts`, where this shape was
 * written for Manager decision 3 (stop-and-preserve). A second caller (the
 * xlsx export fetch) needs the identical behaviour, and re-implementing it
 * there would be twin-path: two latches for one rule, drifting apart at the
 * first bug fix. Both callers now share this.
 *
 * ─── THE THREE RULES, IN ONE PLACE ─────────────────────────────────────────
 *
 * ⚠ 1. THE LATCH IS CHECKED AT THE TOP OF THE CALLBACK, BEFORE ANY I/O.
 *      Not after the work, not inside it. An item dispatched after the latch
 *      is down does ZERO external work — no request, no audit row, no write.
 *      That is the entire reason its result is safe to retry blindly later:
 *      nothing was sent, so re-sending cannot double anything.
 *
 * ⚠ 2. ONLY `shouldStop` MAY SET THE LATCH.
 *      A caller's `onError` cannot reach it. This is structural, not
 *      conventional: an item-specific rejection (a bad territory, a state
 *      guard, a 404) says nothing about the NEXT item and must stay
 *      fail-soft, while an exhausted rate-limit budget is the one failure
 *      that predicts the next call fails too. Letting any error stop the
 *      pool would turn one bad row into a halted batch.
 *
 * ⚠ 3. ITEMS ALREADY IN FLIGHT RUN TO COMPLETION AND ARE RECORDED HONESTLY.
 *      When the latch trips there are up to `concurrency - 1` siblings
 *      mid-request. They are NOT cancelled and their results are NOT
 *      discarded — a request already sent has already cost budget and may
 *      already have changed state on the far side. Throwing its result away
 *      would report a lie in both directions.
 *
 * ─── WHY IT WRAPS `withConcurrency` RATHER THAN REPLACING IT ───────────────
 *
 * `withConcurrency` is shared with bulk-import, submit-batch and the Google
 * module. Adding cancellation *inside* it would put a new failure mode on
 * paths that never asked for one. So the latch lives here, one layer up, and
 * the primitive stays exactly as those five other callers already trust it.
 *
 * ⚠ Note on what "not attempted" means mechanically: `withConcurrency` claims
 * its index and then invokes the callback, so every remaining item IS
 * invoked — it simply returns `skipped(item)` without doing any work. The
 * remainder is therefore produced by the callback, not by leaving items
 * unclaimed. (`availability-read-phase.ts` solves the same problem the other
 * way — it checks the latch *before* claiming an index, because it must also
 * hold a slot from a shared client-side queue. Same three states, different
 * constraint; that one is not merged here.)
 */
import { withConcurrency } from "@/lib/iap-management/concurrency";

export interface StoppablePoolArgs<T, R> {
  items: readonly T[];
  /** Max in-flight. Passed straight through to `withConcurrency`. */
  concurrency: number;
  /** The per-item work. May throw; the pool routes throws to `onError`. */
  run: (item: T) => Promise<R>;
  /**
   * Turn a thrown error into this item's result row. Runs for EVERY throw,
   * whether or not the latch tripped, and may do I/O of its own (audit
   * writes). It is called AFTER the latch decision so a stopped batch is
   * already stopped by the time the row is recorded.
   */
  onError: (item: T, err: unknown) => Promise<R>;
  /**
   * "Does this error mean the remaining work cannot succeed?" The ONLY thing
   * that can set the latch (rule 2). Keep it narrow — for Apple that is
   * `err instanceof AppleRateLimitError`, i.e. a 429 that already survived
   * `withRetry`'s full backoff, never a bare 429.
   */
  shouldStop: (err: unknown) => boolean;
  /**
   * "Does this SUCCESSFUL result nevertheless prove the remaining work cannot
   * succeed?" Optional; omitted by callers whose only stop signal is a throw.
   *
   * ⚠ WHY A SECOND PREDICATE RATHER THAN MAKING THE CALLER THROW. Some work
   * is partially recoverable: the xlsx export's price-schedule read can be
   * rate-limited while the row it belongs to is still worth exporting (its
   * product id, name, status and localizations were all read successfully).
   * Forcing that to throw would delete a usable row to report a budget fact.
   * So the row succeeds AND the latch falls — two independent decisions.
   *
   * ⚠ Rule 2 is unchanged: this is a POOL-EVALUATED PREDICATE, like
   * `shouldStop`. `run` and `onError` still have no way to reach the latch;
   * they can only return a value the pool then judges.
   *
   * ⚠ Rule 1 is unchanged too: this runs AFTER `run`, so it cannot affect
   * whether the item's own I/O happened — only whether the NEXT item's does.
   */
  shouldStopOnResult?: (result: R) => boolean;
  /** The result recorded for an item the pool never attempted (rule 1). */
  skipped: (item: T) => R;
}

export interface StoppablePoolResult<R> {
  /** One entry per input item, in input order. Total — nothing is dropped. */
  results: R[];
  /** True when `shouldStop` fired and the pool stopped dispatching. */
  stopped: boolean;
}

export async function runStoppablePool<T, R>(
  args: StoppablePoolArgs<T, R>,
): Promise<StoppablePoolResult<R>> {
  const { items, concurrency, run, onError, shouldStop, skipped } = args;
  const shouldStopOnResult = args.shouldStopOnResult;

  let stopped = false;

  const results = await withConcurrency<T, R>(
    items,
    concurrency,
    async (item) => {
      // ── RULE 1. Before any I/O. Moving this below `run` would let a
      //    stopped pool keep spending budget on an API already refusing.
      if (stopped) return skipped(item);

      try {
        const result = await run(item);
        // A success that still carries the stop signal (see
        // `shouldStopOnResult`). Judged by the pool, never set by `run`.
        if (shouldStopOnResult?.(result)) stopped = true;
        return result;
      } catch (err) {
        // ── RULE 2. The latch is set here and NOWHERE else. `onError`
        //    receives the error but has no way to reach `stopped`.
        //    Set BEFORE `onError` runs: `onError` may await an audit write,
        //    and siblings dispatched during that await must already see the
        //    latch down.
        if (shouldStop(err)) stopped = true;
        return await onError(item, err);
      }
    },
  );

  // ── RULE 3. `withConcurrency` returns one slot per input item and the
  //    in-flight callbacks above were awaited, so their real results are in
  //    `results` — never replaced by a stop marker after the fact.
  return { results, stopped };
}
