/**
 * Google Console Accounts repository — DB ops only, no API logic.
 *
 * Encryption boundary: all callers see plaintext-IN / public-OUT shapes.
 * Encrypted ciphertext never leaves this module (except via the verify
 * helper that hands the JWT client back to the API layer).
 */
import { googleIapDb } from "../db";
import { encryptCredentials, decryptCredentials } from "../crypto";
import { parseServiceAccountJson } from "../google/auth";

export type AccountStatus = "pending" | "verified" | "invalid";

export interface GoogleConsoleAccountPublic {
  id: string;
  display_name: string;
  service_account_email: string;
  status: AccountStatus;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAccountArgs {
  displayName: string;
  serviceAccountJson: string;
}

/**
 * Insert a new Google Console account. Service account JSON is validated
 * structurally (right `type`, has client_email + private_key) before being
 * encrypted. Stored status starts at 'pending' until the Manager triggers
 * Verify.
 */
export async function createAccount(
  args: CreateAccountArgs,
): Promise<GoogleConsoleAccountPublic> {
  const sa = parseServiceAccountJson(args.serviceAccountJson);
  const encrypted = encryptCredentials(args.serviceAccountJson);

  const { data, error } = await googleIapDb()
    .from("google_console_accounts")
    .insert({
      display_name: args.displayName.trim(),
      service_account_email: sa.client_email,
      encrypted_credentials: encrypted,
      status: "pending",
    })
    .select(
      "id, display_name, service_account_email, status, verified_at, created_at, updated_at",
    )
    .single();

  if (error) {
    // Detect display_name UNIQUE collision so the UI can surface a clear msg.
    if (error.code === "23505") {
      throw new Error("An account with this display name already exists.");
    }
    throw new Error(`Failed to create Google Console account: ${error.message}`);
  }

  return data as GoogleConsoleAccountPublic;
}

export async function listAccounts(): Promise<GoogleConsoleAccountPublic[]> {
  const { data, error } = await googleIapDb()
    .from("google_console_accounts")
    .select(
      "id, display_name, service_account_email, status, verified_at, created_at, updated_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list Google Console accounts: ${error.message}`);
  }
  return (data ?? []) as GoogleConsoleAccountPublic[];
}

export async function getAccountById(
  id: string,
): Promise<GoogleConsoleAccountPublic | null> {
  const { data, error } = await googleIapDb()
    .from("google_console_accounts")
    .select(
      "id, display_name, service_account_email, status, verified_at, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch Google Console account: ${error.message}`);
  }
  return (data as GoogleConsoleAccountPublic | null) ?? null;
}

/**
 * Load the encrypted credentials and return them decrypted. Caller is
 * responsible for not leaking the plaintext (e.g. handing it straight to
 * jwtClientFromServiceAccount).
 */
export async function getDecryptedCredentials(id: string): Promise<string> {
  const { data, error } = await googleIapDb()
    .from("google_console_accounts")
    .select("encrypted_credentials")
    .eq("id", id)
    .single();

  if (error) {
    throw new Error(`Failed to load credentials: ${error.message}`);
  }
  const row = data as { encrypted_credentials: string };
  return decryptCredentials(row.encrypted_credentials);
}

/**
 * Return the raw encrypted blob without decrypting — used when constructing
 * a JWT client via jwtClientFromEncrypted (so the cache key stays stable).
 */
export async function getEncryptedCredentials(id: string): Promise<string> {
  const { data, error } = await googleIapDb()
    .from("google_console_accounts")
    .select("encrypted_credentials")
    .eq("id", id)
    .single();

  if (error) {
    throw new Error(`Failed to load credentials: ${error.message}`);
  }
  const row = data as { encrypted_credentials: string };
  return row.encrypted_credentials;
}

export async function markVerified(id: string): Promise<void> {
  const { error } = await googleIapDb()
    .from("google_console_accounts")
    .update({ status: "verified", verified_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark account verified: ${error.message}`);
  }
}

export async function markInvalid(id: string): Promise<void> {
  const { error } = await googleIapDb()
    .from("google_console_accounts")
    .update({ status: "invalid" })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark account invalid: ${error.message}`);
  }
}

export async function deleteAccount(id: string): Promise<void> {
  const { error } = await googleIapDb()
    .from("google_console_accounts")
    .delete()
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to delete account: ${error.message}`);
  }
}
