/**
 * GET /api/iap-management/iaps/[iapId]/availability
 *
 * Hotfix 25 — per-IAP Apple availability lookup. Replaces the Cycle 39
 * Phase 2 Server Component bulk prefetch with a client-driven lazy-load
 * path (see `components/iap-management/AvailabilityCell.tsx`).
 *
 * Strategy D — production verified Apple's 250 req/hour cap cascades
 * into 429s when N IAPs × M apps × short-window manager workflows fan
 * out from a single Server Component render. Lazy + per-row + bounded
 * client-side concurrency keeps Apple traffic under the cap while the
 * IntersectionObserver focuses calls on what Manager is actually looking
 * at.
 *
 * The route accepts the internal `iap_mgmt.iaps.id` UUID (the
 * IapListClient already has these mapped from `appleToInternal`). It
 * resolves the row's `apple_iap_id` and composes the Cycle 37 Phase 1
 * `getAvailabilityForIap` helper with `withRetry` so Apple 429s honour
 * the Retry-After header automatically (already shipped in
 * lib/iap-management/apple/fetch.ts).
 *
 * Response shape:
 *
 *   200 { state: AvailabilityForIap | null }
 *     ↳ `null` = Apple has no availability resource → "Remove from Sales".
 *   200 { state: null, error: "rate_limited" }
 *     ↳ All retries exhausted.
 *   200 { state: null, error: "fetch_failed", reason }
 *     ↳ Non-rate-limit error (5xx, transport, etc.).
 *   404 { error: "iap_not_found" }   — internal id doesn't map to a row.
 *   409 { error: "not_synced" }      — local draft, no apple_iap_id.
 *
 * 200 wraps the error cases (instead of 5xx) so the client can render a
 * graceful em-dash cell + retry affordance without `fetch` rejecting.
 *
 * ─── [EXPORT-availability-filter] C2 — READ-THROUGH ────────────────────────
 *
 * A successful read now also lands in the availability mirror
 * (`iap_mgmt.iaps.availability_*`). This costs ZERO extra Apple requests: it
 * stores an answer this route already paid for and, before C2, threw away.
 * That is what lets the export wizard filter Available/Removed/Unknown for
 * free, and what lets the list column stop re-reading Apple on every mount.
 *
 * ⚠ ONLY A REAL ANSWER IS WRITTEN. `state` here is `AvailabilityForIap | null`
 * and both are answers — an object is Apple's territory list, `null` is Apple
 * having no availability resource at all (the "Removed from Sale" surface).
 * The `rate_limited` and `fetch_failed` branches return BEFORE the write and
 * must keep doing so: persisting REMOVED because Apple was busy would be the
 * U3 defect with the sign flipped, and unlike U3 it would survive a reload.
 *
 * ⚠ THE WRITE CANNOT FAIL THE READ. `recordAvailabilityMirror` never throws
 * and checks its own `error`; its result is reported to the client as
 * `mirrored` and nothing else depends on it. The Manager's cell renders from
 * `state`, exactly as before.
 */

import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  getAvailabilityForIap,
  type AvailabilityForIap,
} from "@/lib/iap-management/apple/availabilities";
import {
  withRetry,
  AppleRateLimitError,
} from "@/lib/iap-management/apple/fetch";
import { recordAvailabilityMirror } from "@/lib/iap-management/queries/availability-mirror";

export const runtime = "nodejs";

interface RouteResponse {
  state: AvailabilityForIap | null;
  error?: "rate_limited" | "fetch_failed";
  reason?: string;
  /** C2 — when the read succeeded, the instant it was stamped into the
   *  mirror, so the client can date the cell without a round-trip. Absent
   *  when the mirror write did not land; the cell still renders `state`. */
  syncedAt?: string;
}

export async function GET(
  _req: Request,
  ctx: { params: { iapId: string } },
) {
  // 1. Auth
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const { iapId } = ctx.params;

  // 2. Resolve internal UUID → apple_iap_id.
  const db = iapDb();
  const { data, error } = await db
    .from("iaps")
    .select("apple_iap_id")
    .eq("id", iapId)
    .maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: "iap_not_found" }, { status: 404 });
  }
  const row = data as { apple_iap_id: string | null };
  if (!row.apple_iap_id) {
    return NextResponse.json({ error: "not_synced" }, { status: 409 });
  }

  // 3. Apple call wrapped in withRetry — 429s respect Retry-After, others
  //    propagate on the first throw. The shared fetch wrapper handles
  //    Apple's 500-default backoff curve (500ms → 1s → 2s) so any
  //    Manager-tolerable 429 cluster fully recovers without burdening
  //    the client.
  const creds = await getActiveAccount();
  let state: AvailabilityForIap | null;
  try {
    state = await withRetry(() => getAvailabilityForIap(creds, row.apple_iap_id!));
  } catch (err) {
    if (err instanceof AppleRateLimitError) {
      const payload: RouteResponse = { state: null, error: "rate_limited" };
      return NextResponse.json(payload);
    }
    const payload: RouteResponse = {
      state: null,
      error: "fetch_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
    return NextResponse.json(payload);
  }

  // ── C2. Read-through. Reached ONLY on a real answer — both error branches
  //    above returned already. `state === null` is Apple saying "no
  //    availability resource", which is a verdict, not a failure.
  const observedAt = new Date().toISOString();
  const mirrored = await recordAvailabilityMirror({
    iapId,
    observed: state,
    observedAt,
  });

  const ok: RouteResponse = mirrored ? { state, syncedAt: observedAt } : { state };
  return NextResponse.json(ok);
}
