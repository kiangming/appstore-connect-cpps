/**
 * Cycle 41 — POST /api/google-iap-management/apps/[packageName]/iaps/bulk-activate
 *
 * Manager-initiated bulk Activate flow. Validates the SKU array, resolves
 * the active Google account + cached app row, then hands off to the
 * shared bulk-status orchestrator which fires Google's cross-product
 * `batchUpdateStates` endpoint in ≤100-item chunks. Returns the
 * aggregated outcome (success/fail per SKU + summary + chip).
 *
 * Hub tracking (5th integration, docs/google-iap-management/design-bulk-status-hub-tracking.md):
 * same try/finally shape as bulk-deactivate's sibling route (see that
 * file's header comment for the full rationale) — Activate has no
 * reconfirm dialog, so in practice there's no client-side CANCEL window
 * (accepted per the design doc), but the run still opens at the button
 * click and closes here with the real per-sku outcome (SUCCESS/PARTIAL/
 * FAILED), never left RUNNING.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { executeBulkStatus } from "@/lib/google-iap-management/orchestration/bulk-status";
import {
  finalizeHubTracking,
  type HubTerminalStatus,
} from "@/lib/google-iap-management/hub-tracking/tracking";
import { computeGoogleBulkImportTerminalStatus } from "@/lib/google-iap-management/hub-tracking/status-mapping";

export const dynamic = "force-dynamic";

const FEATURE = "google-iap-bulk-activate";

const bodySchema = z.object({
  skus: z.array(z.string().min(1)).min(1).max(1000),
  /** Threaded from the modal's Activate-button-click Hub-tracking start
   *  call. Absent/empty/null means tracking never started (or the
   *  client's race cap expired before /start resolved) — a no-op. */
  hub_run_id: z.string().nullish(),
});

/** Threaded by reference so the outer `finally` always closes the run
 *  correctly, even on an unforeseen exception (R1 finalize-in-finally). */
interface HubTrackingState {
  runId: string | null;
  status: HubTerminalStatus;
  errorMessage?: string;
}

export async function POST(
  req: Request,
  { params }: { params: { packageName: string } },
) {
  const tracking: HubTrackingState = { runId: null, status: "FAILED" };
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      tracking.errorMessage = "Unauthorized";
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const accounts = await listAccounts().catch(() => []);
    const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
    if (!accountId) {
      tracking.errorMessage =
        "No Google Console accounts configured. Add one in Settings → Google Console Accounts first.";
      return NextResponse.json({ error: tracking.errorMessage }, { status: 400 });
    }

    const packageName = decodeURIComponent(params.packageName);

    const app = await getAppByPackage(accountId, packageName);
    if (!app) {
      tracking.errorMessage = `App "${packageName}" is not cached. Refresh the apps list first.`;
      return NextResponse.json({ error: tracking.errorMessage }, { status: 404 });
    }

    let parsed: z.infer<typeof bodySchema>;
    try {
      const json = (await req.json()) as unknown;
      parsed = bodySchema.parse(json);
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((i) => i.message).join("; ")
          : "Invalid JSON body.";
      tracking.errorMessage = message;
      return NextResponse.json({ error: message }, { status: 400 });
    }

    tracking.runId =
      parsed.hub_run_id && parsed.hub_run_id.length > 0 ? parsed.hub_run_id : null;

    try {
      const encrypted = await getEncryptedCredentials(accountId);
      const jwt = jwtClientFromEncrypted(encrypted);
      const result = await executeBulkStatus({
        jwt,
        appId: app.id,
        packageName,
        skus: parsed.skus,
        action: "activate",
        actorEmail: session.user?.email ?? null,
      });

      const terminal = computeGoogleBulkImportTerminalStatus({
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed,
      });
      tracking.status = terminal.status;
      tracking.errorMessage = terminal.errorMessage;

      return NextResponse.json(result);
    } catch (err) {
      const e = err as { code?: number; status?: number; message?: string };
      const message = e?.message ?? "Bulk Activate failed.";
      tracking.errorMessage = message;
      const httpStatus =
        typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : 500;
      return NextResponse.json({ error: message }, { status: httpStatus });
    }
  } finally {
    await finalizeHubTracking(tracking.runId, tracking.status, tracking.errorMessage, FEATURE);
  }
}
