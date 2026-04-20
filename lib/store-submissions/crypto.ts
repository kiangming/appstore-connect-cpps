/**
 * AES-256-GCM token encryption for Store Management.
 *
 * Used to encrypt Gmail OAuth access/refresh tokens before writing to
 * `store_mgmt.gmail_credentials`. Keeps tokens unreadable at rest if the
 * Postgres row or a DB backup leaks.
 *
 * Output layout (base64):
 *   base64( iv(12) || authTag(16) || ciphertext(N) )
 *
 *   - iv:         12 bytes (96-bit random nonce, GCM-recommended)
 *   - authTag:    16 bytes (128-bit GCM authentication tag)
 *   - ciphertext: variable length (== plaintext length for CTR-mode-under-GCM)
 *
 * ⚠ NEVER rotate `GMAIL_ENCRYPTION_KEY` in production — rotating invalidates
 * every token row. Re-auth is the only recovery. See CLAUDE.md invariant #10.
 *
 * Error messages are intentionally generic — we don't leak byte offsets or
 * tamper-vs-wrong-key distinctions so an attacker can't probe ciphertexts.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

function getKey(): Buffer {
  const hex = process.env.GMAIL_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'GMAIL_ENCRYPTION_KEY env var is missing. ' +
        'Generate: openssl rand -hex 32. NEVER rotate in production.',
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `GMAIL_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (hex of length ${KEY_BYTES * 2}).`,
    );
  }
  return key;
}

/**
 * Encrypt a plaintext token with AES-256-GCM.
 *
 * Returns base64-encoded `iv || authTag || ciphertext`. Each call produces a
 * fresh random IV, so encrypting the same plaintext twice yields different
 * ciphertexts (semantic security).
 */
export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Plaintext must be a non-empty string.');
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a token produced by `encryptToken`.
 *
 * Throws a generic `Error` on any failure (malformed input, wrong key,
 * tampered ciphertext, wrong tag). Callers should log context but not
 * surface the thrown message to users.
 */
export function decryptToken(encrypted: string): string {
  if (typeof encrypted !== 'string' || encrypted.length === 0) {
    throw new Error('Invalid ciphertext format.');
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(encrypted, 'base64');
  } catch {
    throw new Error('Invalid ciphertext format.');
  }
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Invalid ciphertext format.');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const key = getKey();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('Decryption failed.');
  }
}
