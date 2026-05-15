import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);

/**
 * POST /api/iap-management/iaps/[iapId]/screenshot
 *
 * v1: registers a screenshot record in iap_mgmt.iap_screenshots with
 * apple_id NULL (= pending). Validates the file (PNG/JPEG, ≤ 8MB).
 * The actual Apple 3-step upload (reserve → PUT presigned → confirm)
 * is deferred to the submit flow (or IAP.i bulk wizard) where the IAP
 * already exists on Apple. Apple's reserveInAppPurchaseScreenshot requires
 * an inAppPurchase_id that the draft doesn't have yet.
 *
 * Marking the filename present enables the screenshot prerequisite in
 * the submit checklist (Q-IAP.h.3); the real upload runs at submit-time.
 */
export async function POST(
  req: Request,
  ctx: { params: { iapId: string } },
) {
  try {
    await requireIapAdmin();
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
    return NextResponse.json({ error: "Invalid form body." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json(
      { error: 'Missing "file" field.' },
      { status: 400 },
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: `File exceeds 8MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB).` },
      { status: 422 },
    );
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported type "${file.type}". PNG or JPEG required.` },
      { status: 422 },
    );
  }

  const db = iapDb();

  // Replace any existing pending row for this IAP (one screenshot per IAP).
  await db
    .from("iap_screenshots")
    .delete()
    .eq("iap_id", ctx.params.iapId)
    .is("apple_id", null);

  const ins = await db
    .from("iap_screenshots")
    .insert({
      iap_id: ctx.params.iapId,
      file_name: file.name,
      file_size: file.size,
      apple_id: null,
      uploaded_at: null,
    })
    .select("id, file_name")
    .single();
  if (ins.error || !ins.data) {
    const msg = ins.error?.message ?? "Insert failed";
    await log("iap-screenshot", `db error: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const row = ins.data as { id: string; file_name: string };
  await log(
    "iap-screenshot",
    `registered ${file.name} (${file.size}B) for iap=${ctx.params.iapId}`,
  );

  return NextResponse.json({ id: row.id, filename: row.file_name });
}
