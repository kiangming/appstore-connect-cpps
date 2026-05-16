/**
 * Server-side queries for iap_mgmt.iaps + related tables.
 *
 * Draft model (Q-IAP.6): `apple_iap_id IS NULL` = local-only draft. Submit
 * orchestration (handled in the submit API route) fills apple_iap_id when
 * the IAP first goes to Apple.
 */

import { iapDb } from "../db";
import type {
  IapFormState,
  FormLocalization,
} from "../validation";

export interface IapDbRow {
  id: string;
  apple_iap_id: string | null;
  app_id: string;
  product_id: string;
  reference_name: string;
  type: string;
  state: string;
  base_territory: string;
  tier_id: string | null;
  family_sharable: boolean;
  review_note: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IapLocalizationRow {
  id: string;
  iap_id: string;
  locale: string;
  display_name: string;
  description: string;
}

export interface IapScreenshotRow {
  id: string;
  iap_id: string;
  apple_id: string | null;
  file_name: string;
  file_size: number;
  uploaded_at: string | null;
}

export interface IapWithRelations {
  iap: IapDbRow;
  localizations: IapLocalizationRow[];
  screenshots: IapScreenshotRow[];
}

export interface IapAppInfo {
  apple_app_id: string;
  bundle_id: string;
  name: string;
}

/**
 * Read-only lookup by Apple's numeric app id. Returns the internal UUID
 * or null if not yet registered. Used by read-paths that shouldn't
 * upsert (e.g. listing drafts on the IAP list page).
 */
export async function findAppByAppleId(
  appleAppId: string,
): Promise<string | null> {
  const db = iapDb();
  const res = await db
    .from("apps")
    .select("id")
    .eq("apple_app_id", appleAppId)
    .maybeSingle();
  if (res.error) {
    throw new Error(`apps lookup failed: ${res.error.message}`);
  }
  return res.data ? (res.data as { id: string }).id : null;
}

/**
 * Upsert into iap_mgmt.apps using the Apple App Store app id as the unique
 * key. Returns the internal UUID for FK use. Apps registry is independent
 * from Store Management's app registry (Q3 lock).
 */
export async function ensureAppRegistered(info: IapAppInfo): Promise<string> {
  const db = iapDb();

  const existing = await db
    .from("apps")
    .select("id")
    .eq("apple_app_id", info.apple_app_id)
    .maybeSingle();

  if (existing.error) {
    throw new Error(`apps lookup failed: ${existing.error.message}`);
  }
  if (existing.data) {
    return (existing.data as { id: string }).id;
  }

  const ins = await db
    .from("apps")
    .insert({
      apple_app_id: info.apple_app_id,
      bundle_id: info.bundle_id,
      name: info.name,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    throw new Error(`apps insert failed: ${ins.error?.message ?? "no data"}`);
  }
  return (ins.data as { id: string }).id;
}

export interface CreateDraftInput {
  app_id: string; // internal UUID, not the Apple ID
  form: IapFormState;
  actor: string;
}

export async function createDraftIap(input: CreateDraftInput): Promise<IapDbRow> {
  const db = iapDb();

  const iapIns = await db
    .from("iaps")
    .insert({
      app_id: input.app_id,
      product_id: input.form.product_id.trim(),
      reference_name: input.form.reference_name.trim(),
      type: input.form.type || "CONSUMABLE",
      state: "MISSING_METADATA",
      tier_id: input.form.tier_id,
      family_sharable: false,
      review_note: null,
    })
    .select("*")
    .single();
  if (iapIns.error || !iapIns.data) {
    throw new Error(`iap insert failed: ${iapIns.error?.message ?? "no data"}`);
  }
  const row = iapIns.data as IapDbRow;

  await replaceLocalizations(row.id, Object.values(input.form.localizations));

  await db.from("actions_log").insert({
    iap_id: row.id,
    actor: input.actor,
    action_type: "CREATE_IAP",
    payload: {
      product_id: row.product_id,
      reference_name: row.reference_name,
      tier_id: row.tier_id,
    },
  });

  return row;
}

export async function getIapWithRelations(
  iapId: string,
): Promise<IapWithRelations | null> {
  const db = iapDb();

  const iapRes = await db.from("iaps").select("*").eq("id", iapId).maybeSingle();
  if (iapRes.error) throw new Error(`iap fetch failed: ${iapRes.error.message}`);
  if (!iapRes.data) return null;

  const [locRes, scrRes] = await Promise.all([
    db.from("iap_localizations").select("*").eq("iap_id", iapId),
    db.from("iap_screenshots").select("*").eq("iap_id", iapId),
  ]);
  if (locRes.error) throw new Error(`localizations fetch failed: ${locRes.error.message}`);
  if (scrRes.error) throw new Error(`screenshots fetch failed: ${scrRes.error.message}`);

  return {
    iap: iapRes.data as IapDbRow,
    localizations: (locRes.data ?? []) as IapLocalizationRow[],
    screenshots: (scrRes.data ?? []) as IapScreenshotRow[],
  };
}

export interface UpdateDraftInput {
  reference_name?: string;
  tier_id?: string | null;
  family_sharable?: boolean;
  review_note?: string | null;
}

export async function updateIap(
  iapId: string,
  patch: UpdateDraftInput,
  actor: string,
): Promise<void> {
  const db = iapDb();
  const updates: Record<string, unknown> = {};
  if (patch.reference_name !== undefined)
    updates.reference_name = patch.reference_name.trim();
  if (patch.tier_id !== undefined) updates.tier_id = patch.tier_id;
  if (patch.family_sharable !== undefined)
    updates.family_sharable = patch.family_sharable;
  if (patch.review_note !== undefined) updates.review_note = patch.review_note;

  if (Object.keys(updates).length === 0) return;

  const res = await db.from("iaps").update(updates).eq("id", iapId);
  if (res.error) throw new Error(`iap update failed: ${res.error.message}`);

  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "UPDATE_IAP",
    payload: updates,
  });
}

/**
 * Replace all localizations for an IAP. Filters empty pairs (Manager
 * "có cái nào import cái đó"). Caller is responsible for actor audit
 * (this is called as part of create/update flows already logged).
 */
export async function replaceLocalizations(
  iapId: string,
  localizations: FormLocalization[],
): Promise<void> {
  const db = iapDb();

  const del = await db
    .from("iap_localizations")
    .delete()
    .eq("iap_id", iapId);
  if (del.error) {
    throw new Error(`localizations delete failed: ${del.error.message}`);
  }

  const filled = localizations.filter(
    (l) => l.display_name.trim() !== "" && l.description.trim() !== "",
  );
  if (filled.length === 0) return;

  const rows = filled.map((l) => ({
    iap_id: iapId,
    locale: l.locale,
    display_name: l.display_name.trim(),
    description: l.description.trim(),
  }));
  const ins = await db.from("iap_localizations").insert(rows);
  if (ins.error) {
    throw new Error(`localizations insert failed: ${ins.error.message}`);
  }
}

export async function deleteIap(iapId: string, actor: string): Promise<void> {
  const db = iapDb();

  // Log BEFORE delete so the action_log row has iap_id set; ON DELETE SET NULL
  // will null it after cascade, which is the desired audit shape.
  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "DELETE_IAP",
    payload: {},
  });

  const res = await db.from("iaps").delete().eq("id", iapId);
  if (res.error) throw new Error(`iap delete failed: ${res.error.message}`);
}

export async function logSubmitAttempt(
  iapId: string,
  actor: string,
  result: "SUCCESS" | "ERROR",
  details: Record<string, unknown>,
): Promise<void> {
  const db = iapDb();
  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "SUBMIT_TO_APPLE",
    payload: { result, ...details },
  });
}

export interface ListDraftsResult {
  drafts: IapDbRow[];
}

/** List local draft IAPs (apple_iap_id NULL) scoped to an app. */
export async function listDraftIaps(appId: string): Promise<ListDraftsResult> {
  const db = iapDb();
  const res = await db
    .from("iaps")
    .select("*")
    .eq("app_id", appId)
    .is("apple_iap_id", null)
    .order("created_at", { ascending: false });
  if (res.error) throw new Error(`drafts list failed: ${res.error.message}`);
  return { drafts: (res.data ?? []) as IapDbRow[] };
}

/**
 * Apple-IAP-id → internal-UUID map for the synced rows of an app. Used by
 * the list-page multi-select flow to translate Apple-side checkbox selections
 * into the internal UUIDs the submit-batch endpoint expects.
 */
export async function listSyncedAppleIapMap(
  internalAppId: string,
): Promise<Record<string, string>> {
  const db = iapDb();
  const res = await db
    .from("iaps")
    .select("id, apple_iap_id")
    .eq("app_id", internalAppId)
    .not("apple_iap_id", "is", null);
  if (res.error) {
    throw new Error(`synced map fetch failed: ${res.error.message}`);
  }
  const map: Record<string, string> = {};
  for (const row of (res.data ?? []) as Array<{
    id: string;
    apple_iap_id: string | null;
  }>) {
    if (row.apple_iap_id) map[row.apple_iap_id] = row.id;
  }
  return map;
}
