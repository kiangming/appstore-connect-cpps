/**
 * lib/iap-management/hub-tracking/config.ts — Server-side only.
 *
 * Reads/writes the singleton VNGGames Hub tracking config row
 * (iap_mgmt.hub_tracking_config): workflow_id + encrypted ingest token +
 * the Settings `enabled` toggle. Encrypted-at-rest secret via the SAME
 * AES-256-GCM helpers ASC accounts use (no new crypto).
 *
 * NO in-memory cache — deliberately, unlike lib/asc-account-repository.ts.
 * An earlier version cached reads for 5 minutes; that cache was the root
 * cause of two bugs (Manager report, 2026-07-xx UAT):
 *   1. Saving with the token field blank ("keep existing") intermittently
 *      failed with "Token is required" — `saveHubTrackingConfig`'s
 *      existing-row check read a STALE cached `null` from before the row
 *      was ever created/visible to this read, even though the row existed
 *      in the DB.
 *   2. The `enabled` Settings toggle appeared to "silently revert" across
 *      sessions — a GET could read a stale cached row from before a save
 *      landed (a Railway rolling deploy briefly runs two processes, each
 *      with its own independent in-memory cache; a save on one process
 *      never invalidates the other's cache within the 5-minute TTL).
 * This table is read a handful of times per bulk-import batch (once on
 * the wizard's step 1→2 transition, once on execute-route finalize/cancel)
 * — nowhere near a hot path — so the cache bought negligible performance
 * benefit against a real correctness risk. Every read now hits the DB.
 */

import { iapDb } from "@/lib/iap-management/db";
import { encryptPrivateKey, decryptPrivateKey } from "@/lib/asc-crypto";
import { log } from "@/lib/logger";

const CONFIG_ID = "default";
const LOG_FEATURE = "iap-hub-tracking";

interface HubTrackingConfigRow {
  id: string;
  workflow_id: string;
  token_enc: string;
  enabled: boolean;
  updated_at: string;
}

async function fetchRow(): Promise<HubTrackingConfigRow | null> {
  const { data, error } = await iapDb()
    .from("hub_tracking_config")
    .select("id, workflow_id, token_enc, enabled, updated_at")
    .eq("id", CONFIG_ID)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    // Never log token_enc — this destructures only the fields we log below.
    await log(LOG_FEATURE, `[hub-tracking] config: read error (no token logged): ${error.message}`, "ERROR");
    throw new Error(`Failed to load Hub tracking config: ${error.message}`);
  }
  const row = (data as HubTrackingConfigRow | null) ?? null;
  await log(LOG_FEATURE, `[hub-tracking] config: found=${Boolean(row)} enabled=${Boolean(row?.enabled)}`);
  return row;
}

export interface HubTrackingCredentials {
  workflowId: string;
  token: string;
}

export interface HubTrackingGate {
  /** A row exists in the config table (a workflow_id/token has been saved). */
  configured: boolean;
  /** The Settings toggle's persisted value. */
  enabled: boolean;
  /** Non-null only when configured AND enabled AND the token decrypted OK —
   *  the single no-op gate every Hub call goes through. */
  credentials: HubTrackingCredentials | null;
}

/**
 * Resolves configured/enabled/credentials in one DB read — used by the
 * start/finalize GATE logging so both booleans are available even when
 * `credentials` collapses them into a single null.
 */
export async function getHubTrackingGate(): Promise<HubTrackingGate> {
  const row = await fetchRow();
  if (!row) return { configured: false, enabled: false, credentials: null };

  if (!row.enabled) {
    return { configured: true, enabled: false, credentials: null };
  }

  try {
    const token = decryptPrivateKey(row.token_enc);
    return {
      configured: true,
      enabled: true,
      credentials: { workflowId: row.workflow_id, token },
    };
  } catch (err) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] config: decrypt error (no token logged): ${err instanceof Error ? err.message : err}`,
      "ERROR",
    );
    return { configured: true, enabled: true, credentials: null };
  }
}

/**
 * The single no-op gate: null means "no Hub call should be attempted"
 * (unconfigured, disabled, or the token failed to decrypt). Callers never
 * need a separate enabled check.
 */
export async function getActiveHubTrackingCredentials(): Promise<HubTrackingCredentials | null> {
  return (await getHubTrackingGate()).credentials;
}

export interface HubTrackingConfigPublic {
  workflow_id: string;
  configured: boolean;
  enabled: boolean;
  updated_at: string | null;
}

/** Settings GET — NEVER includes the token, encrypted or otherwise. */
export async function getHubTrackingConfigPublic(): Promise<HubTrackingConfigPublic> {
  const row = await fetchRow();
  if (!row) {
    return { workflow_id: "", configured: false, enabled: false, updated_at: null };
  }
  return {
    workflow_id: row.workflow_id,
    configured: true,
    enabled: row.enabled,
    updated_at: row.updated_at,
  };
}

export interface SaveHubTrackingConfigInput {
  workflowId: string;
  /** Omitted/blank => keep the existing encrypted token. */
  token?: string;
  enabled: boolean;
  updatedBy: string;
}

export async function saveHubTrackingConfig(input: SaveHubTrackingConfigInput): Promise<void> {
  const existing = await fetchRow();
  if (!existing && !input.token) {
    throw new Error("Token is required when configuring Hub tracking for the first time.");
  }

  const updates: Record<string, unknown> = {
    id: CONFIG_ID,
    workflow_id: input.workflowId,
    enabled: input.enabled,
    is_active: true,
    created_by: input.updatedBy,
    updated_at: new Date().toISOString(),
  };
  if (input.token) {
    updates.token_enc = encryptPrivateKey(input.token);
  }

  const { error } = await iapDb()
    .from("hub_tracking_config")
    .upsert(updates, { onConflict: "id" });

  if (error) throw new Error(`Failed to save Hub tracking config: ${error.message}`);
}

/**
 * Resolves the token to use for the Settings save-time credential
 * validation call: the freshly submitted token when given, else the
 * already-stored one (decrypted). Null when neither is available.
 */
export async function resolveTokenForValidation(input: { token?: string }): Promise<string | null> {
  if (input.token) return input.token;
  const row = await fetchRow();
  if (!row) return null;
  try {
    return decryptPrivateKey(row.token_enc);
  } catch (err) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] config: decrypt error (no token logged): ${err instanceof Error ? err.message : err}`,
      "ERROR",
    );
    throw err;
  }
}
