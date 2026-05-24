/**
 * Cycle 39 Phase 2 — bounded-concurrency fetch of Apple availability for
 * many IAPs at once. Serves two consumers from a single fetch:
 *
 *   1. Unit D — list-column display ("Available" / "Remove from Sales").
 *   2. Unit C — bulk-modal filter ("show only items currently X").
 *
 * Strategy A (Server Component fetch on mount) per Manager kickoff lock —
 * freshness over perf; pre-fetched Map<appleIapId, AvailabilityForIap | null>
 * threads through IapListClient → AvailabilitiesBulkModal as a prop, so the
 * modal never re-fetches.
 *
 * Per-IAP failures are non-fatal. Cycle 37 Phase 1 already established
 * `getAvailabilityForIap` returns `null` on Apple 404 (no availability
 * resource → "Remove from Sales" surface). Here we go one step further: a
 * thrown error from `getAvailabilityForIap` is caught per row and surfaced
 * as `null` in the Map, with the error captured separately on the result
 * envelope so the column can render an em-dash + tooltip without crashing
 * the page.
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import {
  getAvailabilityForIap,
  type AvailabilityForIap,
} from "./availabilities";

export { classifyAvailability, type AvailabilityBucket } from "./availability-classify";

/** Per-IAP result envelope. `state === null` means either Apple has no
 *  availability resource (the "Remove from Sales" surface) OR the fetch
 *  failed. Disambiguate via `error`. */
export interface AvailabilityFetchResult {
  iapId: string;
  state: AvailabilityForIap | null;
  /** Populated when `getAvailabilityForIap` threw. The Phase 1 helper
   *  already swallows 404 → null, so any error here is non-404 (5xx,
   *  transport, etc.) and should surface as "couldn't fetch" UX. */
  error?: string;
}

export interface FetchAvailabilityStatesArgs {
  creds: AscCredentials;
  iapIds: readonly string[];
  /** Concurrency ceiling — Manager kickoff locked 5 to mirror Phase 1
   *  patterns and stay under Apple's 250 req/hour cap for typical lists. */
  concurrency?: number;
}

/**
 * Fan out `getAvailabilityForIap` across all IAPs and return a flat
 * id→state Map. The Map preserves the input order semantics for the
 * caller via the `results` array companion.
 */
export async function fetchAvailabilityStatesForIaps(
  args: FetchAvailabilityStatesArgs,
): Promise<{
  states: Map<string, AvailabilityForIap | null>;
  errors: Map<string, string>;
  results: AvailabilityFetchResult[];
}> {
  const { creds, iapIds, concurrency = 5 } = args;

  const results = await withConcurrency<string, AvailabilityFetchResult>(
    iapIds,
    concurrency,
    async (iapId) => {
      try {
        const state = await getAvailabilityForIap(creds, iapId);
        return { iapId, state };
      } catch (err) {
        return {
          iapId,
          state: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  const states = new Map<string, AvailabilityForIap | null>();
  const errors = new Map<string, string>();
  for (const r of results) {
    states.set(r.iapId, r.state);
    if (r.error) errors.set(r.iapId, r.error);
  }
  return { states, errors, results };
}

