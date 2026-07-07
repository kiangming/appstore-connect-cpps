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

export const dynamic = "force-dynamic";

interface ExportRequestBody {
  territories?: string[] | null;
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

  try {
    const encrypted = await getEncryptedCredentials(accountId);
    const jwt = jwtClientFromEncrypted(encrypted);
    // listInAppProducts' return value is structurally a ToolInAppProduct
    // cast to InAppProduct (see publisher-client.ts) — the adapter already
    // normalised listings + prices into that shape.
    const products = await listInAppProducts(jwt, packageName);
    const plan = buildExportPlan(products as unknown as ToolInAppProduct[], territories);
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
