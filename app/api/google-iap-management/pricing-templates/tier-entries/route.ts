/**
 * Tier-entries endpoint — the Bulk Import custom-prices dialog's baseline.
 *
 * GET /api/google-iap-management/pricing-templates/tier-entries
 *       ?scope=GLOBAL|APP&appId=<uuid>&identifier=<tier>
 *   → { entries: Array<{ regionCode, currency, priceMicros, priceDecimal }> }
 *
 * Thin wrapper over `lookupTemplateEntriesForIdentifier`
 * (queries/templates.ts:299-350) — the same query the orchestrator runs at
 * push time, so what the dialog pre-fills is exactly what a non-custom
 * push would have sent.
 *
 * WHY A ROUTE AT ALL: the Preview API already resolves WHICH tier each row
 * matches, but `TierCandidate` (queries/templates.ts:600-607) carries only
 * the region COUNT and the VN entry — the Hotfix-19 dropdown label needs
 * nothing more. Fattening the preview response with every candidate's full
 * ~170-entry set would be paid on every upload whether or not anybody
 * opens the dialog; this is lazy, one call per dialog open (design §1.3,
 * option (a)).
 *
 * Session guard mirrors pricing-templates/availability/route.ts:22-25.
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
  lookupTemplateEntriesForIdentifier,
  type TemplateScope,
} from "@/lib/google-iap-management/queries/templates";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";

export const dynamic = "force-dynamic";

/** Strip trailing fractional zeros so VND/JPY render as "27000" not
 *  "27000.000000", without losing precision for fractional currencies.
 *  Same treatment buildCandidatesFromEntries applies to the VN label
 *  (queries/templates.ts:649-652). */
function stripTrailingZeros(decimal: string): string {
  if (!decimal.includes(".")) return decimal;
  return decimal.replace(/\.?0+$/, "");
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawScope = url.searchParams.get("scope");
  const appId = url.searchParams.get("appId");
  const identifier = url.searchParams.get("identifier");

  // ⚠ G1b — GIÁ TRỊ TRÊN DÂY ĐỔI "GLOBAL" → "ACCOUNT", cùng từ vựng với
  //   server và DB. Client gửi giá trị này ở 3 chỗ (IapForm.tsx,
  //   BulkImportWizard.tsx, CustomPricesDialog.tsx) và cả 3 đều được đổi
  //   trong cùng commit — chúng deploy cùng nhau nên không có cửa sổ lệch.
  if (rawScope !== "ACCOUNT" && rawScope !== "APP") {
    return NextResponse.json(
      { error: 'scope must be "ACCOUNT" or "APP".' },
      { status: 400 },
    );
  }
  const scope: TemplateScope = rawScope;
  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      { error: "No Google Console accounts configured." },
      { status: 400 },
    );
  }
  if (!identifier || !identifier.trim()) {
    return NextResponse.json({ error: "identifier is required." }, { status: 400 });
  }
  // Hotfix 17 discipline: scope=APP without an appId must hard-fail rather
  // than silently resolving as GLOBAL. The query itself throws, but
  // rejecting here gives a 400 instead of a 500.
  if (scope === "APP" && !appId) {
    return NextResponse.json(
      { error: 'scope="APP" requires appId.' },
      { status: 400 },
    );
  }

  try {
    const entries = await lookupTemplateEntriesForIdentifier(
      scope === "APP"
        ? { scope, appId: appId as string, accountId: null, identifier: identifier.trim() }
        : { scope, accountId, appId: null, identifier: identifier.trim() },
    );
    return NextResponse.json({
      entries: entries.map((e) => ({
        regionCode: e.regionCode,
        currency: e.currency,
        priceMicros: e.priceMicros,
        priceDecimal: stripTrailingZeros(microsToDecimal(e.priceMicros, 6)),
      })),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load tier entries.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
