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
 * D0 [arc-google-missing-purchase-options] — "chưa từng đọc" ≠ "đọc ra rỗng".
 *
 * `iaps_last_synced_at` = the last IAP Refresh that fetched the FULL list and
 * wrote every product into the mirror with 0 failures. NULL ⇒ the mirror of
 * this app row has never been filled, so an empty mirror means "unknown",
 * not "no item exists" — bulk import must refuse (preview + execute).
 *
 * ⚠ Deliberately NOT part of APP_COLUMNS. getAppByPackage has ~17 callers
 *   across the module; if this column were selected there and the code ran
 *   before the migration, the WHOLE Google module would fail. Read on its
 *   own, only the bulk-import surfaces that need it fail — and they fail
 *   loudly, which is the point.
 * ⚠ THROWS on a read error. A caller that turns this error into `null` would
 *   rebuild the exact bug D0 closes ("could not read" ⇒ "never synced" is
 *   fine, but the reverse habit — error ⇒ some default — is how
 *   `.catch(() => [])` made every row NEW).
 */
export async function getIapsMirrorSyncedAt(appId: string): Promise<string | null> {
  const { data, error } = await googleIapDb()
    .from("apps")
    .select("iaps_last_synced_at")
    .eq("id", appId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read IAP mirror sync state: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Failed to read IAP mirror sync state: app ${appId} not found.`);
  }
  return (data as { iaps_last_synced_at: string | null }).iaps_last_synced_at ?? null;
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
