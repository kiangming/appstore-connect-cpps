/**
 * Refresh apps cache for the active Google Console account.
 *
 * Calls Reporting API apps.search across all pages, then batch-UPSERTs
 * the returned (packageName, displayName) into google_iap_mgmt.apps.
 *
 * Q-GIAP.C: apps.search default pageSize 50, max 1000. We use 1000 to
 * minimize round-trips for the typical 10-100 apps scenario.
 *
 * Audit: APPS_SYNC entry on success, with apps_count + duration. Failure
 * is surfaced to the Manager via the response body and not logged as an
 * APPS_SYNC entry (no mutation occurred).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import { searchAppsAll } from "@/lib/google-iap-management/google/reporting-client";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { batchUpsertAppsFromSync } from "@/lib/google-iap-management/repository/apps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      {
        error:
          "No Google Console accounts configured. Add one in Settings → Google Console Accounts first.",
      },
      { status: 400 },
    );
  }

  const t0 = Date.now();
  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const apps = await searchAppsAll(jwt, { pageSize: 1000 });

    const upserts = apps
      .filter((a) => typeof a.packageName === "string" && a.packageName.length > 0)
      .map((a) => ({
        packageName: a.packageName as string,
        displayName: (a.displayName ?? null) as string | null,
      }));

    await batchUpsertAppsFromSync(accountId, upserts);

    await appendAction({
      actionType: "APPS_SYNC",
      actorEmail: session.user.email ?? null,
      targetId: accountId,
      payload: {
        apps_count: upserts.length,
        duration_ms: Date.now() - t0,
      },
    });

    return NextResponse.json({
      ok: true,
      apps_count: upserts.length,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh apps";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
