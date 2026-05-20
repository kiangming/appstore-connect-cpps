/**
 * Verify a Google Console account's credentials by calling
 * Reporting v1beta1 apps.search with pageSize=1.
 *
 * Q-GIAP.B: dual-scope verification. apps.search proves the
 * playdeveloperreporting scope. The androidpublisher scope is proven
 * implicitly the first time Manager navigates into an app's IAPs page —
 * we don't have a package name yet at the credential-upload stage, and
 * there is no scope-only no-op endpoint on the publisher API.
 *
 * Status transitions:
 *   pending  → verified  (apps.search succeeded)
 *   pending  → invalid   (apps.search failed: 401/403/etc)
 *   verified → invalid   (re-verify after rotation)
 *   invalid  → verified  (Manager fixed the issue and re-verified)
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import { searchApps } from "@/lib/google-iap-management/google/reporting-client";
import {
  getAccountById,
  getEncryptedCredentials,
  markInvalid,
  markVerified,
} from "@/lib/google-iap-management/repository/google-accounts";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const id = params.id;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const account = await getAccountById(id);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  let appsCount = 0;
  let errorMessage: string | undefined;
  let ok = false;
  try {
    const encrypted = await getEncryptedCredentials(id);
    const jwt = jwtClientFromEncrypted(encrypted);
    const page = await searchApps(jwt, { pageSize: 1 });
    appsCount = page.apps.length;
    ok = true;
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    errorMessage = (e?.message ?? String(err)).slice(0, 300);
  }

  if (ok) {
    await markVerified(id);
  } else {
    await markInvalid(id);
  }

  await appendAction({
    actionType: "ACCOUNT_VERIFY",
    actorEmail: session.user.email ?? null,
    targetId: id,
    payload: { ok, apps_visible: appsCount, error: errorMessage ?? null },
  });

  if (ok) {
    return NextResponse.json({
      status: "verified",
      apps_visible: appsCount,
    });
  }
  return NextResponse.json(
    { status: "invalid", error: errorMessage ?? "Verification failed." },
    { status: 400 },
  );
}
