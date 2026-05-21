/**
 * Active Google Console account selection — cookie-backed.
 *
 * Q-GIAP.H route-based context resolver: the active Google account lives
 * in a httpOnly cookie. Setting it via POST + full-page reload is
 * sufficient v1; no NextAuth JWT mutation is needed because the
 * Apple/Google contexts are mutually exclusive per-route (no cross-
 * context state to keep in sync).
 *
 * Cookie name: `g_iap_active_account` (short to keep header size minimal).
 * Max-Age: 30 days (matches Manager's typical session length).
 *
 * Hotfix 6 — path: `/`. The original design used path
 * `/google-iap-management` thinking it would prevent "leaking" the
 * cookie to other modules, but RFC 6265 §5.1.4 path-match means that
 * scope does NOT cover `/api/google-iap-management/*` (a different
 * URL prefix entirely). So API routes never saw the cookie — they
 * silently fell back to first-verified via resolveActiveAccountId,
 * making the switcher's selection appear to do nothing and Hotfix 2's
 * "pin only if no active" overwrite on every Add. Module isolation is
 * enforced by code (other modules don't read this cookie name), not
 * by cookie path. Path=`/` is the correct scope.
 */
import { cookies } from "next/headers";

export const ACTIVE_ACCOUNT_COOKIE = "g_iap_active_account";
const COOKIE_PATH = "/";
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
  // Hotfix 6 migration: existing browser sessions may carry a stale
  // cookie at the old `/google-iap-management` path (set before this
  // fix). RFC 6265 §5.4 sends the longer-path cookie first; without
  // explicit cleanup the dashboard pages would keep reading the stale
  // value. One `Set-Cookie` with `Max-Age=0` at the old path clears
  // it on the very next switch. Remove this migration shim after the
  // 30-day cookie max-age window has lapsed.
  cookies().set({
    name: ACTIVE_ACCOUNT_COOKIE,
    value: "",
    path: "/google-iap-management",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  });
}

/** Server-side: clear the active account cookie (e.g. on delete).
 *  Must reuse the same path/attribute the set call used; the browser
 *  treats (name, path, domain) as the cookie identity. */
export function clearActiveAccountId(): void {
  cookies().set({
    name: ACTIVE_ACCOUNT_COOKIE,
    value: "",
    path: COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  });
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
