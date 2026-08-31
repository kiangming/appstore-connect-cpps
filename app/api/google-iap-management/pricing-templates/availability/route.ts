/**
 * Pricing template availability + tier-list endpoint (g1.k).
 *
 * GET /api/google-iap-management/pricing-templates/availability?appId=<uuid>
 *   → { defaultExists, appExists, defaultTiers, appTiers }
 *
 * The single-IAP form uses this to gate the 3-radio source selector and
 * populate the tier picker when Manager picks a template source.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import {
  getTemplateAvailability,
  listTemplateTiers,
} from "@/lib/google-iap-management/queries/templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const appId = url.searchParams.get("appId");

  // ⚠ ACCOUNT ĐỌC Ở SERVER, KHÔNG NHẬN TỪ CLIENT. Client chỉ gửi appId.
  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      { error: "No Google Console accounts configured." },
      { status: 400 },
    );
  }

  try {
    const availability = await getTemplateAvailability({ accountId, appId });
    const defaultTiers = availability.defaultExists
      ? await listTemplateTiers({ scope: "ACCOUNT", accountId, appId: null })
      : [];
    const appTiers =
      availability.appExists && appId
        ? await listTemplateTiers({ scope: "APP", appId, accountId: null })
        : [];
    return NextResponse.json({
      defaultExists: availability.defaultExists,
      appExists: availability.appExists,
      defaultTiers,
      appTiers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load availability.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
