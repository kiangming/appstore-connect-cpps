import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { getApps } from "@/lib/asc-client";

export const runtime = "nodejs";

/**
 * GET /api/iap-management/asc-apps
 *
 * Live fetch of the active ASC account's app catalog (Manager Q-Issue 3
 * from IAP.p1.j MV30 v9). Previously the "Upload for an app" dropdown was
 * sourced from `iap_mgmt.apps` which only contains apps that have already
 * been registered via past IAP drafts — Manager saw a single app and
 * couldn't pick the new ones they wanted to upload a template for.
 *
 * Response shape mirrors the local-cache helper so the client component
 * stays drop-in: `{ apps: [{ id, name, bundle_id }] }`.
 *
 * The active ASC account is resolved server-side via `getActiveAccount()`,
 * which means switching account in TopNav + re-clicking the dropdown
 * naturally pulls a fresh list under the new account.
 */
export async function GET() {
  // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  try {
    const creds = await getActiveAccount();
    const res = await getApps(creds);
    const apps = (res.data ?? []).map((a) => ({
      id: a.id,
      name: a.attributes.name,
      bundle_id: a.attributes.bundleId,
    }));
    return NextResponse.json({ apps, account_id: creds.id, account_name: creds.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ASC app fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
