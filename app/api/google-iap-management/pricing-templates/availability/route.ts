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

  try {
    const availability = await getTemplateAvailability(appId);
    const defaultTiers = availability.defaultExists
      ? await listTemplateTiers({ scope: "GLOBAL", appId: null })
      : [];
    const appTiers =
      availability.appExists && appId
        ? await listTemplateTiers({ scope: "APP", appId })
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
