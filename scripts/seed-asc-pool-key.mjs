#!/usr/bin/env node
/**
 * K1 — register an Apple ASC API key into the IAP Management key pool.
 *
 * ⚠ WHY A SCRIPT AND NOT A SQL SNIPPET. `private_key_enc` is AES-256-GCM
 * ciphertext produced by `lib/asc-crypto.ts` using `ENCRYPTION_KEY`. The SQL
 * Editor cannot produce that value, and pasting a raw .p8 into the column
 * would store an Apple private key in plaintext. This script encrypts with
 * the exact same routine the app decrypts with, so a key it writes is a key
 * the app can read — and a mismatched ENCRYPTION_KEY fails here, loudly, at
 * seed time rather than at 2am on a bulk import.
 *
 * ⚠ v1 has no admin UI for this — a Manager decision (pool keys must NOT go
 * into `asc_accounts`, whose picker is shared with CPP Manager). This script
 * is the whole management surface until key count makes that annoying.
 *
 * Usage — run from the repo root, with .env.local present:
 *
 *   node scripts/seed-asc-pool-key.mjs \
 *     --account vnggames-co-ltd \
 *     --key-id  2X9R4HXF34 \
 *     --p8      ~/Downloads/AuthKey_2X9R4HXF34.p8 \
 *     --note    "pool key 2"
 *
 *   node scripts/seed-asc-pool-key.mjs --account vnggames-co-ltd --list
 *
 * The .p8 file is read, encrypted and discarded — it is never written to the
 * repo and never logged.
 */
import { readFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const accountId = arg("account");
if (!accountId) {
  console.error("Missing --account <id>  (must match public.asc_accounts.id)");
  process.exit(1);
}

// ── env ───────────────────────────────────────────────────────────────────
const env = readFileSync(".env.local", "utf8");
const envGet = (k) => {
  const line = env.split("\n").find((l) => l.startsWith(`${k}=`));
  return line ? line.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
};
const SUPABASE_URL = envGet("NEXT_PUBLIC_SUPABASE_URL") ?? envGet("SUPABASE_URL");
const SERVICE_KEY = envGet("SUPABASE_SERVICE_ROLE_KEY");
const ENCRYPTION_KEY = envGet("ENCRYPTION_KEY");

for (const [name, v] of [
  ["NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY],
  ["ENCRYPTION_KEY", ENCRYPTION_KEY],
]) {
  if (!v) { console.error(`Missing ${name} in .env.local`); process.exit(1); }
}
if (ENCRYPTION_KEY.length !== 64) {
  console.error("ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
  process.exit(1);
}

const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  "Content-Profile": "iap_mgmt",
  "Accept-Profile": "iap_mgmt",
};
const TABLE = `${SUPABASE_URL}/rest/v1/asc_account_keys`;

// ── list mode ─────────────────────────────────────────────────────────────
if (has("list")) {
  const r = await fetch(
    `${TABLE}?select=key_id,enabled,cooldown_until,note,created_at&account_id=eq.${accountId}&order=created_at`,
    { headers: H },
  );
  const rows = await r.json();
  if (!Array.isArray(rows)) { console.error(rows); process.exit(1); }
  console.log(`Pool keys for account "${accountId}": ${rows.length}`);
  for (const x of rows) {
    console.log(
      `  ${x.key_id.padEnd(12)} enabled=${String(x.enabled).padEnd(5)} ` +
        `cooldown=${x.cooldown_until ?? "-"}  ${x.note ?? ""}`,
    );
  }
  process.exit(0);
}

// ── encrypt — byte-for-byte the format lib/asc-crypto.ts reads ────────────
const keyId = arg("key-id");
const p8Path = arg("p8");
if (!keyId || !p8Path) {
  console.error("Missing --key-id and/or --p8 (use --list to inspect).");
  process.exit(1);
}

const plaintext = readFileSync(p8Path.replace(/^~/, process.env.HOME), "utf8");
if (!plaintext.includes("BEGIN PRIVATE KEY")) {
  console.error(`${p8Path} does not look like a PKCS#8 .p8 key.`);
  process.exit(1);
}

const iv = randomBytes(16);
const cipher = createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "hex"), iv, {
  authTagLength: 16,
});
const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");

const res = await fetch(TABLE, {
  method: "POST",
  headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify({
    account_id: accountId,
    key_id: keyId,
    private_key_enc: packed,
    note: arg("note") ?? null,
    created_by: arg("by") ?? "seed-script",
  }),
});

if (!res.ok) {
  const body = await res.text();
  // The UNIQUE (account_id, key_id) constraint is the useful failure here:
  // registering one key twice would halve its effective budget while looking
  // like added headroom.
  console.error(`Insert failed (${res.status}): ${body}`);
  process.exit(1);
}
console.log(`✓ Registered key ${keyId} for account ${accountId}.`);
console.log(`  Verify with: node scripts/seed-asc-pool-key.mjs --account ${accountId} --list`);
