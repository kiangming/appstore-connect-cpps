/**
 * ⛔ THE SECRET FENCE. Caller identity in logs means EMAIL ONLY.
 *
 * This arc widened what the Google IAP module keeps about a failure: the
 * complete error body (redacted) now reaches `actions_log`, and the
 * Publisher log line now names the account and the service account email.
 * Both are deliberate. Both sit one careless field away from being a
 * credential leak, because the thing that makes them useful — "say who was
 * making this call" — is adjacent to the thing that must never happen.
 *
 * ⚠ WHY STRUCTURAL AND NOT BEHAVIOURAL. A behavioural test can only catch a
 * leak it already thought to construct an input for. The failure mode here
 * is a FUTURE edit — someone adds `credentials` or `privateKey` to the log
 * entry, or drops the redaction call to "see the real error in staging" —
 * and no existing test has a fixture that would notice. These assertions
 * fail on the SHAPE OF THE SOURCE, so the leak cannot be written in the
 * first place.
 *
 * ⚠ The pre-existing cap was not superstition. logging.ts recorded that
 * Google "occasionally echo[es] private-key tails on scope errors". The
 * 200-char slice was the old mitigation; `redactSecrets` is the new one,
 * and it is strictly stronger only as long as it is actually called.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

const LOGGING = ["lib", "google-iap-management", "google", "logging.ts"];
const DESCRIPTOR = [
  "lib",
  "google-iap-management",
  "google",
  "google-error-descriptor.ts",
];
const PUBLISHER = [
  "lib",
  "google-iap-management",
  "google",
  "publisher-client.ts",
];
const AUTH = ["lib", "google-iap-management", "google", "auth.ts"];

/** Every spelling of key material that must never appear as a log field or
 *  an error field. Names, not values — a value-based test would need the
 *  secret in the repo to look for it. */
const FORBIDDEN_FIELD_NAMES = [
  "privateKey",
  "private_key",
  "encryptedCredentials",
  "encrypted_credentials",
  "credentialsBlob",
  "serviceAccountJson",
];

describe("⛔ the log entry type cannot carry key material", () => {
  const src = read(...LOGGING);

  it("⭐ PublisherLogEntry declares no credential-ish field", () => {
    const iface = src.slice(
      src.indexOf("export interface PublisherLogEntry"),
      src.indexOf("export function logPublisherCall"),
    );
    expect(iface).toContain("serviceAccountEmail");
    for (const name of FORBIDDEN_FIELD_NAMES) {
      expect(iface).not.toContain(name);
    }
  });

  it("⭐ the whole logging module never mentions key material", () => {
    for (const name of FORBIDDEN_FIELD_NAMES) {
      // `logging.ts` has no business importing, naming or formatting any of
      // these. If a future edit needs one, that edit is the bug.
      expect(src).not.toContain(name);
    }
  });

  it("logs the service account EMAIL field, not a whole account object", () => {
    // `sa=${entry.serviceAccountEmail}` is safe; `sa=${JSON.stringify(acct)}`
    // would serialize whatever the account row happens to hold next year.
    expect(src).toMatch(/sa=\$\{entry\.serviceAccountEmail\}/);
    expect(src).not.toMatch(/JSON\.stringify/);
  });
});

describe("⛔ the identity tag carries email only", () => {
  const src = read(...AUTH);

  it("⭐ JwtAccountTag has exactly accountId + serviceAccountEmail", () => {
    const iface = src.slice(
      src.indexOf("export interface JwtAccountTag"),
      src.indexOf("const jwtTags"),
    );
    for (const name of FORBIDDEN_FIELD_NAMES) {
      expect(iface).not.toContain(name);
    }
    expect(iface).toContain("accountId");
    expect(iface).toContain("serviceAccountEmail");
  });

  it("⭐ the tag is built from client.email, never from the decrypted JSON", () => {
    const fn = src.slice(src.indexOf("export function jwtClientFromEncrypted"));
    expect(fn).toMatch(/serviceAccountEmail:\s*\n?\s*typeof client\.email/);
    // `plain` is the DECRYPTED service account JSON. It may be parsed, but
    // it must not be what the tag (and therefore the log line) reads from.
    expect(fn).not.toMatch(/serviceAccountEmail:[^\n]*plain/);
  });
});

describe("⛔ redaction is actually wired in, not merely available", () => {
  const src = read(...DESCRIPTOR);

  it("⭐ `message` is redacted before it is capped", () => {
    expect(src).toMatch(/const message = redactSecrets\(rawMessage\)/);
  });

  it("⭐ `full` — the uncapped field — is redacted", () => {
    expect(src).toMatch(/const full = redactSecrets\(/);
  });

  it("⭐ `details[]` is redacted on the way in", () => {
    expect(src).toMatch(/redactSecrets\(JSON\.stringify\(e\.details\)\)/);
  });

  it("⭐ the PEM patterns cover both a paired block and a truncated tail", () => {
    const paired = /BEGIN \[A-Z \]\*PRIVATE KEY-----\[\\s\\S\]\*\?-----END/;
    const tail = /BEGIN \[A-Z \]\*PRIVATE KEY-----\[\\s\\S\]\*\//;
    expect(paired.test(src)).toBe(true);
    expect(tail.test(src)).toBe(true);
  });
});

describe("⛔ the publisher never logs a body, a header or a token", () => {
  const src = read(...PUBLISHER);

  it("⭐ no credential-ish identifier appears anywhere in the client", () => {
    for (const name of FORBIDDEN_FIELD_NAMES) {
      expect(src).not.toContain(name);
    }
  });

  it("⭐ the log line's error text still goes through the descriptor", () => {
    // Reaching for `err.message` directly inside `timed` is the edit that
    // would quietly bypass redaction.
    const timedFn = src.slice(
      src.indexOf("async function timed<T>"),
      src.indexOf("function throwBothFailed"),
    );
    expect(timedFn).toMatch(/describeGoogleError\(err\)/);
    expect(timedFn).not.toMatch(/e\?\.message/);
  });

  it("⭐ the both-paths-failed line logs capped messages, never `full`", () => {
    const fn = src.slice(
      src.indexOf("function throwBothFailed"),
      src.indexOf("READ path — Hotfix 8"),
    );
    expect(fn).toMatch(/primary\.message\.slice\(0, 200\)/);
    expect(fn).toMatch(/fallback\.message\.slice\(0, 200\)/);
    expect(fn).not.toContain(".full");
  });
});
