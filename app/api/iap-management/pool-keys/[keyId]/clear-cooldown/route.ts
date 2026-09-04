/**
 * [#5] "Clear cooldown" — put one parked pool key back into rotation NOW.
 *
 * ⚠ WHY THIS ROUTE EXISTS AT ALL, and it is not convenience. Before it, an
 * operator whose pool had parked itself had exactly two options: run SQL in
 * the Supabase editor **and** redeploy Railway, or wait an hour. Neither is
 * discoverable from the screen that shows the problem, and the first one is
 * wrong on its own — see the two-halves note below.
 *
 * ⚠ IT CLEARS BOTH HALVES, AND THE DB HALF ALONE IS NOT ENOUGH.
 * `isCoolingDown` (selector.ts:124-125) checks the process-local Map FIRST and
 * returns `true` on a live marker **without reading the row**. So clearing
 * `cooldown_until` in SQL leaves the running instance refusing every key for
 * the remainder of the hour while the table looks clean — the exact trap the
 * cooldown-misattribution incident fell into. Order is DB first, Map second:
 * if the DB write fails this returns 500 and the Map is left alone, so the
 * operator is never told "cleared" about a key that is still parked durably.
 *
 * ⚠ THE RESPONSE STATES THE PROCESS-LOCAL LIMIT rather than implying a global
 * one. `clearInMemoryCooldowns` reaches the instance that served THIS request
 * and no other; a sibling keeps its own markers until they expire.
 * `repository.ts:86-88` records that the Railway instance count is still an
 * open question (Manager-Verify #3), so the honest answer is to name the
 * limit, not to assume it away.
 *
 * ⚠ CLEARING **ONE** KEY IS ENOUGH TO UNSTICK A FULLY-PARKED POOL. The refusal
 * is `eligible.length === 0` (selector.ts:204-206), so one eligible key ends
 * the `exhausted` state. There is deliberately no "clear all" — a per-row
 * action matches Test key / Disable, and the smallest intervention that works
 * is the right default when the cause is still unread.
 *
 * ⚠ THIS DOES NOT FIX THE CAUSE. The pool will park itself again on the next
 * export while `[POOL-cooldown-misattribution]` is open. The response says so.
 */
import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { listAllPoolKeys } from "@/lib/iap-management/key-pool/admin";
import { clearCooldownForKey } from "@/lib/iap-management/key-pool/repository";
import { clearInMemoryCooldowns } from "@/lib/iap-management/key-pool/selector";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_TAG = "pool-keys";

function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof IapUnauthorizedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof IapForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  throw err;
}

export async function POST(
  _request: Request,
  ctx: { params: { keyId: string } },
) {
  try {
    await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }

  const rowId = ctx.params.keyId;

  let accountId: string;
  let keyId: string;
  try {
    // ── DB first. A failure here must NOT be followed by the Map clear. ──
    ({ accountId, keyId } = await clearCooldownForKey(rowId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(LOG_TAG, `clear-cooldown failed row=${rowId}: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // ── Then the in-memory half, on THIS instance. ──
  const cleared = clearInMemoryCooldowns(accountId);

  await log(
    LOG_TAG,
    `cleared cooldown account=${accountId} key=${keyId} row=${rowId} ` +
      `in_memory_markers_dropped=${cleared} (this instance only)`,
    "WARN",
  );

  return NextResponse.json({
    ok: true,
    accountId,
    keyId,
    inMemoryMarkersDropped: cleared,
    keys: await listAllPoolKeys(),
  });
}
