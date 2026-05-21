/**
 * TEMPORARY diagnostic endpoint for Hotfix 7 investigation.
 *
 * Surfaces the exact cookie state the server sees on a given request,
 * plus how resolveActiveAccountId() resolves it against the accounts
 * list. Manager hits this once to confirm whether the cookie write
 * landed at all.
 *
 * REMOVE after Hotfix 7 ships verified.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import {
  ACTIVE_ACCOUNT_COOKIE,
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allCookies = cookies().getAll();
  // Both .get() and .getAll(name) for the active-account cookie so we
  // can see if multiple entries with the same name exist (pre-Hotfix-6
  // legacy + new write).
  const activeCookieGet = cookies().get(ACTIVE_ACCOUNT_COOKIE);
  const activeCookieAll = cookies().getAll(ACTIVE_ACCOUNT_COOKIE);
  const readResult = readActiveAccountId();
  const accounts = await listAccounts().catch(() => []);
  const resolved = resolveActiveAccountId(accounts, readResult);

  let resolutionPath: string;
  if (readResult && accounts.some((a) => a.id === readResult)) {
    resolutionPath = "cookie-match";
  } else if (accounts.find((a) => a.status === "verified")) {
    resolutionPath = "first-verified-fallback";
  } else if (accounts.length > 0) {
    resolutionPath = "first-overall-fallback";
  } else {
    resolutionPath = "no-accounts";
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    note: "TEMPORARY — Hotfix 7 diagnostic. Remove after fix verified.",
    cookie: {
      name: ACTIVE_ACCOUNT_COOKIE,
      "cookies().get()": activeCookieGet ?? null,
      "cookies().getAll(name).length": activeCookieAll.length,
      "cookies().getAll(name)": activeCookieAll,
      "readActiveAccountId()": readResult,
    },
    allCookiesOnRequest: allCookies.map((c) => ({
      name: c.name,
      valuePreview: c.value ? `${c.value.slice(0, 8)}…(${c.value.length} chars)` : "",
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      idPreview: `${a.id.slice(0, 8)}…`,
      displayName: a.display_name,
      status: a.status,
    })),
    resolved: {
      accountId: resolved,
      accountIdPreview: resolved ? `${resolved.slice(0, 8)}…` : null,
      resolutionPath,
    },
  });
}
