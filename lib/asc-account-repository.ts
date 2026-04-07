/**
 * lib/asc-account-repository.ts — Server-side only.
 *
 * Reads ASC accounts from Supabase (encrypted private keys), with:
 * - In-memory cache (5-minute TTL) to avoid DB on every request
 * - Env var fallback (ASC_ACCOUNTS / ASC_KEY_ID legacy) during migration
 *
 * Replaces the module-level cache in lib/asc-accounts.ts.
 */

import { createServerSupabaseClient } from "@/lib/supabase";
import { decryptPrivateKey } from "@/lib/asc-crypto";
import {
  getAscAccounts as getEnvAccounts,
  getAscAccountById as getEnvAccountById,
} from "@/lib/asc-accounts";
import type { AscAccount, AscAccountPublic } from "@/lib/asc-accounts";

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache: { accounts: AscAccount[]; expiresAt: number } | null = null;

function getCached(): AscAccount[] | null {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.accounts;
  return null;
}

function setCache(accounts: AscAccount[]): void {
  _cache = { accounts, expiresAt: Date.now() + CACHE_TTL_MS };
}

export function invalidateAccountCache(): void {
  _cache = null;
}

// ── Supabase row type ─────────────────────────────────────────────────────────

interface AscAccountRow {
  id: string;
  name: string;
  key_id: string;
  issuer_id: string;
  private_key_enc: string;
  is_active: boolean;
}

function rowToAccount(row: AscAccountRow): AscAccount {
  return {
    id: row.id,
    name: row.name,
    keyId: row.key_id,
    issuerId: row.issuer_id,
    privateKey: decryptPrivateKey(row.private_key_enc),
  };
}

// ── Source detection ──────────────────────────────────────────────────────────

function useSupabase(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.ENCRYPTION_KEY
  );
}

// ── Read operations ───────────────────────────────────────────────────────────

export async function findAllAccounts(): Promise<AscAccount[]> {
  if (!useSupabase()) return getEnvAccounts();

  const cached = getCached();
  if (cached) return cached;

  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase
    .from("asc_accounts")
    .select("id, name, key_id, issuer_id, private_key_enc, is_active")
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to load ASC accounts: ${error.message}`);
  if (!data || data.length === 0) {
    // Fallback to env var if DB is empty (migration phase)
    try {
      return getEnvAccounts();
    } catch {
      throw new Error("No ASC accounts found in database or environment.");
    }
  }

  const accounts = (data as AscAccountRow[]).map(rowToAccount);
  setCache(accounts);
  return accounts;
}

export async function findAccountById(id: string): Promise<AscAccount | null> {
  if (!useSupabase()) return getEnvAccountById(id);

  const cached = getCached();
  if (cached) return cached.find((a) => a.id === id) ?? null;

  // Not in cache — fetch all to populate cache, then look up
  const accounts = await findAllAccounts();
  return accounts.find((a) => a.id === id) ?? null;
}

export async function findDefaultAccount(): Promise<AscAccount> {
  const accounts = await findAllAccounts();
  if (accounts.length === 0) throw new Error("No ASC accounts configured.");
  return accounts[0];
}

export async function findAllAccountsPublic(): Promise<AscAccountPublic[]> {
  const accounts = await findAllAccounts();
  return accounts.map(({ id, name, keyId }) => ({ id, name, keyId }));
}

// ── Write operations (admin only) ─────────────────────────────────────────────

export interface CreateAccountInput {
  id: string;
  name: string;
  keyId: string;
  issuerId: string;
  privateKey: string; // raw PEM — will be encrypted before storing
  createdBy: string;
}

export interface UpdateAccountInput {
  name?: string;
  keyId?: string;
  issuerId?: string;
  privateKey?: string; // optional — only update if provided
}

export async function createAccount(input: CreateAccountInput): Promise<void> {
  const { encryptPrivateKey } = await import("@/lib/asc-crypto");
  const supabase = createServerSupabaseClient();

  const { error } = await supabase.from("asc_accounts").insert({
    id: input.id,
    name: input.name,
    key_id: input.keyId,
    issuer_id: input.issuerId,
    private_key_enc: encryptPrivateKey(input.privateKey),
    created_by: input.createdBy,
    is_active: true,
  });

  if (error) throw new Error(`Failed to create account: ${error.message}`);
  invalidateAccountCache();
}

export async function updateAccount(
  id: string,
  input: UpdateAccountInput
): Promise<void> {
  const supabase = createServerSupabaseClient();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.keyId !== undefined) updates.key_id = input.keyId;
  if (input.issuerId !== undefined) updates.issuer_id = input.issuerId;
  if (input.privateKey !== undefined) {
    const { encryptPrivateKey } = await import("@/lib/asc-crypto");
    updates.private_key_enc = encryptPrivateKey(input.privateKey);
  }

  const { error } = await supabase
    .from("asc_accounts")
    .update(updates)
    .eq("id", id);

  if (error) throw new Error(`Failed to update account: ${error.message}`);
  invalidateAccountCache();
}

export async function deleteAccount(id: string): Promise<void> {
  const supabase = createServerSupabaseClient();

  // Soft delete — keeps history
  const { error } = await supabase
    .from("asc_accounts")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(`Failed to delete account: ${error.message}`);
  invalidateAccountCache();
}
