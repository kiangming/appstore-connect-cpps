/**
 * [POOL-key-management-UI] U1 — list + add ASC pool keys.
 *
 * Replaces `scripts/seed-asc-pool-key.mjs` for day-to-day operation. The
 * runbook (`docs/iap-management/RUNBOOK-seed-pool-keys.md`) stays as the
 * dev/emergency path and is NOT superseded.
 *
 * ⚠ THE PRIVATE KEY CROSSES THIS BOUNDARY EXACTLY ONCE, IN THE POST BODY,
 * AND NEVER COMES BACK. It is encrypted before it touches the database and
 * is never logged, never echoed, never returned. The response shape
 * (`PoolKeyAdminRow`) has no field that could carry it even by mistake —
 * `lib/iap-management/key-pool/admin.ts` never selects `private_key_enc`.
 */
import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { encryptPrivateKey } from "@/lib/asc-crypto";
import { findAccountById } from "@/lib/asc-account-repository";
import {
  listAllPoolKeys,
  listAccountOptions,
  insertPoolKey,
  DuplicatePoolKeyError,
} from "@/lib/iap-management/key-pool/admin";
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

export async function GET() {
  try {
    await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }

  try {
    const [keys, accounts] = await Promise.all([
      listAllPoolKeys(),
      listAccountOptions(),
    ]);
    return NextResponse.json({ keys, accounts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(LOG_TAG, `list failed: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let session;
  try {
    session = await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }

  // ⚠ NOT LOGGED. Anywhere. This object holds an Apple private key, and the
  // ordinary debugging reflex — dumping the parsed body on a 400 — would
  // write it to Railway in plaintext, permanently, where the whole team can
  // read it. Every failure path below reports a FIELD NAME, never a value.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body phải là JSON." }, { status: 400 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
  const privateKey = typeof body.privateKey === "string" ? body.privateKey : "";
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  if (!accountId) {
    return NextResponse.json({ error: "Thiếu account." }, { status: 400 });
  }
  if (!keyId) {
    return NextResponse.json({ error: "Thiếu Key ID." }, { status: 400 });
  }

  // ⚠ THE ACCOUNT IS VERIFIED AGAINST THE DATABASE, NOT TRUSTED FROM THE
  // CLIENT. `asc_account_keys.account_id` is a soft TEXT reference with NO
  // foreign key (a cross-schema FK is forbidden), so Postgres will happily
  // store a nonexistent id — and the key would then be invisible to every
  // account forever, with nothing to explain why.
  const account = await findAccountById(accountId);
  if (!account) {
    return NextResponse.json(
      { error: `Account "${accountId}" không tồn tại.` },
      { status: 400 },
    );
  }

  // ⚠ SHAPE-CHECKED BEFORE ENCRYPTING, so a paste accident fails with a
  // sentence instead of succeeding into an unusable row. Encrypting garbage
  // works perfectly — the failure would surface much later, as a decrypt
  // error on a bulk import, looking like a rotated ENCRYPTION_KEY.
  if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
    return NextResponse.json(
      {
        error:
          "Nội dung .p8 không hợp lệ — phải chứa dòng -----BEGIN PRIVATE KEY-----.",
      },
      { status: 400 },
    );
  }

  try {
    // Same routine `asc-account-repository.ts` uses for `asc_accounts`, so a
    // key written here is a key `decryptPrivateKey` can read back. A second
    // encryption path is how the two halves drift.
    const privateKeyEnc = encryptPrivateKey(
      privateKey.trim().replace(/\r\n/g, "\n"),
    );
    await insertPoolKey({
      accountId,
      keyId,
      privateKeyEnc,
      note,
      createdBy: session.user.email ?? "unknown",
    });
  } catch (err) {
    if (err instanceof DuplicatePoolKeyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    await log(LOG_TAG, `add failed account=${accountId} key=${keyId}: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // key_id is documented non-secret and is already printed in full on the
  // `[asc-client] … key=` line; the private key is not mentioned.
  await log(LOG_TAG, `added account=${accountId} key=${keyId}`);
  const keys = await listAllPoolKeys();
  return NextResponse.json({ ok: true, keys });
}
