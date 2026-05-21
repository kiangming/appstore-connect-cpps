/**
 * Apps repository — Google Play apps cache scoped per Google Console account.
 *
 * The cache is populated by the Reporting API (apps.search) and refreshed
 * via the Manager's "Refresh from Google" button. Apps are stored per
 * (account, packageName) — the same package may be visible under multiple
 * Service Accounts in theory; in practice the Manager treats accounts as
 * independent tenants.
 */
import { googleIapDb } from "../db";

export interface AppRow {
  id: string;
  google_console_account_id: string;
  package_name: string;
  display_name: string | null;
  default_currency: string | null;
  default_language: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

const APP_COLUMNS =
  "id, google_console_account_id, package_name, display_name, default_currency, default_language, last_synced_at, created_at, updated_at";

export async function listAppsForAccount(
  accountId: string,
): Promise<AppRow[]> {
  const { data, error } = await googleIapDb()
    .from("apps")
    .select(APP_COLUMNS)
    .eq("google_console_account_id", accountId)
    .order("display_name", { ascending: true })
    .order("package_name", { ascending: true });

  if (error) {
    throw new Error(`Failed to list apps: ${error.message}`);
  }
  return (data ?? []) as AppRow[];
}

export async function getAppByPackage(
  accountId: string,
  packageName: string,
): Promise<AppRow | null> {
  const { data, error } = await googleIapDb()
    .from("apps")
    .select(APP_COLUMNS)
    .eq("google_console_account_id", accountId)
    .eq("package_name", packageName)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch app: ${error.message}`);
  }
  return (data as AppRow | null) ?? null;
}

export interface UpsertAppArgs {
  accountId: string;
  packageName: string;
  displayName?: string | null;
}

/**
 * UPSERT a single app row, bumping last_synced_at to NOW(). Used by the
 * apps.search refresh loop. (account_id, package_name) is the natural key.
 */
export async function upsertAppFromSync(args: UpsertAppArgs): Promise<void> {
  const { error } = await googleIapDb()
    .from("apps")
    .upsert(
      {
        google_console_account_id: args.accountId,
        package_name: args.packageName,
        display_name: args.displayName ?? null,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "google_console_account_id,package_name" },
    );

  if (error) {
    throw new Error(`Failed to upsert app ${args.packageName}: ${error.message}`);
  }
}

/**
 * Hotfix 4: update an app's cached default_currency + default_language
 * without touching last_synced_at (this is a side-channel write done
 * during apps refresh and opportunistically during IAPs refresh; the
 * primary sync timestamp is owned by the corresponding upsert path).
 *
 * Either field may be passed as `null` (no change). Pass an actual
 * value to overwrite. Caller decides precedence (e.g. IAPs-refresh
 * ground truth wins over apps-refresh fallback inference).
 */
export async function updateAppDefaults(
  appId: string,
  defaults: { currency?: string | null; language?: string | null },
): Promise<void> {
  const patch: Record<string, string | null> = {};
  if (defaults.currency !== undefined && defaults.currency !== null) {
    patch.default_currency = defaults.currency;
  }
  if (defaults.language !== undefined && defaults.language !== null) {
    patch.default_language = defaults.language;
  }
  if (Object.keys(patch).length === 0) return;

  const { error } = await googleIapDb()
    .from("apps")
    .update(patch)
    .eq("id", appId);

  if (error) {
    throw new Error(`Failed to update app defaults: ${error.message}`);
  }
}

/**
 * Batch UPSERT — single SQL statement (avoids per-row round-trip). Used
 * after a full Reporting API walk completes successfully.
 */
export async function batchUpsertAppsFromSync(
  accountId: string,
  apps: Array<{ packageName: string; displayName?: string | null }>,
): Promise<void> {
  if (apps.length === 0) return;
  const now = new Date().toISOString();
  const rows = apps.map((a) => ({
    google_console_account_id: accountId,
    package_name: a.packageName,
    display_name: a.displayName ?? null,
    last_synced_at: now,
  }));

  const { error } = await googleIapDb()
    .from("apps")
    .upsert(rows, { onConflict: "google_console_account_id,package_name" });

  if (error) {
    throw new Error(`Failed to batch-upsert apps: ${error.message}`);
  }
}
