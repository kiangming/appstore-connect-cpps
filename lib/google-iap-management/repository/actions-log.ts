/**
 * Append-only audit log helper for Google IAP Management.
 *
 * CLAUDE.md invariant: actions_log never UPDATEs, only INSERTs. We don't
 * enforce this at the DB layer (admin backfills occasionally need direct
 * DML) — callers and code review keep it append-only.
 */
import { googleIapDb } from "../db";

/**
 * Every value allowed in `google_iap_mgmt.actions_log.action_type`, matching
 * the CHECK constraint as of migration `20260702120000`.
 *
 * Declared as a `const` array (not a bare union) so the cross-module P2 guard
 * can enumerate it at runtime and assert set-equality against the migration —
 * see `lib/audit-constraints/`. A union type alone is invisible to the guard.
 * `ActionType` is derived from it, so `appendAction` keeps exactly the compiler
 * coverage it had.
 */
export const GOOGLE_ACTION_TYPES = [
  "ACCOUNT_CREATE",
  "ACCOUNT_VERIFY",
  "ACCOUNT_DELETE",
  "APPS_SYNC",
  "IAPS_LIST_SYNC",
  "IAP_CREATE",
  "IAP_UPDATE",
  "IAP_DELETE",
  "IAP_ACKNOWLEDGE_REMOVE",
  "BULK_IMPORT_BATCH",
  "BULK_ACTIVATE",
  "BULK_DEACTIVATE",
  "PRICING_TEMPLATE_UPLOAD",
] as const;

export type ActionType = (typeof GOOGLE_ACTION_TYPES)[number];

export interface AppendActionArgs {
  actionType: ActionType;
  actorEmail?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown>;
}

export async function appendAction(args: AppendActionArgs): Promise<void> {
  const { error } = await googleIapDb()
    .from("actions_log")
    .insert({
      action_type: args.actionType,
      actor_email: args.actorEmail ?? null,
      target_id: args.targetId ?? null,
      payload: args.payload ?? {},
    });

  if (error) {
    // Audit log failures should not block primary actions but must surface
    // in server logs for investigation.
    console.error(
      `[google-iap:audit] append_failed type=${args.actionType} actor=${args.actorEmail ?? "?"} err="${error.message}"`,
    );
  }
}
