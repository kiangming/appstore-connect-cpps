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
 *
 * POST, not GET (Export options dialog, shared with the Google export):
 * the operator's territory selection can be up to ~180 country codes —
 * travels in the POST body, not a query string, avoiding the URL-length
 * trap this session already hit twice on Supabase `.in()` calls (KB
 * §10.13.E). `territories: string[] | null`; `null` (or omitted/empty)
 * means "no filter," matching pre-dialog behavior exactly. The selection
 * only narrows which columns the workbook renders — it does NOT change
 * the fetch; every IAP's full price schedule is still fetched regardless.
 *
 * ─── TWO SCOPES, TWO DIFFERENT HONESTY MECHANISMS ──────────────────────────
 *
 * `selectedIds` decides which of the two runs, and they are NOT variants of
 * one path — each guarantees completeness by its own means:
 *
 *   ABSENT / null → EXPORT ALL. `listAllInAppPurchases` enumerates the app,
 *     and its all-or-nothing contract is what makes the file trustworthy: a
 *     page failure or an unfollowable `links.next` THROWS, so a truncated set
 *     can never reach the workbook and masquerade as a complete export. This
 *     path is unchanged.
 *
 *   NON-EMPTY → EXPORT EXACTLY THESE. There is nothing to enumerate, so the
 *     completeness guarantee has to come from somewhere else: EVERY id the
 *     operator sent is attempted, and every id is accounted for in the file —
 *     as a row, or as a failure-sheet entry.
 *
 * ⚠ THE ROUTE DOES NOT VALIDATE IDS AGAINST APPLE'S LIST FIRST. Enumerating
 * and intersecting would look safer and is the trap: an id the operator
 * selected but that the intersection drops would vanish silently, producing a
 * file that is short by one row with nothing anywhere saying why — the exact
 * silent-drop class this arc has been removing. A dead or deleted id is sent,
 * Apple answers 404, and it lands in the failure sheet as APPLE_ERROR where a
 * human can see it. A visible failure beats an invisible omission.
 *
 * ⚠ EMPTY ARRAY IS A 400, NOT AN EXPORT-ALL. `[]` is a client bug or a UI
 * that let someone through with nothing ticked; quietly widening it to the
 * whole app would bill the operator ~3N Apple requests they did not ask for.
 * Only ABSENCE means "no selection was made".
 *
 * ⚠ NO CAP ON THE SELECTION SIZE. The stop latch in `fetchExportSources` IS
 * the budget mechanism — it stops dispatching when Apple's budget is gone and
 * preserves the remainder. A second, invented cap here would refuse work the
 * latch already handles correctly.
 */
import { NextResponse } from "next/server";

import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import type { InAppPurchase } from "@/types/iap-management/apple";
import { getIapDetailFromApple } from "@/lib/iap-management/queries/iap-detail";
import { getPriceScheduleForIap } from "@/lib/iap-management/apple/price-schedules";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import { fetchExportSources } from "@/lib/iap-management/apple/export-fetch";
import { allExportTerritories } from "@/lib/iap-management/apple/export-territory-expansion";
import {
  buildExportPlan,
  buildExportWorkbook,
  xlsxExportFilename,
} from "@/lib/iap-management/xlsx-export";

export const runtime = "nodejs";

interface ExportRequestBody {
  territories?: string[] | null;
  /** Apple IAP ids. See the header: absent/null = every IAP, `[]` = 400,
   *  non-empty = exactly these, deduped, each one attempted. */
  selectedIds?: string[] | null;
}

/**
 * The minimum `fetchExportSources` needs per item: an Apple id.
 *
 * ⚠ `productId` AND `name` ARE BLANK ON PURPOSE, and that is the honest
 * value. They are read FROM Apple, in the detail call — so for an item whose
 * read fails we genuinely do not know them, and the failure row must not
 * assert one. The failure sheet's "Apple IAP ID" column identifies the row,
 * which is also the id a re-export takes. A client-supplied last-known
 * product id would read as fetched fact and could be stale for exactly the
 * items most likely to fail.
 */
function stubForSelectedId(id: string): InAppPurchase {
  return {
    type: "inAppPurchases",
    id,
    attributes: {
      name: "",
      productId: "",
      inAppPurchaseType: "CONSUMABLE",
      state: "MISSING_METADATA",
    },
  } as InAppPurchase;
}

export async function POST(
  req: Request,
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
  const body = (await req.json().catch(() => ({}))) as ExportRequestBody;
  // ── F-B — "ALL COUNTRIES" IS A QUESTION, AND IT GETS AN ANSWER PER COUNTRY.
  //
  // The dialog collapses "every box ticked" to `null` (its contract, shared
  // with Google and pinned by 13 tests — P8, do not touch it there). Downstream
  // `null` used to fall through to "the union of territories that happened to
  // have a price", which is not what was asked: a market no exported item is
  // sold in produced NO COLUMN, and the file said nothing about having been
  // asked. Same silent-drop class E2 removed from the intersection, surviving
  // on the other branch.
  //
  // ⚠ EXPANDED HERE, AT THE APPLE ROUTE, not in the shared dialog. `null` is
  // overloaded — it means both "nobody opened the dialog" and "the operator
  // ticked all 183" — and only this route knows that, for the Apple export,
  // both should mean "every territory either side knows about" (194 = catalog
  // 183 ∪ Apple 175). Google's route reads the same `null` and is untouched.
  const territories = Array.isArray(body.territories)
    ? body.territories
    : allExportTerritories();

  // ⚠ `[]` and "absent" must not collapse — see the header. `Array.isArray`
  // first, so only a REAL empty array reaches the 400.
  const selectedIds = Array.isArray(body.selectedIds) ? body.selectedIds : null;
  if (selectedIds !== null && selectedIds.length === 0) {
    return NextResponse.json(
      { error: "No items selected. Pick at least one item to export." },
      { status: 400 },
    );
  }
  // Order-preserving dedupe: a duplicated id is one item, not two Apple reads
  // and two identical rows.
  const uniqueSelectedIds =
    selectedIds === null ? null : [...new Set(selectedIds)];

  try {
    const creds = await getActiveAccount();
    // listAllInAppPurchases follows Apple's pagination cursor and applies
    // no state filter — every IAP, every state, per Manager's ask.
    //
    // ⚠ NO outer `withRetry`. This helper retries each page internally
    // (client.ts:70) and its docstring forbids wrapping it (client.ts:52-54).
    // Wrapping turned 4 attempts into 16, and because the outer retry
    // restarts the helper from page 1, a tail-page 429 on a 5-page app cost
    // up to 32 requests for a list that costs 5 — on the route whose whole
    // problem is Apple's hourly budget (3 requests per IAP, ~3,005 at
    // N=1000). Enumeration is all-or-nothing: a page failure or an
    // unfollowable `links.next` THROWS, so a truncated set can never reach
    // the workbook and masquerade as a complete export.
    //
    // ⚠ With a selection there is NO enumeration at all — not even to
    // validate. See the header: intersecting would silently drop a selected
    // id, and a dropped id is invisible while a 404 is not.
    let appleIaps: InAppPurchase[];
    if (uniqueSelectedIds !== null) {
      appleIaps = uniqueSelectedIds.map(stubForSelectedId);
    } else {
      const iapsRes = await listAllInAppPurchases(creds, appleAppId);
      appleIaps = iapsRes.data ?? [];
    }

    const { sources, failures, stopped } = await fetchExportSources(
      creds,
      appleIaps,
      {
        getIapDetail: getIapDetailFromApple,
        getPriceScheduleForIap,
        // ⚠ F-A — THE EXPORT IS THE ONE SURFACE THAT WANTS APPLE'S
        // AUTO-EQUALIZED PRICES, and this line is where that is decided.
        //
        // Without it the file contains only the territories a human priced by
        // hand — 10 of 175 on the Manager's app — and says nothing about the
        // other 165 markets Apple actively sells in. Costs +1 Apple request
        // per item (customerPrice and currency arrive inline via the same
        // `?include` the manual walk uses, so no N+1): 3 → 4 per item,
        // ~2,003 for a 500-item app, ≈56% of the 3,600/hour budget.
        //
        // ⚠ Do NOT push this default down into `fetchExportSources` or
        // `getPriceScheduleForIap`. View Detail and the two write paths share
        // that function and want the manual rows only (KB §4.18).
        includeAutomatic: true,
      },
    );

    const plan = buildExportPlan(sources, territories);
    const workbook = buildExportWorkbook(plan, failures);

    // ⚠ THREE COUNTS, NOT ONE. A stopped run is not a failed run: most items
    // may already have exported cleanly. Collapsing these would tell the
    // operator to redo work that already landed.
    //   exported      — full rows in the main sheet
    //   partial       — in the main sheet, but with prices missing
    //   failed        — Apple was asked and refused
    //   notAttempted  — nothing was sent; the ONLY count safe to re-export
    // `X-Export-Failed-Count` keeps its original meaning (rows that are NOT
    // in the main sheet) so the existing toast is not silently redefined;
    // partial and not-attempted get their own headers rather than being
    // folded into it.
    const partialCount = sources.filter((s) => s.priceReadFailure !== null).length;
    const notAttemptedCount = failures.filter((f) => f.kind === "NOT_ATTEMPTED").length;
    const failedCount = failures.length - notAttemptedCount;
    // ⚠ exceljs writes asynchronously — `writeBuffer()` returns a promise,
    // unlike xlsx's synchronous `write()`. Missing the await here would send
    // a Promise to NextResponse and download a file of literally "[object
    // Promise]", which is why this is the one line of the swap worth naming.
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const filename = xlsxExportFilename(appleAppId);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Export-Item-Count": String(plan.rows.length),
        "X-Export-Failed-Count": String(failedCount),
        "X-Export-Partial-Count": String(partialCount),
        "X-Export-Not-Attempted-Count": String(notAttemptedCount),
        ...(stopped ? { "X-Export-Stopped": "rate_limit" } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate export";
    const status =
      err instanceof AppleApiError && err.status < 500 ? err.status : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
