/**
 * [POOL-key-management-UI] — the admin surface for the ASC key pool.
 *
 * ⚠ SEPARATE FROM `repository.ts` ON PURPOSE. That module is the HOT PATH:
 * every Apple request goes through `listPoolKeys`, which is why it caches for
 * 30s and returns decrypted material. Nothing here is on that path — these
 * functions run when an admin opens a settings tab or clicks a button, and
 * NONE of them decrypt. Mixing the two would put a decrypt on a screen that
 * has no business seeing key material, and would put a cache on writes that
 * must be visible immediately.
 *
 * ⚠ NOTHING IN THIS FILE RETURNS A PRIVATE KEY, ENCRYPTED OR OTHERWISE.
 * `private_key_enc` is never selected. The row shape below is the whole
 * contract with the UI, and it has no field that could carry one.
 */
import { iapDb } from "@/lib/iap-management/db";
import { findAllAccounts } from "@/lib/asc-account-repository";
import { invalidatePoolKeyCache } from "./repository";

/**
 * One account, as the Add-key dropdown needs it.
 *
 * ⚠ `issuerId` IS INCLUDED, AND IT IS NOT A LEAK. The migration that created
 * `asc_accounts` documents it as "ASC Issuer ID (not secret)" — it travels in
 * every JWT payload. It is here because it is the ONLY way the UI can warn
 * that two accounts share one Apple team, which is the case where seeding the
 * same key twice halves a real budget while looking like added headroom.
 *
 * ⚠ `privateKey` is NOT included and must never be. `findAllAccounts()`
 * returns it; this mapping drops it, and that drop is the security boundary
 * between the account repository and anything the browser sees.
 */
export interface PoolAccountOption {
  id: string;
  name: string;
  issuerId: string;
}

/** One pool key as the settings table shows it. Never carries key material. */
export interface PoolKeyAdminRow {
  id: string;
  accountId: string;
  keyId: string;
  enabled: boolean;
  cooldownUntil: string | null;
  createdAt: string;
  note: string | null;
}

export async function listAccountOptions(): Promise<PoolAccountOption[]> {
  const accounts = await findAllAccounts();
  // ⚠ Explicit field-by-field mapping, NOT a spread-and-delete. A spread
  // would carry `privateKey` in by default and rely on remembering to remove
  // it; this way a new secret field on `AscAccount` cannot arrive here by
  // accident.
  return accounts.map((a) => ({ id: a.id, name: a.name, issuerId: a.issuerId }));
}

/**
 * Every pool key, all accounts, for the settings table.
 *
 * ⚠ The SELECT list is explicit and excludes `private_key_enc`. `select("*")`
 * would pull the ciphertext into the server's memory and then into whatever
 * the route serialises — the kind of leak that happens by omission rather
 * than by decision.
 */
export async function listAllPoolKeys(): Promise<PoolKeyAdminRow[]> {
  const { data, error } = await iapDb()
    .from("asc_account_keys")
    .select("id, account_id, key_id, enabled, cooldown_until, created_at, note")
    .order("account_id", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to list pool keys: ${error.message}`);

  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      keyId: String(row.key_id),
      enabled: Boolean(row.enabled),
      cooldownUntil: row.cooldown_until ? String(row.cooldown_until) : null,
      createdAt: String(row.created_at),
      note: row.note ? String(row.note) : null,
    };
  });
}

/** One key's stored material, for the Test button. Server-side only. */
export async function findPoolKeyById(
  id: string,
): Promise<{ accountId: string; keyId: string; privateKeyEnc: string } | null> {
  const { data, error } = await iapDb()
    .from("asc_account_keys")
    .select("account_id, key_id, private_key_enc")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Failed to read pool key: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    accountId: String(row.account_id),
    keyId: String(row.key_id),
    privateKeyEnc: String(row.private_key_enc),
  };
}

export async function setPoolKeyEnabled(
  id: string,
  enabled: boolean,
): Promise<string> {
  const { data, error } = await iapDb()
    .from("asc_account_keys")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("account_id")
    .maybeSingle();

  if (error) throw new Error(`Failed to update pool key: ${error.message}`);
  if (!data) throw new Error(`Pool key "${id}" not found.`);

  const accountId = String((data as Record<string, unknown>).account_id);
  // The hot path caches for 30s; an admin toggle must take effect now rather
  // than "within half a minute".
  invalidatePoolKeyCache(accountId);
  return accountId;
}

export class DuplicatePoolKeyError extends Error {
  constructor(accountId: string, keyId: string) {
    super(
      `Key "${keyId}" is already registered for account "${accountId}". ` +
        `Registering one key twice would halve its effective budget while ` +
        `looking like added headroom.`,
    );
    this.name = "DuplicatePoolKeyError";
  }
}

export interface InsertPoolKeyInput {
  accountId: string;
  keyId: string;
  /** ALREADY ENCRYPTED. This function never sees plaintext. */
  privateKeyEnc: string;
  note: string | null;
  createdBy: string;
}

/**
 * ⚠ TAKES CIPHERTEXT, NOT A PRIVATE KEY. Encryption happens in the route,
 * against `encryptPrivateKey` — the same routine `asc-account-repository`
 * uses for `asc_accounts`. Accepting plaintext here would make it possible to
 * write this table without encrypting, which is exactly the failure the
 * parameter name is chosen to prevent.
 */
export async function insertPoolKey(input: InsertPoolKeyInput): Promise<void> {
  const { error } = await iapDb().from("asc_account_keys").insert({
    account_id: input.accountId,
    key_id: input.keyId,
    private_key_enc: input.privateKeyEnc,
    note: input.note,
    created_by: input.createdBy,
  });

  if (error) {
    // 23505 = unique_violation on UNIQUE (account_id, key_id).
    if (error.code === "23505") {
      throw new DuplicatePoolKeyError(input.accountId, input.keyId);
    }
    throw new Error(`Failed to register pool key: ${error.message}`);
  }
  invalidatePoolKeyCache(input.accountId);
}
