/**
 * Active Google Console account selection — cookie-backed.
 *
 * Q-GIAP.H route-based context resolver: the active Google account lives
 * in a httpOnly cookie scoped to the /google-iap-management/ subtree.
 * Setting it via POST + full-page reload is sufficient v1; no NextAuth
 * JWT mutation is needed because the Apple/Google contexts are mutually
 * exclusive per-route (no cross-context state to keep in sync).
 *
 * Cookie name: `g_iap_active_account` (short to keep header size minimal).
 * Path: `/google-iap-management` (won't leak to other modules).
 * Max-Age: 30 days (matches Manager's typical session length).
 */
import { cookies } from "next/headers";

export const ACTIVE_ACCOUNT_COOKIE = "g_iap_active_account";
const COOKIE_PATH = "/google-iap-management";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Server-side: read the active Google Console account id from cookie. */
export function readActiveAccountId(): string | null {
  const c = cookies().get(ACTIVE_ACCOUNT_COOKIE);
  return c?.value ?? null;
}

/** Server-side: set the active Google Console account cookie. */
export function writeActiveAccountId(accountId: string): void {
  cookies().set({
    name: ACTIVE_ACCOUNT_COOKIE,
    value: accountId,
    path: COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Server-side: clear the active account cookie (e.g. on delete). */
export function clearActiveAccountId(): void {
  cookies().delete(ACTIVE_ACCOUNT_COOKIE);
}

/**
 * Resolve the active Google Console account id with fallback (Hotfix 2).
 *
 * Mirrors the page-side resolver pattern that's duplicated across every
 * /google-iap-management/* page: cookie wins when set + still valid, else
 * first verified account, else first account regardless of status, else
 * null (no accounts configured).
 *
 * Why this exists: the original API routes hard-failed when the cookie
 * was unset, but the single-account Add Account flow never writes the
 * cookie (the header switcher is disabled when accounts.length === 1, so
 * there is no UI path to pin it). The strict path produced "No active
 * Google Console account..." errors even when one account existed and
 * was verified. The page resolvers already had the fallback; this helper
 * lets the API routes adopt the same behaviour symmetrically.
 *
 * Caller contract: pass the result of `listAccounts()` + the result of
 * `readActiveAccountId()`. Caller still owns the empty-list error
 * response — null here means "no accounts configured" (legitimate empty
 * state, not a missing-cookie bug).
 */
export function resolveActiveAccountId(
  accounts: Array<{ id: string; status: string }>,
  cookieActiveId: string | null,
): string | null {
  if (accounts.length === 0) return null;
  if (cookieActiveId && accounts.some((a) => a.id === cookieActiveId)) {
    return cookieActiveId;
  }
  const verified = accounts.find((a) => a.status === "verified");
  if (verified) return verified.id;
  return accounts[0].id;
}
