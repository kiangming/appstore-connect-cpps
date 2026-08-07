/**
 * Google country catalog — the authoritative country→currency map.
 *
 * GET /api/google-iap-management/regions/catalog?packageName=<pkg>
 *   → { regions: Array<{ regionCode, currency }>, regionsVersion: string|null }
 *
 * WHY THIS EXISTS: the custom-prices dialog must list every country Google
 * sells in, each with its FIXED billing currency, and the tool has no such
 * list locally. What it has is insufficient in both directions:
 *   - `COMMON_REGIONS` (regions.ts:19-50) — 30 curated entries;
 *     `defaultCurrencyForRegion` returns "USD" for everything else.
 *   - `getAllRegions()` (region-name.ts:84-94) — ~250 ISO codes with NO
 *     currency at all, including markets Google does not sell in.
 * The canonical source is Google itself: `convertRegionPrices` returns
 * exactly its supported regions, each with that region's currencyCode
 * (regions-helper.ts:76-101). This route makes one such call at a nominal
 * base price and returns only the (regionCode, currency) pairs — the
 * converted amounts are discarded, they are not a pricing recommendation.
 *
 * ⚠ NO CACHE — DELIBERATE (P6, and Hotfix 9's BG → EUR incident).
 * A module-scope or cross-process cache would go stale exactly when it
 * matters: Google moved Bulgaria from BGN to EUR in Jan 2026, and a cached
 * map would have kept offering BGN prices that the push then rejects. One
 * extra call per dialog session beats a wrong currency. The wizard holds
 * the result in component state for its own session only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

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
import { buildRegionMapFromBasePrice } from "@/lib/google-iap-management/google/regions-helper";

export const dynamic = "force-dynamic";

/** Nominal probe price — 1.00 in the app's own currency. Only the region
 *  and currency of each converted entry is used; the amounts are thrown
 *  away. Using the app's currency (not a hardcoded USD) keeps the call on
 *  the same footing as the real write path. */
const PROBE_MICROS = "1000000";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const packageName = url.searchParams.get("packageName");
  if (!packageName) {
    return NextResponse.json(
      { error: "packageName is required." },
      { status: 400 },
    );
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

  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    const result = await buildRegionMapFromBasePrice(
      jwt,
      packageName,
      PROBE_MICROS,
      app.default_currency ?? "USD",
    );
    return NextResponse.json({
      regions: result.regions.map((r) => ({
        regionCode: r.region,
        currency: r.currency,
      })),
      // Echoed for diagnostics only — the dialog does not pin it. The push
      // path takes its own regionsVersion from its own convertRegionPrices
      // call (Hotfix 9: the version must match the conversion it came
      // from, and these are different calls).
      regionsVersion: result.regionsVersion,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load Google's country catalog.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
