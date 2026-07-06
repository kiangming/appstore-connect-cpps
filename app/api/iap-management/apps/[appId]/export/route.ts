/**
 * Export an app's IAPs to xlsx — LIVE from Apple, read-only.
 *
 * Apple has no per-territory price cache (unlike the Google module's
 * iap_prices table — see Part 1 investigation), so every row requires a
 * live per-IAP fetch reusing View Detail's own price-schedule +
 * localization read (lib/iap-management/apple/export-fetch.ts). This
 * route does NOT write to the DB — no sync-states side-effect, no cache
 * mutation. Scope: ALL IAPs of the app, ALL states (Manager wants every
 * state, not just READY_TO_SUBMIT/etc — no filter is applied to the list
 * fetch).
 */
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getIapDetailFromApple } from "@/lib/iap-management/queries/iap-detail";
import { getPriceScheduleForIap } from "@/lib/iap-management/apple/price-schedules";
import { withRetry, AppleApiError } from "@/lib/iap-management/apple/fetch";
import { fetchExportSources } from "@/lib/iap-management/apple/export-fetch";
import {
  buildExportPlan,
  buildExportWorkbook,
  xlsxExportFilename,
} from "@/lib/iap-management/xlsx-export";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: { appId: string } },
) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const appleAppId = ctx.params.appId;

  try {
    const creds = await getActiveAccount();
    // listAllInAppPurchases follows Apple's pagination cursor and applies
    // no state filter — every IAP, every state, per Manager's ask.
    const iapsRes = await withRetry(() =>
      listAllInAppPurchases(creds, appleAppId),
    );
    const appleIaps = iapsRes.data ?? [];

    const { sources, failures } = await fetchExportSources(creds, appleIaps, {
      getIapDetail: getIapDetailFromApple,
      getPriceScheduleForIap,
    });

    const plan = buildExportPlan(sources);
    const workbook = buildExportWorkbook(plan);
    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const filename = xlsxExportFilename(appleAppId);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Export-Item-Count": String(plan.rows.length),
        "X-Export-Failed-Count": String(failures.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate export";
    const status =
      err instanceof AppleApiError && err.status < 500 ? err.status : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
