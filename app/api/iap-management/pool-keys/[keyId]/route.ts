/**
 * [POOL-key-management-UI] U1 — enable / disable one pool key.
 *
 * ⚠ THERE IS NO DELETE, AND THAT IS THE DESIGN. Disabling keeps the row, so
 * `created_at`, `created_by` and `note` survive as the record of what was
 * registered and when. A hard delete would erase the audit trail for the one
 * table where "which key was live at 3pm" is the question worth answering
 * after an incident. Revoking on Apple's side is the real kill switch and
 * happens there.
 */
import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { setPoolKeyEnabled, listAllPoolKeys } from "@/lib/iap-management/key-pool/admin";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_TAG = "pool-keys";

function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof IapUnauthorizedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof IapForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  throw err;
}

export async function PATCH(
  request: Request,
  ctx: { params: { keyId: string } },
) {
  try {
    await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body phải là JSON." }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: 'Thiếu trường "enabled" (true/false).' },
      { status: 400 },
    );
  }
  // ⚠ Lifted out of `body` before it is used, so no log line in this file
  // ever references the request body. The value here is only a boolean and
  // would be harmless — but "no log call mentions `body`" is a bright line
  // that stays true under later edits, whereas "only log the safe fields"
  // needs re-auditing every time a field is added. The structural guard
  // enforces the bright line.
  const enabled = body.enabled;

  try {
    const accountId = await setPoolKeyEnabled(ctx.params.keyId, enabled);
    await log(
      LOG_TAG,
      `${enabled ? "enabled" : "disabled"} account=${accountId} row=${ctx.params.keyId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(LOG_TAG, `toggle failed row=${ctx.params.keyId}: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true, keys: await listAllPoolKeys() });
}
