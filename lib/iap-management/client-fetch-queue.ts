/**
 * Hotfix 25 — client-side bounded-concurrency queue for Apple-backed
 * fetches initiated from the browser. Singleton module-scoped state
 * because the goal is per-tab rate-limit protection (Apple counts
 * requests per ASC key — one tab on one app should never exceed Apple's
 * 250 req/hour cap on its own).
 *
 * Picked smaller than the server-side `withConcurrency` ceiling (5) →
 * 3 here. Rationale: the client fires whenever IntersectionObserver
 * detects visibility, which can spike on fast scrolls of long lists.
 * The server-side helper runs inside a single orchestration with deeper
 * insight into total fan-out; client cells share state across the page.
 *
 * Acquire / release is a strict FIFO queue. A call that overflows waits
 * for `releaseSlot` instead of throwing — Manager scrolling past 100
 * rows shouldn't drop any cells, just delay them slightly.
 *
 * The queue is intentionally NOT exposed for cancellation: if a user
 * scrolls back up and the cell unmounts mid-wait, the queued resolver
 * still fires and the cell's mounted flag (managed in AvailabilityCell)
 * discards the result. Simpler than threading AbortController through
 * the queue.
 */

const MAX_CONCURRENT = 3;

const queue: Array<() => void> = [];
let activeCount = 0;

/** Wait until a fetch slot is free, then return. Caller MUST pair this
 *  with `releaseSlot()` in a finally block. */
export function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
      return;
    }
    queue.push(() => {
      activeCount++;
      resolve();
    });
  });
}

/** Mark a fetch as finished. Drains one waiter from the queue if any. */
export function releaseSlot(): void {
  activeCount = Math.max(0, activeCount - 1);
  const next = queue.shift();
  if (next) next();
}

/** Test-only — reset the queue between specs so cross-test state doesn't
 *  leak (jsdom shares module-scoped singletons across tests). */
export function __resetQueueForTests(): void {
  queue.length = 0;
  activeCount = 0;
}

/** Test-only introspection. */
export function __getQueueStateForTests(): {
  activeCount: number;
  queueLength: number;
} {
  return { activeCount, queueLength: queue.length };
}

/** The cap, exported so tests can assert against the same constant the
 *  queue uses (avoids drift). */
export const MAX_CONCURRENT_CLIENT_FETCHES = MAX_CONCURRENT;
