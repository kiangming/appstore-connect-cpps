/**
 * Export an app's IAPs to xlsx — LIVE from Google, read-only.
 *
 * Reuses the same `listInAppProducts` fetch "Refresh" uses (Part 1
 * investigation: the paginated list already returns full listings +
 * complete regional pricing per item, so no per-item GET is needed).
 * Unlike Refresh, this route does NOT write to the DB — no cache sync,
 * no soft-delete reconcile. Deleted-on-Google items are naturally
 * excluded since they're absent from Google's live response.
 *
 * Scope: ALL items currently on Google for this app (not the cached /
 * paginated view).
 *
 * POST, not GET (Export options dialog, shared with the Apple export):
 * the operator's territory selection can be up to ~180 country codes.
 * This session already hit Supabase's `.in()` ~8KB URL limit twice
 * (see KB §10.13.E) — rather than repeat that trap with a query string,
 * the selection travels in the POST body. `territories: string[] | null`;
 * `null` (or omitted/empty) means "no filter," matching pre-dialog
 * behavior exactly.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import * as XLSX from "xlsx";

import { authOptions } from "@/lib/auth";
import { jwtClientFromEncrypted } from "@/lib/google-iap-management/google/auth";
import { listInAppProducts } from "@/lib/google-iap-management/google/publisher-client";
import type { ToolInAppProduct } from "@/lib/google-iap-management/google/onetime-product-adapter";
import {
  getEncryptedCredentials,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import {
  buildExportPlan,
  buildExportWorkbook,
  xlsxExportFilename,
} from "@/lib/google-iap-management/xlsx-export";
import {
  isExportStatusFilter,
  partitionByStatusFilter,
  type ExportStatusFilter,
} from "@/lib/google-iap-management/export-status-filter";

export const dynamic = "force-dynamic";

interface ExportRequestBody {
  territories?: string[] | null;
  /** X2 — `"all"` / absent / unrecognised all mean "no filter". See below. */
  statusFilter?: unknown;
  /** X3 — SKUs. Absent/null = every item; `[]` = 400; non-empty = exactly
   *  these, and every one must exist on Google or the request is refused. */
  selectedSkus?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: { packageName: string } },
) {
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

  const packageName = decodeURIComponent(params.packageName);
  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as ExportRequestBody;
  const territories = Array.isArray(body.territories) ? body.territories : null;
  // X2 — an unrecognised value degrades to "all" rather than 400.
  //
  // ⚠ DELIBERATELY UNLIKE `territories`, AND UNLIKE THE `[]`→400 RULE COMING
  // IN X3. Those two carry a SELECTION: an empty array means the operator
  // ticked nothing, which is a client bug worth refusing rather than widening
  // into "everything". This field carries a MODE, and its neutral value is a
  // real, meaningful mode — exporting every item is exactly what this route
  // did before X2 existed. Rejecting a typo'd mode would turn a cosmetic
  // client bug into a failed export of the correct default.
  const statusFilter: ExportStatusFilter = isExportStatusFilter(body.statusFilter)
    ? body.statusFilter
    : "all";

  // ── X3 — `[]` IS A 400, AND THAT IS NOT INCONSISTENT WITH THE RULE ABOVE ──
  //
  // ⚠ THE TWO FIELDS ARE DIFFERENT KINDS OF THING, AND A LATER READER WILL BE
  // TEMPTED TO "MAKE THEM CONSISTENT". Do not.
  //   · `statusFilter` carries a MODE. Its neutral value — export every item —
  //     is a real, correct mode: exactly what this route did before X2. A
  //     typo'd mode degrading to the correct default costs nothing.
  //   · `selectedSkus` carries a SELECTION. `[]` means "the operator ticked
  //     nothing", which is a client bug (the dialog disables its own button at
  //     zero). Quietly widening it to "everything" would hand back a file
  //     nobody asked for, and it is indistinguishable from success.
  // ⇒ A bad MODE degrades; a bad SELECTION is refused.
  const rawSkus = body.selectedSkus;
  if (rawSkus !== undefined && rawSkus !== null && !Array.isArray(rawSkus)) {
    return NextResponse.json(
      { error: "selectedSkus must be an array of SKUs, or omitted." },
      { status: 400 },
    );
  }
  if (Array.isArray(rawSkus) && rawSkus.length === 0) {
    return NextResponse.json(
      {
        error:
          "No items selected — nothing to export. Pick at least one item, or " +
          "omit the selection to export them all.",
      },
      { status: 400 },
    );
  }
  const selectedSkus: string[] | null = Array.isArray(rawSkus)
    ? [...new Set(rawSkus.filter((s): s is string => typeof s === "string" && s.trim() !== ""))]
    : null;
  if (Array.isArray(rawSkus) && selectedSkus!.length === 0) {
    return NextResponse.json(
      { error: "selectedSkus contained no usable SKU strings." },
      { status: 400 },
    );
  }

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    // listInAppProducts' return value is structurally a ToolInAppProduct
    // cast to InAppProduct (see publisher-client.ts) — the adapter already
    // normalised listings + prices into that shape.
    const products = await listInAppProducts(jwt, packageName);
    // ⚠ FILTERED ON THE LIVE FETCH, NOT ON THE CACHE. The dialog counts from
    // the mirror so changing the filter is free; the FILE has to be true about
    // Google at the moment it was made. When those disagree, the file follows
    // Google and the counts below let the client say so out loud.
    //
    // ⚠ AND IT COSTS NOTHING EXTRA. `products` is already in hand — the same
    // single paginated list this route always made. Filtering is an array
    // operation, so no filter choice can add a request.
    const live = products as unknown as ToolInAppProduct[];

    // ── X3 — A SKU GOOGLE DOES NOT HAVE IS A 409 THAT NAMES IT ──────────────
    //
    // ⚠ AND THIS IS DELIBERATELY *NOT* WHAT APPLE'S EXPORT DOES. Apple cannot
    // check: its route is handed ids with no list in hand, so it sends them,
    // lets Apple 404, and records the failure in a sheet inside the file
    // (`app/api/iap-management/apps/[appId]/export/route.ts` header). Google's
    // route already holds the complete list after ONE call, so it can answer
    // before building anything — cheaper, and earlier. Porting Apple's
    // behaviour here would manufacture a failure sheet for a question already
    // answered.
    //
    // ⚠ 409, NOT 400: the request is well-formed, it just no longer matches
    // Google. The usual cause is a stale page — an item deleted on Play
    // Console since the list was rendered.
    //
    // ⚠ AND IT LISTS THE SKUs, IT DOES NOT COUNT THEM. "2 unknown SKUs" tells
    // an operator nothing; naming them says immediately which items vanished.
    if (selectedSkus) {
      const onGoogle = new Set(live.map((p) => p.sku ?? ""));
      const unknown = selectedSkus.filter((sku) => !onGoogle.has(sku));
      if (unknown.length > 0) {
        return NextResponse.json(
          {
            error:
              "These items are no longer on Google Play: " +
              `${unknown.join(", ")}. Refresh the list and try again.`,
            unknownSkus: unknown,
          },
          { status: 409 },
        );
      }
    }

    const chosen = selectedSkus
      ? live.filter((p) => selectedSkus.includes(p.sku ?? ""))
      : live;
    const { included, skipped } = partitionByStatusFilter(chosen, statusFilter);
    const plan = buildExportPlan(included, territories);
    const workbook = buildExportWorkbook(plan);
    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const filename = xlsxExportFilename(packageName);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Export-Item-Count": String(plan.rows.length),
        // ⚠ ALWAYS PRESENT, even when 0 and even when the filter is "all".
        // A header that appears only when something was dropped makes its
        // absence ambiguous — "nothing skipped" and "this build does not
        // report skips" would look identical to the client.
        "X-Export-Skipped-Count": String(skipped),
        "X-Export-Status-Filter": statusFilter,
        "X-Export-Selected-Count": String(selectedSkus?.length ?? live.length),
      },
    });
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    const message = e?.message ?? "Failed to generate export";
    const httpStatus =
      typeof e?.code === "number" && e.code >= 400 && e.code < 600
        ? e.code
        : 500;
    return NextResponse.json({ error: message }, { status: httpStatus });
  }
}
