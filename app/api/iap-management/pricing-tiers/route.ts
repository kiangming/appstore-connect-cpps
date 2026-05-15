import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { parsePriceTiersXlsx } from "@/lib/iap-management/parsers/price-tiers";
import { replacePriceTiers } from "@/lib/iap-management/queries/price-tiers";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/iap-management/pricing-tiers
 *
 * Manager uploads a price-tiers-template.xlsx. Parser validates header
 * format strictly (Q-IAP.5); on success the existing cache is wiped and
 * replaced (Q-IAP.7).
 *
 * Admin-only (Q-IAP.8). Failures return JSON `{ error }`. Successes return
 * batch metadata for the UI to surface in a toast.
 */
export async function POST(req: Request) {
  let session;
  try {
    session = await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof IapForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart request body." },
      { status: 400 },
    );
  }
  if (!file) {
    return NextResponse.json(
      { error: 'Missing "file" field in form data.' },
      { status: 400 },
    );
  }

  // ── Parse (throws on validation failure) ───────────────────────────────
  let parsed;
  try {
    parsed = await parsePriceTiersXlsx(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed";
    await log("iap-pricing-tiers", `parse error: ${message}`, "WARN");
    return NextResponse.json({ error: message }, { status: 422 });
  }

  // ── Replace cache (transactional best-effort) ──────────────────────────
  try {
    const result = await replacePriceTiers(parsed, session.user.email ?? "unknown");
    await log(
      "iap-pricing-tiers",
      `import ok by ${session.user.email}: ${result.inserted_tier_count} tiers, ${result.inserted_territory_count} territory rows`,
    );
    return NextResponse.json(
      {
        batch_id: result.batch_id,
        inserted_tier_count: result.inserted_tier_count,
        inserted_territory_count: result.inserted_territory_count,
        alternate_count: parsed.alternate_tier_count,
        warnings: parsed.warnings,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    await log("iap-pricing-tiers", `import error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
