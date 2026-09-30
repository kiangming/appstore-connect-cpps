/**
 * GET /api/iap-management/apps/{appId}/bulk-import/localization-baseline
 *     ?appleIapId={id}
 *
 * ⭐ C1 — what Apple currently holds for ONE IAP's localizations, so the Bulk
 * Import preview can decide which cells start ticked.
 * Arc `[BULKIMPORT-loc-compare-apple]`.
 *
 * ─── ⚠ WHY ONE ITEM PER CALL, NOT ONE CALL FOR THE BATCH ──────────────────
 *
 * A lot of 88 costs ~2.3 Apple requests each and about a minute end to end
 * (measured 2026-09-30: median 859ms for the versions read, 1149ms for the
 * localizations read). A minute is far too long to show a bare spinner, and a
 * single batch request would give the client nothing to count and no way to
 * survive one bad item.
 *
 * Fanning out from the browser through `client-fetch-queue` (concurrency 3)
 * buys three things that a batch endpoint would have to reinvent:
 *   · **progress** — "đang đọc App Store Connect: 34/88" falls out of counting
 *     resolved promises.
 *   · **failure isolation** — one item's 500 leaves 87 cells intact.
 *   · **no streaming machinery** — no NDJSON framing, no partial-response
 *     parsing, no half-read edge cases.
 * The extra HTTP round trips to our own server are cheap next to the ~1s Apple
 * latency that dominates either design.
 *
 * ─── ⚠⚠ THIS ROUTE NEVER WRITES, AND NEVER 500s ON APPLE ──────────────────
 *
 * `readable: false` is a FIRST-CLASS answer, always 200-wrapped (same shape as
 * the territories route). The client turns it into *"không đọc được trạng thái
 * trên Apple"* and leaves the cell **UNTICKED**.
 *
 * ⚠⚠ AND THAT IS THE WHOLE SAFETY PROPERTY OF THIS FEATURE. "We could not ask
 * Apple" must never arrive at the UI looking like "Apple has nothing" — the
 * latter ticks every cell, which is how the 409 incident of 2026-09-22
 * happened in the first place. Two different facts, opposite defaults:
 *
 *   `readable: false`                      → UNTICK (we do not know)
 *   `readable: true`, locale not in rows   → TICK   (Apple genuinely lacks it)
 *
 * The catch below is the ONLY place an exception becomes `readable: false`.
 * `readVersionBaseline` itself lets errors propagate, because on the WRITE path
 * the caller reports Apple's real message and blurring it there would help
 * nobody.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { withRetry } from "@/lib/iap-management/apple/fetch";
import { readVersionBaseline } from "@/lib/iap-management/apple/version-baseline";
import type { VersionLocalization } from "@/lib/iap-management/bulk-import/localization-version-plan";

export const runtime = "nodejs";

export interface LocalizationBaselineResponse {
  /**
   * ⚠ `false` ⇒ WE DO NOT KNOW. Never render this as "chưa có trên Apple".
   */
  readable: boolean;
  /** The APPROVED version's rows — the comparison baseline. */
  approved: VersionLocalization[];
  /** The single pending draft's rows, when there is exactly one. */
  draft: VersionLocalization[];
  /** Item is live. Needed for the "will create a version" warning (Q-F). */
  hasApproved: boolean;
  /** Item already has a draft ⇒ editing it creates NO new version (CA 2). */
  hasDraft: boolean;
  /** Present only when `readable` is false, for the log trail. */
  reason?: string;
}

const UNREADABLE = (reason: string): LocalizationBaselineResponse => ({
  readable: false,
  approved: [],
  draft: [],
  hasApproved: false,
  hasDraft: false,
  reason,
});

export async function GET(req: NextRequest) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const appleIapId = req.nextUrl.searchParams.get("appleIapId");
  if (!appleIapId) {
    // ⚠ A 400, not an `UNREADABLE`. A missing parameter is OUR bug, and
    // dressing it as "Apple was unreachable" would hide a client defect behind
    // a sentence about Apple — and do it on every cell at once.
    return NextResponse.json(
      { error: "appleIapId is required" },
      { status: 400 },
    );
  }

  const creds = await getActiveAccount();
  try {
    const baseline = await readVersionBaseline({
      creds,
      appleIapId,
      run: withRetry,
    });
    const ok: LocalizationBaselineResponse = {
      readable: baseline.readable,
      approved: baseline.approved,
      draft: baseline.draft,
      hasApproved: baseline.hasApproved,
      hasDraft: baseline.hasDraft,
    };
    return NextResponse.json(ok);
  } catch (err) {
    return NextResponse.json(
      UNREADABLE(err instanceof Error ? err.message : String(err)),
    );
  }
}
