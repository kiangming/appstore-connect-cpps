/**
 * Authorization helpers for Google IAP Management module — new for the
 * Hub-tracking integration. Mirrors lib/iap-management/auth.ts 1:1 (same
 * global admin/member RBAC, same session.user.role source). The rest of
 * the Google module's routes/pages still use inline `getServerSession`
 * checks (existing convention, left untouched, out of scope) — these
 * helpers are for the new hub-tracking start/cancel/config routes only.
 */

import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";

export class GoogleIapUnauthorizedError extends Error {
  constructor() {
    super("Sign in required for Google IAP Management.");
    this.name = "GoogleIapUnauthorizedError";
  }
}

export class GoogleIapForbiddenError extends Error {
  constructor(reason = "Admin role required for this Google IAP Management action.") {
    super(reason);
    this.name = "GoogleIapForbiddenError";
  }
}

/**
 * Require a signed-in user (any role). Returns the session. Throws
 * `GoogleIapUnauthorizedError` if not authenticated.
 */
export async function requireGoogleIapSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    throw new GoogleIapUnauthorizedError();
  }
  return session;
}

/**
 * Require an admin-role user. Throws `GoogleIapForbiddenError` for
 * non-admins. Used by the Hub-tracking Settings save/read routes.
 */
export async function requireGoogleIapAdmin(): Promise<Session> {
  const session = await requireGoogleIapSession();
  if (session.user.role !== "admin") {
    throw new GoogleIapForbiddenError();
  }
  return session;
}
