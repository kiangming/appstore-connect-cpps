/**
 * Authorization helpers for Store Management module.
 *
 * Login: shared Google SSO via NextAuth (workspace-wide).
 * Authorization: Store Management maintains its own whitelist in store_mgmt.users.
 *
 * Flow:
 *   1. NextAuth validates Google login → session.user.email
 *   2. For /store-submissions/* routes, check email exists in store_mgmt.users
 *      with status='active'
 *   3. Attach role (MANAGER/DEV/VIEWER) to session context for RBAC
 */

import { storeDb } from './db';

export type StoreRole = 'MANAGER' | 'DEV' | 'VIEWER';

export interface StoreUser {
  id: string;
  email: string;
  role: StoreRole;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'disabled';
}

/**
 * Look up Store Management whitelist by email.
 * Returns null if email not whitelisted or user disabled.
 */
export async function getStoreUser(email: string): Promise<StoreUser | null> {
  const normalized = email.trim().toLowerCase();
  const { data, error } = await storeDb()
    .from('users')
    .select('id, email, role, display_name, avatar_url, status')
    .ilike('email', normalized)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    console.error('[store-auth] Failed to query user:', error);
    return null;
  }
  return data as StoreUser | null;
}

/**
 * Assert session user has access to Store Management module.
 * Throws ForbiddenError if not whitelisted.
 */
export async function requireStoreAccess(
  sessionEmail: string | null | undefined
): Promise<StoreUser> {
  if (!sessionEmail) {
    throw new StoreUnauthorizedError('No session');
  }
  const user = await getStoreUser(sessionEmail);
  if (!user) {
    throw new StoreForbiddenError(
      'Email not whitelisted in Store Management. Contact Manager.'
    );
  }
  return user;
}

/**
 * Assert user has specific role.
 * Use inside Server Actions/API Routes after requireStoreAccess.
 */
export async function requireStoreRole(
  sessionEmail: string | null | undefined,
  requiredRole: StoreRole | StoreRole[]
): Promise<StoreUser> {
  const user = await requireStoreAccess(sessionEmail);
  const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  if (!allowed.includes(user.role)) {
    throw new StoreForbiddenError(
      `Required role: ${allowed.join(' or ')}. Current role: ${user.role}.`
    );
  }
  return user;
}

/**
 * Update last_login_at when user enters Store Management.
 * Call once per session entry.
 */
export async function touchLastLogin(userId: string): Promise<void> {
  await storeDb()
    .from('users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', userId);
}

export interface GoogleProfileSync {
  userId: string;
  googleSub?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/**
 * Sync Google profile fields + touch last_login_at on every guard pass.
 *
 * - Writes only provided fields (undefined → skip), so callers may pass
 *   whatever NextAuth surfaces without clobbering admin-set values with null.
 * - `last_login_at` is always refreshed.
 * - Failures are logged and swallowed: telemetry must never break login.
 * - `google_sub` is UNIQUE in the schema; a collision (e.g. account merge)
 *   will be logged but won't throw.
 */
export async function syncStoreProfile(input: GoogleProfileSync): Promise<void> {
  const patch: Record<string, string> = {
    last_login_at: new Date().toISOString(),
  };
  if (input.googleSub) patch.google_sub = input.googleSub;
  if (input.displayName) patch.display_name = input.displayName;
  if (input.avatarUrl) patch.avatar_url = input.avatarUrl;

  const { error } = await storeDb()
    .from('users')
    .update(patch)
    .eq('id', input.userId);

  if (error) {
    console.error('[store-auth] syncStoreProfile failed:', error);
  }
}

// === Error classes ===

export class StoreUnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'StoreUnauthorizedError';
  }
}

export class StoreForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'StoreForbiddenError';
  }
}

/**
 * Map errors to HTTP response for API Routes.
 */
export function mapAuthErrorToResponse(err: unknown): Response | null {
  if (err instanceof StoreUnauthorizedError) {
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: err.message } },
      { status: 401 }
    );
  }
  if (err instanceof StoreForbiddenError) {
    return Response.json(
      { error: { code: 'FORBIDDEN', message: err.message } },
      { status: 403 }
    );
  }
  return null;
}
