/**
 * lib/asc-accounts.ts
 *
 * Server-side only. Parses ASC_ACCOUNTS env var and provides helpers to
 * look up credentials by account ID.
 *
 * ASC_ACCOUNTS format (JSON array):
 * [
 *   { "id": "acme-vn", "name": "Acme Vietnam", "keyId": "...", "issuerId": "...", "privateKey": "..." },
 *   ...
 * ]
 *
 * Backward compat: if ASC_ACCOUNTS is not set, falls back to
 * ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY (single-account legacy).
 */

export interface AscAccount {
  id: string;
  name: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
}

/** Alias used by asc-jwt and asc-client */
export type AscCredentials = AscAccount;

/** Safe subset exposed to the client — no private key or issuer ID */
export interface AscAccountPublic {
  id: string;
  name: string;
  keyId: string;
}

// ── Parse once at module load ────────────────────────────────────────────────

let _accounts: AscAccount[] | null = null;

function parseAccounts(): AscAccount[] {
  if (_accounts !== null) return _accounts;

  const raw = process.env.ASC_ACCOUNTS;

  if (!raw) {
    // Backward compat: single-account env vars
    const keyId = process.env.ASC_KEY_ID;
    const issuerId = process.env.ASC_ISSUER_ID;
    const privateKey = process.env.ASC_PRIVATE_KEY;

    if (!keyId || !issuerId || !privateKey) {
      throw new Error(
        "Missing ASC credentials. Set ASC_ACCOUNTS (multi-account) or " +
          "ASC_KEY_ID + ASC_ISSUER_ID + ASC_PRIVATE_KEY (single-account)."
      );
    }

    _accounts = [
      {
        id: "default",
        name: "Default",
        keyId,
        issuerId,
        privateKey,
      },
    ];
    return _accounts;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "ASC_ACCOUNTS is not valid JSON. Expected a JSON array of account objects."
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ASC_ACCOUNTS must be a non-empty JSON array.");
  }

  _accounts = parsed.map((item: unknown, i: number) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`ASC_ACCOUNTS[${i}] must be an object.`);
    }
    const obj = item as Record<string, unknown>;
    for (const field of ["id", "name", "keyId", "issuerId", "privateKey"]) {
      if (typeof obj[field] !== "string" || !(obj[field] as string).trim()) {
        throw new Error(
          `ASC_ACCOUNTS[${i}] is missing required field "${field}".`
        );
      }
    }
    return {
      id: (obj.id as string).trim(),
      name: (obj.name as string).trim(),
      keyId: (obj.keyId as string).trim(),
      issuerId: (obj.issuerId as string).trim(),
      privateKey: obj.privateKey as string,
    };
  });

  // Validate unique IDs
  const ids = _accounts.map((a) => a.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(
      `ASC_ACCOUNTS contains duplicate account IDs: ${dupes.join(", ")}`
    );
  }

  return _accounts;
}

// ── Public helpers ───────────────────────────────────────────────────────────

/** All accounts (server-side, includes private key) */
export function getAscAccounts(): AscAccount[] {
  return parseAccounts();
}

/** Lookup by id — returns null if not found */
export function getAscAccountById(id: string): AscAccount | null {
  return parseAccounts().find((a) => a.id === id) ?? null;
}

/** Default account (first in list) */
export function getDefaultAscAccount(): AscAccount {
  const accounts = parseAccounts();
  return accounts[0];
}

/** Safe list for client — excludes privateKey + issuerId */
export function getAscAccountsPublic(): AscAccountPublic[] {
  return parseAccounts().map(({ id, name, keyId }) => ({ id, name, keyId }));
}
