import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "crypto";

const TEST_KEY = randomBytes(32).toString("hex");
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

const FAKE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDfake\n-----END PRIVATE KEY-----\n";

function makeServiceAccount(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "fake-project",
    private_key_id: "fakekid",
    private_key: FAKE_KEY_PEM,
    client_email: "publisher@fake-project.iam.gserviceaccount.com",
    client_id: "123456789",
    ...overrides,
  });
}

describe("parseServiceAccountJson", () => {
  it("parses a well-formed Service Account JSON", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    const sa = parseServiceAccountJson(makeServiceAccount());
    expect(sa.type).toBe("service_account");
    expect(sa.client_email).toContain("@");
    expect(sa.private_key).toContain("BEGIN PRIVATE KEY");
  });

  it("rejects non-JSON input", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    expect(() => parseServiceAccountJson("not json")).toThrow(/not valid JSON/);
  });

  it("rejects an array or primitive at the top level", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    expect(() => parseServiceAccountJson("[]")).not.toThrow(/not valid JSON/);
    expect(() => parseServiceAccountJson("[]")).toThrow();
    expect(() => parseServiceAccountJson("null")).toThrow();
  });

  it("rejects wrong type field (uploaded the wrong key file)", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    expect(() =>
      parseServiceAccountJson(makeServiceAccount({ type: "user" })),
    ).toThrow(/service_account/);
  });

  it("rejects missing client_email", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    const raw = JSON.stringify({
      type: "service_account",
      private_key: FAKE_KEY_PEM,
    });
    expect(() => parseServiceAccountJson(raw)).toThrow(/client_email/);
  });

  it("rejects malformed client_email", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    expect(() =>
      parseServiceAccountJson(makeServiceAccount({ client_email: "not-an-email" })),
    ).toThrow(/client_email/);
  });

  it("rejects missing private_key", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    const raw = JSON.stringify({
      type: "service_account",
      client_email: "x@y.iam.gserviceaccount.com",
    });
    expect(() => parseServiceAccountJson(raw)).toThrow(/private_key/);
  });

  it("rejects private_key without PEM header", async () => {
    const { parseServiceAccountJson } = await import("./auth");
    expect(() =>
      parseServiceAccountJson(makeServiceAccount({ private_key: "not pem" })),
    ).toThrow(/private_key/);
  });
});

describe("jwtClientFromServiceAccount", () => {
  it("constructs a JWT with both Google IAP scopes by default", async () => {
    const {
      jwtClientFromServiceAccount,
      ANDROID_PUBLISHER_SCOPE,
      PLAY_DEVELOPER_REPORTING_SCOPE,
    } = await import("./auth");
    const jwt = jwtClientFromServiceAccount(makeServiceAccount());
    // google-auth-library normalizes scopes onto the instance
    const scopes = (jwt as unknown as { scopes: string[] }).scopes;
    expect(scopes).toContain(ANDROID_PUBLISHER_SCOPE);
    expect(scopes).toContain(PLAY_DEVELOPER_REPORTING_SCOPE);
  });

  it("threads the service-account email + key onto the JWT", async () => {
    const { jwtClientFromServiceAccount } = await import("./auth");
    const jwt = jwtClientFromServiceAccount(makeServiceAccount());
    expect(jwt.email).toBe("publisher@fake-project.iam.gserviceaccount.com");
    expect(jwt.key).toContain("BEGIN PRIVATE KEY");
  });
});

describe("jwtClientFromEncrypted (caching)", () => {
  beforeEach(async () => {
    const { __clearJwtCacheForTesting } = await import("./auth");
    __clearJwtCacheForTesting();
  });

  it("caches by encrypted-blob identity (same blob → same JWT instance)", async () => {
    const { encryptCredentials } = await import("../crypto");
    const { jwtClientFromEncrypted } = await import("./auth");
    const blob = encryptCredentials(makeServiceAccount());
    const a = jwtClientFromEncrypted(blob);
    const b = jwtClientFromEncrypted(blob);
    expect(a).toBe(b);
  });

  it("rotates when the Manager re-uploads (different IV → different blob)", async () => {
    const { encryptCredentials } = await import("../crypto");
    const { jwtClientFromEncrypted } = await import("./auth");
    const raw = makeServiceAccount();
    const blob1 = encryptCredentials(raw);
    const blob2 = encryptCredentials(raw);
    expect(blob1).not.toBe(blob2);
    const a = jwtClientFromEncrypted(blob1);
    const b = jwtClientFromEncrypted(blob2);
    expect(a).not.toBe(b);
  });
});
