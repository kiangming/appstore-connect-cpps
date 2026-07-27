/**
 * Server-side session guard for Store Management routes.
 *
 * Pairs NextAuth Google SSO (shared login) with Store Management's own
 * whitelist in store_mgmt.users. Each call does a fresh DB lookup so that
 * disabling a user takes effect immediately without token rotation.
 *
 * Usage in Server Components / route handlers:
 *
 *   export default async function Page() {
 *     const { storeUser } = await requireStoreSession();
 *     // storeUser.role is 'MANAGER' | 'DEV' | 'VIEWER'
 *   }
 */

import { getServerSession, type Session } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getStoreUser,
  syncStoreProfile,
  type StoreRole,
  type StoreUser,
} from './auth';

export interface StoreSession {
  session: Session;
  storeUser: StoreUser;
}

/**
 * Require a valid NextAuth session AND an active store_mgmt.users whitelist entry.
 * Redirects:
 *   - no session → /login
 *   - session but not whitelisted (or disabled) → / (hub)
 *
 * The `/store-submissions/*` layout renders an inline 403 screen for the
 * not-whitelisted case; these redirects are defensive backstops for callers
 * that invoke this guard outside the layout (e.g. deep server actions).
 */
export async function requireStoreSession(): Promise<StoreSession> {
  const perfT0 = Date.now();
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect('/login');
  }

  const storeUser = await getStoreUser(session.user.email);
  if (!storeUser) {
    redirect('/');
  }

  // T1-1(b): telemetry write is fire-and-forget — it must never delay the page
  // render (its own comment already promises it "must never break login").
  // MANDATORY `.catch`: dropping the `await` without one would surface an
  // unhandled promise rejection if the write ever throws. A failed write is
  // logged and swallowed; it never reaches the user or crashes the request.
  void syncStoreProfile({
    userId: storeUser.id,
    googleSub: session.user.id ?? null,
    displayName: session.user.name ?? null,
    avatarUrl: session.user.image ?? null,
  }).catch((err) => {
    console.error('[store-auth] syncStoreProfile (non-blocking) failed:', err);
  });

  // [perf-probe] TEMPORARY: wave time for the per-navigation guard chain
  // (getServerSession + the now-deduped getStoreUser). Compare against the
  // single-query getStoreUser probe to see how much is auth overhead. No PII.
  if (process.env.NODE_ENV !== 'test') {
    void log('perf-probe', `requireStoreSession chain dur_ms=${Date.now() - perfT0}`);
  }

  return { session, storeUser };
}

/**
 * Require store session + role. Redirects to /store-submissions/inbox if
 * user is whitelisted but lacks the required role (soft rejection — they
 * can still use the module, just not this page).
 */
export async function requireStoreSessionWithRole(
  requiredRole: StoreRole | StoreRole[]
): Promise<StoreSession> {
  const ctx = await requireStoreSession();
  const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  if (!allowed.includes(ctx.storeUser.role)) {
    redirect('/store-submissions/inbox');
  }
  return ctx;
}
