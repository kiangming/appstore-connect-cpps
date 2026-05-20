/**
 * Append-only audit log helper for Google IAP Management.
 *
 * CLAUDE.md invariant: actions_log never UPDATEs, only INSERTs. We don't
 * enforce this at the DB layer (admin backfills occasionally need direct
 * DML) — callers and code review keep it append-only.
 */
import { googleIapDb } from "../db";

export type ActionType =
  | "ACCOUNT_CREATE"
  | "ACCOUNT_VERIFY"
  | "ACCOUNT_DELETE"
  | "APPS_SYNC"
  | "IAPS_LIST_SYNC"
  | "IAP_CREATE"
  | "IAP_UPDATE"
  | "IAP_DELETE"
  | "BULK_IMPORT_BATCH"
  | "PRICING_TEMPLATE_UPLOAD";

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
