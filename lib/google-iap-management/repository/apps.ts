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
import {
  APP_DEFAULT_DECLARED,
  APP_DEFAULT_GUESSED,
  type AppDefaultField,
  type AppDefaultSource,
  type AppDefaultValue,
  type AppDefaultsState,
} from "../app-defaults";

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

/**
 * G1c/C4 — RÒ RỈ CROSS-ACCOUNT ĐÃ SỬA: `accountId` nay BẮT BUỘC.
 *
 * Trước G1c hàm này tra app theo id trần, không kiểm account. Biết một
 * `appId` là xem được app — và qua đó là ma trận giá — của account khác.
 * Anh em của nó, `getAppByPackage(accountId, packageName)`, vốn ĐÃ lọc;
 * chỉ đường theo-id là hở.
 *
 * ⚠ Tham số BẮT BUỘC chứ không phải tuỳ chọn: tuỳ chọn thì call site cũ
 *   vẫn biên dịch sạch và lỗ vẫn nguyên. Bắt buộc ⇒ tsc chỉ mặt từng chỗ.
 * ⚠ Trả `null` (→ 404) chứ không ném 403: không xác nhận với người gọi
 *   rằng id đó có tồn tại. Cùng kỷ luật với route matrix-export.
 */
export async function getAppById(
  appId: string,
  accountId: string,
): Promise<AppRow | null> {
  const { data, error } = await googleIapDb()
    .from("apps")
    .select(APP_COLUMNS)
    .eq("id", appId)
    .eq("google_console_account_id", accountId)
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
 * D0 + D9 [arc-google-missing-purchase-options] — everything bulk import needs
 * to decide whether it may run, in ONE read: was the IAP mirror ever filled
 * completely (D0), and are the app's currency/language DECLARED by the Manager
 * (D9). Consumed by lib/google-iap-management/bulk-import-mirror-gate.ts (the
 * ONE gate) and by the surfaces that display/declare the defaults.
 *
 * ⚠ These columns are deliberately NOT part of APP_COLUMNS. getAppByPackage
 *   has ~17 callers across the module; selecting new columns there would make
 *   the WHOLE Google module fail if the code ran before the migrations. Read
 *   on their own, only the surfaces that need them fail — loudly.
 * ⚠ THROWS on a read error. A caller that turns this error into a default
 *   would rebuild the bug D0 closes (`.catch(() => [])` made every row NEW).
 */
export interface AppImportReadiness {
  iapsLastSyncedAt: string | null;
  defaults: AppDefaultsState;
}

const READINESS_COLUMNS =
  "iaps_last_synced_at, default_currency, default_currency_source, default_language, default_language_source";

export async function getAppImportReadiness(appId: string): Promise<AppImportReadiness> {
  const { data, error } = await googleIapDb()
    .from("apps")
    .select(READINESS_COLUMNS)
    .eq("id", appId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read app import readiness: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Failed to read app import readiness: app ${appId} not found.`);
  }
  const row = data as {
    iaps_last_synced_at: string | null;
    default_currency: string | null;
    default_currency_source: string | null;
    default_language: string | null;
    default_language_source: string | null;
  };
  return {
    iapsLastSyncedAt: row.iaps_last_synced_at ?? null,
    defaults: {
      currency: { value: row.default_currency ?? null, source: toSource(row.default_currency_source) },
      language: { value: row.default_language ?? null, source: toSource(row.default_language_source) },
    },
  };
}

/** Unknown provenance strings read as null (⇒ not declared ⇒ import blocked). */
function toSource(raw: string | null): AppDefaultSource | null {
  return raw === APP_DEFAULT_DECLARED || raw === APP_DEFAULT_GUESSED ? raw : null;
}

/** The value changed between the page that sent the declaration and the write. */
export class AppDefaultChangedError extends Error {}

/**
 * D9 — the ONLY writer of apps.default_currency / default_language (and their
 * provenance). Called by the declare route when the Manager declares or
 * confirms a value. Writes the value AND `<field>_source = 'declared'`
 * together, on one row.
 *
 * Compare-and-set: the write is filtered on `expected` — the value + source
 * the Manager was looking at. "Confirm USD" from a stale page must not
 * replace a declaration someone else made in between; 0 rows ⇒
 * AppDefaultChangedError (the caller reports it, nothing is written).
 *
 * ⚠ No other code path may write these columns — both refresh routes stopped
 *   in C2; app-defaults.structural.test.ts (block W) pins it.
 * ⚠ Verifies exactly ONE row was written (KB §9 P2).
 */
export async function declareAppDefault(
  appId: string,
  field: AppDefaultField,
  value: string,
  expected: AppDefaultValue,
): Promise<void> {
  const valueCol = field === "currency" ? "default_currency" : "default_language";
  const sourceCol = field === "currency" ? "default_currency_source" : "default_language_source";
  const patch =
    field === "currency"
      ? { default_currency: value, default_currency_source: APP_DEFAULT_DECLARED }
      : { default_language: value, default_language_source: APP_DEFAULT_DECLARED };
  let q = googleIapDb().from("apps").update(patch).eq("id", appId);
  q = expected.value === null ? q.is(valueCol, null) : q.eq(valueCol, expected.value);
  q = expected.source === null ? q.is(sourceCol, null) : q.eq(sourceCol, expected.source);
  const { data, error } = await q.select("id");
  if (error) {
    throw new Error(`Failed to declare app ${field}: ${error.message}`);
  }
  const written = Array.isArray(data) ? data.length : 0;
  if (written === 0) {
    throw new AppDefaultChangedError(
      `The app's ${field} changed since it was read (or the app row is gone) — nothing was written.`,
    );
  }
  if (written !== 1) {
    throw new Error(`Failed to declare app ${field}: expected 1 app row updated, got ${written}.`);
  }
}

/**
 * D0 — stamp a COMPLETE IAP Refresh. Only the IAP refresh route calls this,
 * and only when the full list was fetched AND `failed === 0`.
 *
 * ⚠ Verifies that exactly ONE row was written (KB §9 P2: a write nobody
 *   inspects fails silently). 0 rows ⇒ throw — the mirror would otherwise
 *   look "never synced" while the caller reports success.
 */
export async function markIapsMirrorSynced(appId: string, syncedAt: string): Promise<void> {
  const { data, error } = await googleIapDb()
    .from("apps")
    .update({ iaps_last_synced_at: syncedAt })
    .eq("id", appId)
    .select("id");
  if (error) {
    throw new Error(`Failed to record IAP mirror sync time: ${error.message}`);
  }
  const written = Array.isArray(data) ? data.length : 0;
  if (written !== 1) {
    throw new Error(
      `Failed to record IAP mirror sync time: expected 1 app row updated, got ${written}.`,
    );
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
