/**
 * Pure availability bucketing helper — shared between server-side fetch
 * orchestration AND client components (list-column cell + bulk-modal
 * filter). Lives in its own module so the client bundle can import it
 * without pulling in the server-only `iapFetch` transitively (Apple
 * fetch → `lib/logger` → Node `fs`, which webpack rejects).
 */

import type { AvailabilityForIap } from "./availabilities";

/**
 *   • "available" — Apple has an availability resource with ≥1 territory.
 *   • "removed"   — Apple has no availability resource OR an empty one.
 *   • "unknown"   — Fetch failed; column renders em-dash + tooltip and the
 *                   bulk modal excludes the row from both filter buckets
 *                   so Manager doesn't act on stale state.
 */
export type AvailabilityBucket = "available" | "removed" | "unknown";

export function classifyAvailability(
  state: AvailabilityForIap | null,
  hasError: boolean,
): AvailabilityBucket {
  if (hasError) return "unknown";
  if (!state) return "removed";
  if (state.territoryCount > 0) return "available";
  // territoryCount === 0 AND no error → Apple says zero territories. Even
  // when availableInNewTerritories is true, the present surface is no
  // active sale until Apple launches a new market — treat as removed for
  // Manager workflow purposes.
  return "removed";
}
