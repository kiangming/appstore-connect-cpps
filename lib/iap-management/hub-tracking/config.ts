/**
 * lib/iap-management/hub-tracking/config.ts — Server-side only.
 *
 * Reads/writes the singleton VNGGames Hub tracking config row
 * (iap_mgmt.hub_tracking_config): workflow_id + encrypted ingest token +
 * the Settings `enabled` toggle. Mirrors lib/asc-account-repository.ts —
 * in-memory 5-minute TTL cache, encrypted-at-rest secret via the SAME
 * AES-256-GCM helpers ASC accounts use (no new crypto).
 *
 * `getActiveHubTrackingCredentials` is the ONE no-op gate every Hub call
 * goes through: returns null when no row exists OR `enabled` is false, so
 * callers never need a separate "is tracking on" check.
 */

import { iapDb } from "@/lib/iap-management/db";
import { encryptPrivateKey, decryptPrivateKey } from "@/lib/asc-crypto";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONFIG_ID = "default";

interface HubTrackingConfigRow {
  id: string;
  workflow_id: string;
  token_enc: string;
  enabled: boolean;
  updated_at: string;
}

let _cache: { row: HubTrackingConfigRow | null; expiresAt: number } | null = null;

function getCached(): { row: HubTrackingConfigRow | null } | null {
  if (_cache && Date.now() < _cache.expiresAt) return { row: _cache.row };
  return null;
}

function setCache(row: HubTrackingConfigRow | null): void {
  _cache = { row, expiresAt: Date.now() + CACHE_TTL_MS };
}

export function invalidateHubTrackingCache(): void {
  _cache = null;
}

async function fetchRow(): Promise<HubTrackingConfigRow | null> {
  const cached = getCached();
  if (cached) return cached.row;

  const { data, error } = await iapDb()
    .from("hub_tracking_config")
    .select("id, workflow_id, token_enc, enabled, updated_at")
    .eq("id", CONFIG_ID)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Hub tracking config: ${error.message}`);
  }
  const row = (data as HubTrackingConfigRow | null) ?? null;
  setCache(row);
  return row;
}

export interface HubTrackingCredentials {
  workflowId: string;
  token: string;
}

/**
 * The single no-op gate: null means "no Hub call should be attempted"
 * (either unconfigured or the Settings toggle is off). Callers never need
 * a separate enabled check.
 */
export async function getActiveHubTrackingCredentials(): Promise<HubTrackingCredentials | null> {
  const row = await fetchRow();
  if (!row || !row.enabled) return null;
  return { workflowId: row.workflow_id, token: decryptPrivateKey(row.token_enc) };
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
  invalidateHubTrackingCache();
}

/**
 * Resolves the token to use for the Settings save-time credential
 * validation call: the freshly submitted token when given, else the
 * already-stored one (decrypted). Null when neither is available.
 */
export async function resolveTokenForValidation(input: { token?: string }): Promise<string | null> {
  if (input.token) return input.token;
  const row = await fetchRow();
  return row ? decryptPrivateKey(row.token_enc) : null;
}
