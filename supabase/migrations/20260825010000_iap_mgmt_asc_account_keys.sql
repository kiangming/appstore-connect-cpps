-- K1 — Apple ASC key pool for IAP Management.
--
-- One ASC account (a team) may hold many API keys. Apple counts its hourly
-- request budget PER KEY, so N keys on one team give N × the headroom
-- (Q-RATELIMIT.per-key-confirmed; still to be re-measured on this system by
-- census D1 once a second key exists — see TODO [RATELIMIT-keypool-design]).
--
-- ⚠ WHY A NEW TABLE AND NOT MORE ROWS IN `public.asc_accounts`.
-- That table is one-key-per-row, and `session.activeAccountId` — the field
-- the AccountSwitcher renders — is shared by CPP Manager and Apple IAP
-- Management. Adding 10 key-rows per account would put 50 entries in an
-- account picker that both modules see. Keys are a different concept from
-- accounts and need their own surface.
--
-- ⚠ SOFT REF, NOT A FOREIGN KEY. `public.asc_accounts` lives in another
-- schema and CLAUDE.md invariant #9 forbids cross-schema queries.
-- `iap_mgmt.apps` already set this precedent: it duplicates `apple_app_id`
-- rather than referencing CPP's app table. Cost, stated plainly: deleting an
-- account in CPP does NOT cascade here. An orphaned key is inert (no flow
-- resolves an account that no longer exists), but it is not cleaned up either.

CREATE TABLE IF NOT EXISTS iap_mgmt.asc_account_keys (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Matches `public.asc_accounts.id` by value. See the soft-ref note above.
  account_id       TEXT        NOT NULL,

  -- ASC Key ID. Not a secret — it travels in the JWT header as `kid` and is
  -- already printed in Railway logs (`key=` on the budget line).
  key_id           TEXT        NOT NULL,

  -- AES-256-GCM, base64(iv‖authTag‖ciphertext) — the EXACT format
  -- `lib/asc-crypto.ts` reads and writes, and the exact one
  -- `public.asc_accounts.private_key_enc` already uses. Same ENCRYPTION_KEY.
  -- Reusing the format is what lets one `decryptPrivateKey` serve both.
  private_key_enc  TEXT        NOT NULL,

  -- Soft disable. The pool skips these; revoking on Apple's side is separate
  -- and should happen first.
  enabled          BOOLEAN     NOT NULL DEFAULT true,

  -- K3 will write this when a 429 outlives the retry curve on this key.
  -- ⚠ A TIMESTAMP, NOT A BOOLEAN, on purpose: a flag cannot answer "until
  -- when", and the pool has to know when the key becomes eligible again.
  -- Nullable = never cooled down. Unused until K3; the column exists now so
  -- K3 needs no second migration.
  cooldown_until   TIMESTAMPTZ,

  note             TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The same key registered twice for one account would silently halve that
  -- key's effective budget while looking like added headroom.
  UNIQUE (account_id, key_id)
);

-- The pool's only hot query: enabled keys for one account.
CREATE INDEX IF NOT EXISTS idx_iap_mgmt_asc_account_keys_account
  ON iap_mgmt.asc_account_keys (account_id) WHERE enabled;

CREATE TRIGGER tg_iap_mgmt_asc_account_keys_updated_at
  BEFORE UPDATE ON iap_mgmt.asc_account_keys
  FOR EACH ROW EXECUTE FUNCTION iap_mgmt.set_updated_at();

-- ⚠ DELIBERATE DIVERGENCE FROM THIS SCHEMA'S DEFAULT GRANTS.
-- Migration 20260515020000 set `ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated` so that
-- future tables would not repeat the IAP.c missing-grant blunder. That
-- default is right for product tables and wrong for this one: it would hand
-- every authenticated Supabase role read access to encrypted ASC private
-- keys. `public.asc_accounts` guards the same data by enabling RLS with no
-- policies (service_role only); this schema does not use RLS at all
-- (Q-IAP.8 lock — auth at the Next.js layer), so the equivalent here is an
-- explicit REVOKE.
--
-- Costs nothing: `iapDb()` (lib/iap-management/db.ts) is service_role only
-- and throws in the browser, so no code path reaches this table as
-- `authenticated`.
REVOKE ALL ON iap_mgmt.asc_account_keys FROM authenticated, anon;
GRANT ALL PRIVILEGES ON iap_mgmt.asc_account_keys TO service_role;

COMMENT ON TABLE iap_mgmt.asc_account_keys IS
  'Apple ASC API keys for the IAP Management key pool. One account (team) → '
  'many keys; Apple counts its hourly limit per key. service_role only — '
  'holds encrypted private keys, unlike other iap_mgmt tables.';
