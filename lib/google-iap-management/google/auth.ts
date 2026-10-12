/**
 * Google Service Account → JWT auth client construction.
 *
 * Uses google-auth-library's JWT class (already bundled with `googleapis`),
 * which handles OAuth2 access-token minting + automatic caching until expiry.
 * We don't re-mint tokens ourselves — the JWT instance is cached by account
 * id so repeated calls within the same Node process reuse the access token.
 *
 * Q-GIAP.B: dual-scope verification. Both scopes are requested up front so
 * a single JWT client can drive both the Publisher API (per-app IAP CRUD)
 * and the Reporting API (apps:search).
 *
 * Service Account JSON shape (parsed at runtime):
 *   {
 *     "type": "service_account",
 *     "project_id": "...",
 *     "private_key": "-----BEGIN PRIVATE KEY-----\n...",
 *     "client_email": "...@...iam.gserviceaccount.com",
 *     ...
 *   }
 */
import { JWT } from "google-auth-library";

import { decryptCredentials } from "../crypto";

export const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
export const PLAY_DEVELOPER_REPORTING_SCOPE =
  "https://www.googleapis.com/auth/playdeveloperreporting";

export const GOOGLE_IAP_SCOPES = [
  ANDROID_PUBLISHER_SCOPE,
  PLAY_DEVELOPER_REPORTING_SCOPE,
] as const;

export interface ServiceAccountJson {
  type: string;
  project_id?: string;
  private_key: string;
  client_email: string;
  // Other fields tolerated but unused at runtime.
  [key: string]: unknown;
}

/**
 * Parse a Service Account JSON string. Throws a sanitized error if the
 * structure is wrong — we don't leak the private key fragment if validation
 * fails partway.
 */
export function parseServiceAccountJson(raw: string): ServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Service account JSON is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Service account JSON must be an object.");
  }
  const o = parsed as Record<string, unknown>;
  if (o.type !== "service_account") {
    throw new Error(
      'Service account JSON must have type="service_account" (uploaded the wrong key file?).',
    );
  }
  if (typeof o.client_email !== "string" || !o.client_email.includes("@")) {
    throw new Error("Service account JSON is missing client_email.");
  }
  if (
    typeof o.private_key !== "string" ||
    !o.private_key.includes("BEGIN PRIVATE KEY")
  ) {
    throw new Error("Service account JSON is missing a valid private_key.");
  }
  return o as ServiceAccountJson;
}

/**
 * Build a JWT client from a raw Service Account JSON string. Caller is
 * responsible for caching the result if they call this hot.
 */
export function jwtClientFromServiceAccount(
  serviceAccountJson: string,
  scopes: readonly string[] = GOOGLE_IAP_SCOPES,
): JWT {
  const sa = parseServiceAccountJson(serviceAccountJson);
  return new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [...scopes],
  });
}

/**
 * Decrypt the stored credentials blob and build a JWT client. Cached by
 * encrypted-blob identity (the AES IV makes each row's ciphertext unique,
 * so the cache key naturally rotates when Manager re-uploads).
 */
const jwtCache = new Map<string, JWT>();

/**
 * Which account a given encrypted blob belongs to.
 *
 * ⚠ THIS IS THE CHOKE POINT, AND THAT IS THE WHOLE POINT. There are 26
 * `jwtClientFromEncrypted` call sites across the module; threading an
 * `accountId` argument through all of them would be 26 chances to forget
 * one, and the one forgotten is the one whose failure you need to debug
 * (CLAUDE.md meta-rule P1 — prefer a SHARED choke point over N patches).
 * Instead `getEncryptedCredentials` — which is the only way a route gets a
 * blob, and which already knows the id — records it here, keyed by the
 * SAME blob identity the JWT cache uses. Every caller then gets caller
 * identity in its logs without changing a line.
 */
const blobAccountIds = new Map<string, string>();

/** Caller identity for one JWT. ⛔ Email only — see `JwtAccountTag`. */
export interface JwtAccountTag {
  accountId?: string;
  /** Service account `client_email`. ⛔ NEVER the private key, never the
   *  encrypted blob. This type exists partly to make that structural. */
  serviceAccountEmail?: string;
}

/** Keyed by JWT instance so the tag dies with the client it describes. */
const jwtTags = new WeakMap<JWT, JwtAccountTag>();

/**
 * Record the account a credential blob came from. Called by
 * `getEncryptedCredentials`; safe to call repeatedly.
 */
export function rememberAccountForCredentials(
  encryptedCredentials: string,
  accountId: string,
): void {
  blobAccountIds.set(encryptedCredentials, accountId);
}

/**
 * Caller identity for a JWT, for log lines. Returns an empty object for a
 * JWT this module did not build (test doubles), so callers never branch.
 */
export function accountTagForJwt(jwt: JWT): JwtAccountTag {
  return jwtTags.get(jwt) ?? {};
}

export function jwtClientFromEncrypted(encryptedCredentials: string): JWT {
  const cached = jwtCache.get(encryptedCredentials);
  if (cached) return cached;
  const plain = decryptCredentials(encryptedCredentials);
  const client = jwtClientFromServiceAccount(plain);
  jwtCache.set(encryptedCredentials, client);
  jwtTags.set(client, {
    accountId: blobAccountIds.get(encryptedCredentials),
    // `parseServiceAccountJson` already validated this is a real email;
    // reading it off the built client avoids re-parsing the plaintext.
    serviceAccountEmail:
      typeof client.email === "string" ? client.email : undefined,
  });
  return client;
}

/** Test seam: clear JWT cache between tests. */
export function __clearJwtCacheForTesting(): void {
  jwtCache.clear();
  blobAccountIds.clear();
}
