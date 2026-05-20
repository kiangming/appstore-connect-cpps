/**
 * AES-256-GCM credential encryption for Google IAP Management.
 *
 * Used to encrypt Service Account JSON blobs before writing to
 * `google_iap_mgmt.google_console_accounts.encrypted_credentials`. Keeps
 * private keys unreadable at rest if the Postgres row or a DB backup leaks.
 *
 * Mirrors lib/store-submissions/crypto.ts (Gmail token encryption) — same
 * AES-256-GCM construction, base64 layout `iv(12) || tag(16) || ct(N)`, fresh
 * IV per call. Separate env var so credential keys live independently of
 * Gmail token keys (rotating either is destructive; see invariant #10).
 *
 * ⚠ NEVER rotate `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` in production —
 * rotating invalidates every stored credential. Re-upload is the only recovery.
 *
 * Error messages are intentionally generic — we don't leak byte offsets or
 * tamper-vs-wrong-key distinctions so an attacker can't probe ciphertexts.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

function getKey(): Buffer {
  const hex = process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "GOOGLE_CREDENTIALS_ENCRYPTION_KEY env var is missing. " +
        "Generate: openssl rand -hex 32. NEVER rotate in production.",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `GOOGLE_CREDENTIALS_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (hex of length ${KEY_BYTES * 2}).`,
    );
  }
  return key;
}

/**
 * Encrypt a Service Account JSON blob (or any UTF-8 plaintext) with
 * AES-256-GCM. Each call produces a fresh random IV.
 */
export function encryptCredentials(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Plaintext must be a non-empty string.");
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a credential blob produced by `encryptCredentials`.
 *
 * Throws a generic `Error` on any failure (malformed input, wrong key,
 * tampered ciphertext, wrong tag). Callers should log context but not
 * surface the thrown message to users.
 */
export function decryptCredentials(encrypted: string): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    throw new Error("Invalid ciphertext format.");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(encrypted, "base64");
  } catch {
    throw new Error("Invalid ciphertext format.");
  }
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("Invalid ciphertext format.");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const key = getKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new Error("Decryption failed.");
  }
}
