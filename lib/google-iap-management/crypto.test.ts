import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "crypto";

const TEST_KEY = randomBytes(32).toString("hex");
const ALT_KEY = randomBytes(32).toString("hex");

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
  process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey === undefined)
    delete process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
  else process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = originalKey;
});

async function loadCrypto() {
  const mod = await import("./crypto");
  return mod;
}

describe("encryptCredentials / decryptCredentials", () => {
  it("round-trips a realistic service-account JSON blob", async () => {
    const { encryptCredentials, decryptCredentials } = await loadCrypto();
    const plain = JSON.stringify({
      type: "service_account",
      project_id: "example-12345",
      private_key_id: "abc123",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
      client_email: "publisher@example-12345.iam.gserviceaccount.com",
    });
    expect(decryptCredentials(encryptCredentials(plain))).toBe(plain);
  });

  it("round-trips unicode correctly", async () => {
    const { encryptCredentials, decryptCredentials } = await loadCrypto();
    const plain = "Tiếng Việt — 日本語 — 🔐";
    expect(decryptCredentials(encryptCredentials(plain))).toBe(plain);
  });

  it("produces different ciphertext for the same plaintext (fresh IV)", async () => {
    const { encryptCredentials } = await loadCrypto();
    const a = encryptCredentials("same-credential-value");
    const b = encryptCredentials("same-credential-value");
    expect(a).not.toBe(b);
  });

  it("throws on empty plaintext", async () => {
    const { encryptCredentials } = await loadCrypto();
    expect(() => encryptCredentials("")).toThrow();
  });

  it("throws generic error on tampered ciphertext", async () => {
    const { encryptCredentials, decryptCredentials } = await loadCrypto();
    const ct = encryptCredentials("creds-xyz");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0x01;
    const tampered = buf.toString("base64");
    expect(() => decryptCredentials(tampered)).toThrow(/Decryption failed/);
  });

  it("throws generic error on tampered authTag", async () => {
    const { encryptCredentials, decryptCredentials } = await loadCrypto();
    const ct = encryptCredentials("creds-xyz");
    const buf = Buffer.from(ct, "base64");
    buf[12] ^= 0x01;
    expect(() => decryptCredentials(buf.toString("base64"))).toThrow(
      /Decryption failed/,
    );
  });

  it("throws on empty / malformed input", async () => {
    const { decryptCredentials } = await loadCrypto();
    expect(() => decryptCredentials("")).toThrow(/Invalid ciphertext format/);
    expect(() => decryptCredentials(Buffer.alloc(20).toString("base64"))).toThrow(
      /Invalid ciphertext format/,
    );
  });

  it("throws when decrypted with wrong key (rotation bug simulation)", async () => {
    const { encryptCredentials } = await loadCrypto();
    const ct = encryptCredentials("secret-creds");
    const original = process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
    process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = ALT_KEY;
    try {
      const { decryptCredentials } = await import("./crypto");
      expect(() => decryptCredentials(ct)).toThrow(/Decryption failed/);
    } finally {
      process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = original;
    }
  });

  it("throws when env key is missing", async () => {
    const original = process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
    try {
      const { encryptCredentials } = await import("./crypto");
      expect(() => encryptCredentials("x")).toThrow(
        /GOOGLE_CREDENTIALS_ENCRYPTION_KEY/,
      );
    } finally {
      process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = original;
    }
  });

  it("throws when env key has wrong length", async () => {
    const original = process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY;
    process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = "deadbeef";
    try {
      const { encryptCredentials } = await import("./crypto");
      expect(() => encryptCredentials("x")).toThrow(/32 bytes/);
    } finally {
      process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY = original;
    }
  });
});
