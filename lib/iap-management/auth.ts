/**
 * Authorization helpers for IAP Management module.
 *
 * Q-IAP.8 lock: reuse global admin/member RBAC (no module-specific user
 * whitelist). Session role is set by lib/auth.ts:isAdminEmail at JWT mint
 * time from the ADMIN_EMAILS env var.
 *
 * Hotfix 10 lock interpretation (Manager pivot, 2026-05-21):
 *   - `admin` role: Settings only — pricing tiers, pricing templates,
 *     ASC account credentials (the latter sits in the global /settings
 *     page, not this module).
 *   - `member` role: full IAP module access — list, view, create, edit,
 *     submit, bulk-import. Internal-tool blast radius is low (Q-IAP.8
 *     rationale), team workflow needs members to drive the day-to-day
 *     IAP lifecycle while admins curate the pricing catalog.
 *
 * Prior encoding (Cycle 29 → Hotfix 9) required admin for IAP CRUD;
 * Hotfix 10 unblocks non-admin team members who were redirected to
 * Hub when clicking Create IAP / Bulk Import.
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
 * Use ONLY for the Settings-tier surface: pricing tiers, pricing
 * templates (CRUD on the catalog the rest of the module reads from).
 * Per Hotfix 10 lock pivot, IAP CRUD / submit / bulk-import are NOT
 * admin-only — use `requireIapSession` for those.
 */
export async function requireIapAdmin(): Promise<Session> {
  const session = await requireIapSession();
  if (session.user.role !== "admin") {
    throw new IapForbiddenError();
  }
  return session;
}
