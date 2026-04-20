import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';

const TEST_KEY = randomBytes(32).toString('hex');
const ALT_KEY = randomBytes(32).toString('hex');

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.GMAIL_ENCRYPTION_KEY;
  process.env.GMAIL_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.GMAIL_ENCRYPTION_KEY;
  else process.env.GMAIL_ENCRYPTION_KEY = originalKey;
});

async function loadCrypto() {
  // fresh import so getKey() re-reads env for env-override tests
  const mod = await import('./crypto');
  return mod;
}

describe('encryptToken / decryptToken', () => {
  it('round-trips plaintext unchanged', async () => {
    const { encryptToken, decryptToken } = await loadCrypto();
    const plain = 'ya29.a0AfB_abc-DEF.123_refresh_token_example';
    expect(decryptToken(encryptToken(plain))).toBe(plain);
  });

  it('round-trips unicode correctly', async () => {
    const { encryptToken, decryptToken } = await loadCrypto();
    const plain = 'Tiếng Việt — 日本語 — 🔐';
    expect(decryptToken(encryptToken(plain))).toBe(plain);
  });

  it('produces different ciphertext for the same plaintext (fresh IV)', async () => {
    const { encryptToken } = await loadCrypto();
    const a = encryptToken('same-token-value');
    const b = encryptToken('same-token-value');
    expect(a).not.toBe(b);
  });

  it('throws on empty plaintext', async () => {
    const { encryptToken } = await loadCrypto();
    expect(() => encryptToken('')).toThrow();
  });

  it('throws generic error on tampered ciphertext', async () => {
    const { encryptToken, decryptToken } = await loadCrypto();
    const ct = encryptToken('token-xyz');
    // flip last byte of ciphertext (stays valid base64 length, GCM tag fails)
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decryptToken(tampered)).toThrow(/Decryption failed/);
  });

  it('throws generic error on tampered authTag', async () => {
    const { encryptToken, decryptToken } = await loadCrypto();
    const ct = encryptToken('token-xyz');
    const buf = Buffer.from(ct, 'base64');
    buf[12] ^= 0x01; // first byte of tag
    expect(() => decryptToken(buf.toString('base64'))).toThrow(
      /Decryption failed/,
    );
  });

  it('throws on empty / malformed input', async () => {
    const { decryptToken } = await loadCrypto();
    expect(() => decryptToken('')).toThrow(/Invalid ciphertext format/);
    // too short to contain iv+tag+1 byte of ciphertext
    expect(() => decryptToken(Buffer.alloc(20).toString('base64'))).toThrow(
      /Invalid ciphertext format/,
    );
  });

  it('throws when decrypted with wrong key (simulated rotation bug)', async () => {
    const { encryptToken } = await loadCrypto();
    const ct = encryptToken('secret-token');
    const original = process.env.GMAIL_ENCRYPTION_KEY;
    process.env.GMAIL_ENCRYPTION_KEY = ALT_KEY;
    try {
      // fresh import won't help since module caches nothing; getKey reads env each call
      const { decryptToken } = await import('./crypto');
      expect(() => decryptToken(ct)).toThrow(/Decryption failed/);
    } finally {
      process.env.GMAIL_ENCRYPTION_KEY = original;
    }
  });

  it('throws when env key is missing', async () => {
    const original = process.env.GMAIL_ENCRYPTION_KEY;
    delete process.env.GMAIL_ENCRYPTION_KEY;
    try {
      const { encryptToken } = await import('./crypto');
      expect(() => encryptToken('x')).toThrow(/GMAIL_ENCRYPTION_KEY/);
    } finally {
      process.env.GMAIL_ENCRYPTION_KEY = original;
    }
  });

  it('throws when env key has wrong length', async () => {
    const original = process.env.GMAIL_ENCRYPTION_KEY;
    process.env.GMAIL_ENCRYPTION_KEY = 'deadbeef'; // 4 bytes, not 32
    try {
      const { encryptToken } = await import('./crypto');
      expect(() => encryptToken('x')).toThrow(/32 bytes/);
    } finally {
      process.env.GMAIL_ENCRYPTION_KEY = original;
    }
  });
});
