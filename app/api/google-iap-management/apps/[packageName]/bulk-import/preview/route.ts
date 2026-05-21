/**
 * Bulk-import preview endpoint (g1.i).
 *
 * Accepts a multipart-form Excel upload, parses it via the IAP template
 * parser, looks up which SKUs already exist in cache, and returns a
 * structured preview the wizard can render. Does NOT call Google.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { listIapsForApp } from "@/lib/google-iap-management/repository/iaps";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { parseIapTemplate } from "@/lib/google-iap-management/parsers/excel-parser";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "'file' field is required." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes); cap is ${MAX_BYTES}.` },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parseIapTemplate(buffer);
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { errors: parsed.errors, warnings: parsed.warnings },
      { status: 422 },
    );
  }

  const existing = await listIapsForApp(app.id).catch(() => []);
  const existingSkus = new Set(existing.map((i) => i.sku));

  const rows = parsed.rows.map((row) => ({
    ...row,
    exists: existingSkus.has(row.sku),
  }));

  return NextResponse.json({
    filename: file.name,
    rows,
    warnings: parsed.warnings,
    counts: {
      total: rows.length,
      existing: rows.filter((r) => r.exists).length,
      new: rows.filter((r) => !r.exists).length,
    },
  });
}
