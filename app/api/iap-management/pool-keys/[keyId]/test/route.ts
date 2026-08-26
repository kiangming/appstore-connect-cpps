/**
 * [POOL-key-management-UI] U1 — "Test key": prove ONE specific key works for
 * the account it is registered under.
 *
 * This replaces the runbook's manual self-check (seed → SQL → eyeball →
 * Refresh from Apple → grep Railway). It answers the Manager's actual
 * question — "did I attach this key to the right account?" — in one click.
 *
 * ⚠ THE POOL IS DELIBERATELY NOT PASSED TO `appleFetch`, AND THAT IS THE
 * ENTIRE POINT OF THIS ROUTE. `appleFetch` selects a key ONLY when it is
 * handed a pool:
 *
 *     const selection = opts?.keyPool ? await opts.keyPool.select(account)
 *                                     : { creds: account, fromPool: false };
 *
 * With no pool it signs with exactly the credentials given. So passing
 * `{ keyPool }` here would test whatever key ROTATION happened to pick —
 * which is not the key on the row the Manager clicked, and on a two-key
 * account would be the other one half the time. A green tick that verified a
 * different key than the one named is worse than no button: it is a false
 * negative for the one failure this exists to catch.
 *
 * ⚠ WHY `/v1/territories?limit=1`. It is the cheapest authenticated read, it
 * needs no app id, and — KB §4.9 — it is one of the endpoints that DOES
 * return `x-rate-limit`. The two IAP endpoints (`GET /v2/inAppPurchases/{id}`
 * and the price-schedule read) omit that header entirely, so testing against
 * one of those could confirm the key works but could never show the budget.
 *
 * ─── READING THE D1 VERDICT FROM THIS ROUTE'S LOGS ─────────────────────────
 *
 * `[Q-POOLUI.no-d1-button]` — v1 ships no "measure rate-limit scope" button,
 * because this route already emits everything the measurement needs. For an
 * account with two keys, click Test on each within a few seconds and read the
 * two adjacent lines:
 *
 *   [key-pool-test] account=acct key=KEY_A status=200 rem=3589 lim=3600
 *   [key-pool-test] account=acct key=KEY_B status=200 rem=3599 lim=3600
 *                                                        ^^^^ = lim − 1
 *   → PER-KEY. Each key has its own hourly budget; the pool works.
 *
 *   [key-pool-test] account=acct key=KEY_A status=200 rem=3589 lim=3600
 *   [key-pool-test] account=acct key=KEY_B status=200 rem=3588 lim=3600
 *                                                        ^^^^ already charged
 *                                                        for KEY_A's traffic
 *   → PER-TEAM. Extra keys add nothing. STOP the pool and report it: per
 *     TODO.md `[RATELIMIT-keypool-design]`, the pool stays dark PERMANENTLY
 *     and the code is NOT removed (with an empty table the fallback path is
 *     the pre-pool path, so keeping it costs nothing and removing it is pure
 *     risk).
 *
 * ⚠ The two lines must be close together in time. Apple's window is a rolling
 * hour, so `rem` recovers continuously; minutes apart, a per-team pool can
 * look per-key.
 */
import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { appleFetch, AppleApiError, type RateLimitInfo } from "@/lib/shared/apple-fetch";
import { decryptPrivateKey } from "@/lib/asc-crypto";
import { findAccountById } from "@/lib/asc-account-repository";
import { findPoolKeyById } from "@/lib/iap-management/key-pool/admin";
import { poolKeyToCredentials } from "@/lib/iap-management/key-pool/repository";
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

export async function POST(
  _request: Request,
  ctx: { params: { keyId: string } },
) {
  try {
    await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }

  const row = await findPoolKeyById(ctx.params.keyId);
  if (!row) {
    return NextResponse.json({ error: "Key không tồn tại." }, { status: 404 });
  }

  const account = await findAccountById(row.accountId);
  if (!account) {
    return NextResponse.json(
      {
        error:
          `Key này gắn với account "${row.accountId}", nhưng account đó không ` +
          `còn tồn tại. Disable key rồi thêm lại dưới đúng account.`,
      },
      { status: 409 },
    );
  }

  let privateKey: string;
  try {
    privateKey = decryptPrivateKey(row.privateKeyEnc);
  } catch {
    // ⚠ The cipher error is NOT forwarded. It says "unable to authenticate
    // data", which sends an operator hunting the wrong thing.
    return NextResponse.json(
      {
        error:
          `Không giải mã được key ${row.keyId}. Hoặc dòng dữ liệu hỏng, hoặc ` +
          `ENCRYPTION_KEY đã đổi so với lúc key được thêm.`,
      },
      { status: 500 },
    );
  }

  // ⚠ issuerId comes from the ACCOUNT, keyId + privateKey from THE ROW. That
  // pairing is what makes a mis-assigned key fail closed: a key from another
  // team signed with this account's issuer is rejected by Apple with 401
  // rather than granting access to the other team.
  const creds = poolKeyToCredentials(account, {
    id: ctx.params.keyId,
    keyId: row.keyId,
    privateKey,
    cooldownUntil: null,
  });

  let budget: RateLimitInfo | null = null;
  try {
    await appleFetch<unknown>(
      creds,
      "GET",
      "/v1/territories?limit=1",
      undefined,
      LOG_TAG,
      // ⚠ NO `keyPool` HERE. See the header comment — passing one would test
      // a rotated key instead of this row's key.
      { onRateLimitInfo: (info) => { budget = info; } },
    );
  } catch (err) {
    const status = err instanceof AppleApiError ? err.status : undefined;
    await log(
      LOG_TAG,
      `[key-pool-test] account=${row.accountId} key=${row.keyId} status=${status ?? "error"} rem=- lim=-`,
    );

    if (status === 401 || status === 403) {
      return NextResponse.json(
        {
          ok: false,
          kind: "WRONG_TEAM",
          keyId: row.keyId,
          accountName: account.name,
          error:
            `Key ${row.keyId} không thuộc team của account "${account.name}". ` +
            `Apple trả ${status}. Key này được tạo ở một team Apple khác, hoặc đã bị revoke.`,
        },
        { status: 200 },
      );
    }

    // ⚠ Anything else is reported AS-IS rather than guessed at. A 503 means
    // "ask again later", not "this key is wrong" — and telling a Manager to
    // re-register a perfectly good key because Apple had a bad minute is the
    // expensive mistake here.
    return NextResponse.json(
      {
        ok: false,
        kind: "UNKNOWN",
        keyId: row.keyId,
        accountName: account.name,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }

  const info = budget as RateLimitInfo | null;
  await log(
    LOG_TAG,
    `[key-pool-test] account=${row.accountId} key=${row.keyId} status=200 ` +
      `rem=${info?.remaining ?? "-"} lim=${info?.limit ?? "-"}`,
  );

  return NextResponse.json({
    ok: true,
    kind: "OK",
    keyId: row.keyId,
    accountName: account.name,
    remaining: info?.remaining ?? null,
    limit: info?.limit ?? null,
  });
}
