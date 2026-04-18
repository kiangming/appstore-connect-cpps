/**
 * Server-side read queries for Store Management users.
 *
 * Mutations live in Server Actions (app/.../config/team/actions.ts).
 * These read helpers are safe to call from Server Components + Server Actions.
 */

import { storeDb } from '../db';
import type { StoreRole } from '../auth';

export interface TeamUser {
  id: string;
  email: string;
  role: StoreRole;
  display_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'disabled';
  last_login_at: string | null;
  created_at: string;
}

const USER_COLUMNS =
  'id, email, role, display_name, avatar_url, status, last_login_at, created_at';

export async function listUsers(): Promise<TeamUser[]> {
  const { data, error } = await storeDb()
    .from('users')
    .select(USER_COLUMNS)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[store-users] listUsers failed:', error);
    throw new Error('Failed to load users');
  }
  return (data ?? []) as TeamUser[];
}

export async function getUserById(id: string): Promise<TeamUser | null> {
  const { data, error } = await storeDb()
    .from('users')
    .select(USER_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[store-users] getUserById failed:', error);
    throw new Error('Failed to load user');
  }
  return (data as TeamUser | null) ?? null;
}

/**
 * Count active MANAGER accounts.
 *
 * Used by Server Actions to enforce the "≥1 active MANAGER" invariant before
 * demoting or disabling a user. Callers that need a race-safe check must
 * perform this inside a transaction with FOR UPDATE locks — this helper alone
 * is susceptible to TOCTOU.
 */
export async function countActiveManagers(): Promise<number> {
  const { count, error } = await storeDb()
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'MANAGER')
    .eq('status', 'active');

  if (error) {
    console.error('[store-users] countActiveManagers failed:', error);
    throw new Error('Failed to count managers');
  }
  return count ?? 0;
}
