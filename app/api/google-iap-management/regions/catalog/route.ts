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
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";
import { checkRegionsVersion } from "@/lib/google-iap-management/google/play-regions.snapshot";

export const dynamic = "force-dynamic";

/** Fallback probe price — 1.00 in the app's own currency, used when the
 *  caller doesn't supply one. Only the region and currency of each
 *  converted entry matter for the country list; the amounts are ignored
 *  unless the caller asked for them (see `basePriceMicros` below). */
const PROBE_MICROS = "1000000";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const packageName = url.searchParams.get("packageName");
  // Optional: convert THIS row's base price instead of the nominal probe.
  // Costs nothing extra — the route already makes exactly this
  // convertRegionPrices call and discards the amounts. Supplying them
  // gives the custom-prices dialog a real per-country reference under
  // Google Conversion, where there is no template to compare against.
  const basePriceMicros = url.searchParams.get("basePriceMicros");
  const baseCurrency = url.searchParams.get("baseCurrency");
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
      basePriceMicros && /^\d+$/.test(basePriceMicros) ? basePriceMicros : PROBE_MICROS,
      (baseCurrency || app.default_currency || "USD").trim().toUpperCase(),
    );
    const converted = Boolean(basePriceMicros && /^\d+$/.test(basePriceMicros));
    const drift = checkRegionsVersion(result.regionsVersion);
    if (drift.drifted) {
      console.warn(
        `[google-iap:regions] regionsVersion drift — pinned=${drift.pinned} live=${drift.live}. ` +
          "Re-measure lib/google-iap-management/google/play-regions.snapshot.ts",
      );
    }
    return NextResponse.json({
      regions: result.regions.map((r) => ({
        regionCode: r.region,
        currency: r.currency,
        // Present only when the caller supplied a real base price. Absent
        // means "this is the country list, the amounts are meaningless" —
        // callers must not treat the probe conversion as a price.
        ...(converted
          ? { convertedDecimal: microsToDecimal(r.priceMicros, 6) }
          : {}),
      })),
      // Echoed for diagnostics only — the dialog does not pin it. The push
      // path takes its own regionsVersion from its own convertRegionPrices
      // call (Hotfix 9: the version must match the conversion it came
      // from, and these are different calls).
      regionsVersion: result.regionsVersion,
      // ── X4 — DRIFT REPORT, PAID FOR BY A CALL THAT ALREADY HAPPENED ───────
      //
      // The export dialog now offers a PINNED snapshot of Google's 173 markets
      // so that opening it costs zero requests. A pin goes stale silently, so
      // something has to notice — and this route is the cheapest place in the
      // module to notice from: it has just made the `convertRegionPrices` call
      // and Google has already told it the catalog version, for free.
      //
      // ⚠ REPORTED, NEVER ENFORCED. A newer catalog is normal and usually
      // harmless; blocking on it would break the tool over a routine Google
      // update. The point is that somebody is TOLD to re-measure.
      //
      // ⚠ AND THE DIALOG STILL NEVER CALLS THIS. Wiring the check into the
      // export flow would buy a request per open and trade away the lock X2/X3
      // spent effort establishing.
      regionsVersionDrift: drift,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load Google's country catalog.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
