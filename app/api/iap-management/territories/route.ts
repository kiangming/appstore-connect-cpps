/**
 * GET /api/iap-management/territories
 *
 * Apple's territory catalogue, for clients that must SHOW the same list they
 * will SEND.
 *
 * WHY THIS EXISTS (SC6, surface A)
 * The Set Availabilities modal renders a picker over ~175 territories and then
 * posts the chosen ids. The list it displays must be the list the write path
 * enumerates, or "12 of 175 selected" is a claim about a different catalogue
 * than the one Apple receives. `executeBulkAvailability` already reads
 * `getAllTerritoryIds` for both `set-all` and `set-territories`
 * (bulk-availability.ts:294, :307), so this route hands the client the SAME
 * source rather than introducing a second one.
 *
 * ⚠ WHY A LAZY ROUTE AND NOT A SERVER-COMPONENT PROP. Hotfix 25 pivoted this
 * module from Strategy A to D precisely because prefetching Apple state during
 * the IAP-list Server Component render fanned out into 429 cascades: that path
 * renders on every visit, whether or not the Manager opens a modal. Threading
 * the catalogue from there would put an Apple-backed read back on the hot path
 * for a control most page views never touch. This route is called on modal
 * open instead — joining the fetch burst the modal already performs.
 *
 * ⚠ APPLE COST IS ~0, BUT NOT ZERO, AND THE CACHE IS PER-PROCESS.
 * `getAllTerritoryIds` memoises at module scope with a 1h TTL
 * (availabilities.ts:80-81). So this is normally a cache hit, and at worst one
 * `/v1/territories` call per hour per process. On multi-replica deploys each
 * replica warms its own copy and they can briefly disagree — the same
 * staleness the write path already carries, which is exactly why display and
 * write share this source instead of one being "fresher".
 *
 * Response shape:
 *   200 { territoryIds: string[] }              — Apple's ids, verbatim.
 *   200 { territoryIds: [], error: "fetch_failed", reason }
 *     ↳ 200-wrapped like the per-IAP availability route so the client can
 *       render an honest "catalogue unavailable" state instead of `fetch`
 *       rejecting. An EMPTY list is never a valid selection source, and the
 *       callers treat it as "cannot offer a picker" rather than "0 of 0".
 */

import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { getAllTerritoryIds } from "@/lib/iap-management/apple/availabilities";
import { withRetry } from "@/lib/iap-management/apple/fetch";

export const runtime = "nodejs";

export interface TerritoriesRouteResponse {
  /** Apple territory ids, exactly as Apple returned them. */
  territoryIds: string[];
  error?: "fetch_failed";
  reason?: string;
}

export async function GET() {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const creds = await getActiveAccount();
  try {
    // ⚠ Ids pass through untouched — no sort, no case change. A client that
    // ticks a box sends back what Apple gave us.
    const territoryIds = await withRetry(() => getAllTerritoryIds(creds));
    const ok: TerritoriesRouteResponse = { territoryIds: [...territoryIds] };
    return NextResponse.json(ok);
  } catch (err) {
    const payload: TerritoriesRouteResponse = {
      territoryIds: [],
      error: "fetch_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(payload);
  }
}
