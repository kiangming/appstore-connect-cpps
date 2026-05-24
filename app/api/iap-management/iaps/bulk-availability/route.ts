/**
 * POST /api/iap-management/iaps/bulk-availability
 *
 * Cycle 39 Phase 2 — bulk Apple availability flip for a multi-selected
 * set of IAPs. Body shape:
 *
 *   { iapIds: string[], action: "set-all" | "remove" }
 *
 * Where `iapIds` are internal `iap_mgmt.iaps.id` rows (UUIDs). The
 * orchestrator resolves each row's `apple_iap_id` server-side, calls
 * Apple at concurrency 5, and writes one actions_log row per IAP using
 * the Phase 1 audit types (`AVAILABILITY_SET_ALL_TERRITORIES` /
 * `AVAILABILITY_REMOVE_FROM_SALES`).
 *
 * Q-K fail-soft preserved: per-IAP failures never cascade. The response
 * surfaces per-row status + an aggregate roll-up so the modal can render
 * the progress view (mockup State 6) without a second round-trip.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  executeBulkAvailability,
  type BulkAvailabilityOutcome,
} from "@/lib/iap-management/orchestrators/bulk-availability";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const BodySchema = z.object({
  iapIds: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(["set-all", "remove"]),
});

export async function POST(req: Request) {
  let session;
  try {
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
  const actor = session.user.email ?? "unknown";

  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json();
    body = BodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid body: ${err instanceof Error ? err.message : err}` },
      { status: 400 },
    );
  }

  let creds;
  try {
    creds = await getActiveAccount();
  } catch (err) {
    await log(
      "bulk-availability",
      `getActiveAccount failed: ${err instanceof Error ? err.message : err}`,
      "ERROR",
    );
    return NextResponse.json(
      { error: "Apple credentials unavailable" },
      { status: 500 },
    );
  }

  const outcome: BulkAvailabilityOutcome = await executeBulkAvailability({
    creds,
    iapIds: body.iapIds,
    action: body.action,
    actor,
  });

  return NextResponse.json(outcome);
}
