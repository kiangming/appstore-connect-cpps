/**
 * lib/asc-crypto.ts — Server-side only.
 *
 * AES-256-GCM authenticated encryption for ASC private keys stored in Supabase.
 *
 * Env var: ENCRYPTION_KEY — 32-byte hex string (64 hex chars)
 * Generate: openssl rand -hex 32
 *
 * Stored format (single base64 string):
 *   base64( iv[16 bytes] + authTag[16 bytes] + ciphertext[N bytes] )
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes). " +
        "Generate with: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptPrivateKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext → base64
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptPrivateKey(packed: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(packed, "base64");

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}
