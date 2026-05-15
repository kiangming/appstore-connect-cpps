/**
 * Authorization helpers for IAP Management module.
 *
 * Q-IAP.8 lock: reuse global admin/member RBAC (no module-specific user
 * whitelist). Session role is set by lib/auth.ts:isAdminEmail at JWT mint
 * time from the ADMIN_EMAILS env var. Manager-only actions (price tier
 * import, IAP CRUD, submit to Apple) require `role === "admin"`; read-only
 * routes can allow members.
 */

import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";

export class IapUnauthorizedError extends Error {
  constructor() {
    super("Sign in required for IAP Management.");
    this.name = "IapUnauthorizedError";
  }
}

export class IapForbiddenError extends Error {
  constructor(reason = "Admin role required for this IAP Management action.") {
    super(reason);
    this.name = "IapForbiddenError";
  }
}

/**
 * Require a signed-in user (any role). Returns the session. Throws
 * `IapUnauthorizedError` if not authenticated.
 */
export async function requireIapSession(): Promise<Session> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    throw new IapUnauthorizedError();
  }
  return session;
}

/**
 * Require an admin-role user. Throws `IapForbiddenError` for non-admins.
 * Use for Manager-only mutations: price tier import, IAP CRUD, submit
 * to Apple, etc.
 */
export async function requireIapAdmin(): Promise<Session> {
  const session = await requireIapSession();
  if (session.user.role !== "admin") {
    throw new IapForbiddenError();
  }
  return session;
}
