/**
 * Refresh apps cache for the active Google Console account.
 *
 * Calls Reporting API apps.search across all pages, then batch-UPSERTs
 * the returned (packageName, displayName) into google_iap_mgmt.apps.
 *
 * Hotfix 4: after the batch UPSERT, fetch per-app AppDetails (edits
 * create + details get + edits delete) concurrency-limited and populate
 * default_language + default_currency. Currency inference uses the
 * language → currency fallback map; ground truth comes from the IAPs
 * refresh path (first IAP's defaultPrice.currency overwrites the
 * inference). Per-app fetch failures are tolerated — Manager re-runs.
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
import { getAppDetails } from "@/lib/google-iap-management/google/publisher-client";
import { inferCurrencyFromLanguage } from "@/lib/google-iap-management/google/region-currency-map";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import {
  batchUpsertAppsFromSync,
  listAppsForAccount,
  updateAppDefaults,
} from "@/lib/google-iap-management/repository/apps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";

const DETAILS_CONCURRENCY = 5;

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

    // Hotfix 4: enrich each cached app with default_language + inferred
    // default_currency. The IAPs-refresh path will overwrite currency with
    // ground truth (defaultPrice.currency from an existing IAP) on the
    // next per-app sync — until then this gives the Create form a
    // sensible pre-fill instead of blind USD.
    const cached = await listAppsForAccount(accountId).catch(() => []);
    const cachedByPackage = new Map(cached.map((a) => [a.package_name, a]));
    let detailsOk = 0;
    let detailsFailed = 0;

    for (let i = 0; i < upserts.length; i += DETAILS_CONCURRENCY) {
      const chunk = upserts.slice(i, i + DETAILS_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ packageName }) => {
          const row = cachedByPackage.get(packageName);
          if (!row) return;
          // Skip apps that already have BOTH defaults set — saves the
          // 3-call edits dance on repeat refreshes when the cache is
          // already populated. IAP-refresh ground-truth writes will
          // continue to refine these on demand.
          if (row.default_currency && row.default_language) {
            detailsOk += 1;
            return;
          }
          try {
            const details = await getAppDetails(jwt, packageName);
            const language = details.defaultLanguage ?? null;
            const currency = row.default_currency
              ? row.default_currency
              : inferCurrencyFromLanguage(language);
            await updateAppDefaults(row.id, {
              language: language ?? row.default_language,
              currency,
            });
            detailsOk += 1;
          } catch (err) {
            detailsFailed += 1;
            console.error(
              `[google-iap:apps-refresh] details_failed package=${packageName} err="${err instanceof Error ? err.message.replace(/"/g, "'") : String(err)}"`,
            );
          }
        }),
      );
    }

    await appendAction({
      actionType: "APPS_SYNC",
      actorEmail: session.user.email ?? null,
      targetId: accountId,
      payload: {
        apps_count: upserts.length,
        details_ok: detailsOk,
        details_failed: detailsFailed,
        duration_ms: Date.now() - t0,
      },
    });

    return NextResponse.json({
      ok: true,
      apps_count: upserts.length,
      details_ok: detailsOk,
      details_failed: detailsFailed,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to refresh apps";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
