/**
 * Cycle 39 Phase 2 — Bulk Availabilities orchestrator.
 *
 * Iterates a set of internal IAP UUIDs and flips each one's Apple-side
 * availability to either ALL territories or "Remove from Sales", reusing
 * the Phase 1 Apple helpers + audit action types so dashboards stay in
 * sync with single-item edits.
 *
 * Discipline mirrors the §4.4 multi-stage pattern + Q-K fail-soft:
 *   • One Apple POST per IAP via withConcurrency<T,R> at 5 parallel.
 *   • Per-IAP try/catch — a single failure never cancels siblings.
 *   • One actions_log row per IAP (success or error severity).
 *   • Aggregate roll-up returned to the API route so the modal can render
 *     per-row + summary in the same response.
 *
 * Input is internal `iap_mgmt.iaps.id` rows; the orchestrator resolves
 * each row's `apple_iap_id` before calling Apple. Rows without an
 * apple_iap_id are surfaced as per-row failures (caller may filter local
 * drafts upstream, but the orchestrator is defensive about it).
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { withConcurrency } from "@/lib/iap-management/concurrency";
import { iapDb } from "@/lib/iap-management/db";
import {
  setAvailabilityToAllTerritories,
  setAvailabilityRemoveFromSales,
} from "@/lib/iap-management/apple/availabilities";

export type BulkAvailabilityAction = "set-all" | "remove";

export interface BulkAvailabilityArgs {
  creds: AscCredentials;
  /** Internal `iap_mgmt.iaps.id` rows targeted by Manager's selection. */
  iapIds: readonly string[];
  action: BulkAvailabilityAction;
  /** Email or session identifier captured into actions_log.actor. */
  actor: string;
  /** Concurrency ceiling — Manager kickoff locked 5. */
  concurrency?: number;
}

export interface BulkAvailabilityRowResult {
  iapId: string;
  apple_iap_id?: string;
  ok: boolean;
  /** Apple's availability resource id after a successful POST. */
  apple_availability_id?: string;
  error?: string;
}

export interface BulkAvailabilityOutcome {
  action: BulkAvailabilityAction;
  total: number;
  succeeded: number;
  failed: number;
  /** Per-IAP results in input order. */
  results: BulkAvailabilityRowResult[];
  /** Convenience roll-up for the API response. */
  overall: "SUCCESS" | "PARTIAL" | "FAILURE" | "NO_OP";
  summary: string;
}

export async function executeBulkAvailability(
  args: BulkAvailabilityArgs,
): Promise<BulkAvailabilityOutcome> {
  const { creds, iapIds, action, actor, concurrency = 5 } = args;

  if (iapIds.length === 0) {
    return {
      action,
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      overall: "NO_OP",
      summary: "No IAPs selected.",
    };
  }

  console.log(
    `[bulk-availability] start action=${action} count=${iapIds.length} actor=${actor}`,
  );

  // Resolve apple_iap_id once up front so the per-row work is just the
  // Apple POST + audit insert. One DB round-trip beats N individual reads
  // inside the workers.
  const appleIdByRow = await resolveAppleIapIds(iapIds);

  const action_type =
    action === "set-all"
      ? "AVAILABILITY_SET_ALL_TERRITORIES"
      : "AVAILABILITY_REMOVE_FROM_SALES";

  const results = await withConcurrency<string, BulkAvailabilityRowResult>(
    iapIds,
    concurrency,
    async (iapId) => {
      const appleIapId = appleIdByRow.get(iapId);
      if (!appleIapId) {
        const error =
          "IAP not synced to Apple — local draft. Run Create on Apple first.";
        await writeAuditRow(actor, iapId, action_type, {
          result: "ERROR",
          error,
          target: action === "set-all" ? "ALL" : "NONE",
        });
        return { iapId, ok: false, error };
      }
      try {
        const res =
          action === "set-all"
            ? await setAvailabilityToAllTerritories(creds, appleIapId)
            : await setAvailabilityRemoveFromSales(creds, appleIapId);
        const apple_availability_id = res.data?.id;
        await writeAuditRow(actor, iapId, action_type, {
          apple_iap_id: appleIapId,
          result: "SUCCESS",
          target: action === "set-all" ? "ALL" : "NONE",
          ...(apple_availability_id ? { apple_availability_id } : {}),
          source: "bulk",
        });
        return {
          iapId,
          apple_iap_id: appleIapId,
          ok: true,
          ...(apple_availability_id ? { apple_availability_id } : {}),
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await writeAuditRow(actor, iapId, action_type, {
          apple_iap_id: appleIapId,
          result: "ERROR",
          target: action === "set-all" ? "ALL" : "NONE",
          source: "bulk",
          error,
        });
        return { iapId, apple_iap_id: appleIapId, ok: false, error };
      }
    },
  );

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const overall: BulkAvailabilityOutcome["overall"] =
    succeeded === results.length
      ? "SUCCESS"
      : succeeded === 0
        ? "FAILURE"
        : "PARTIAL";
  const summary = `${succeeded}/${results.length} succeeded${
    failed > 0 ? ` · ${failed} failed` : ""
  }`;

  console.log(
    `[bulk-availability] complete action=${action} overall=${overall} ${summary}`,
  );

  return { action, total: results.length, succeeded, failed, results, overall, summary };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveAppleIapIds(
  iapIds: readonly string[],
): Promise<Map<string, string>> {
  const db = iapDb();
  const { data, error } = await db
    .from("iaps")
    .select("id, apple_iap_id")
    .in("id", iapIds as string[]);
  const out = new Map<string, string>();
  if (error || !data) return out;
  for (const row of data as Array<{ id: string; apple_iap_id: string | null }>) {
    if (row.apple_iap_id) out.set(row.id, row.apple_iap_id);
  }
  return out;
}

async function writeAuditRow(
  actor: string,
  iapId: string,
  action_type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await iapDb().from("actions_log").insert({
      iap_id: iapId,
      actor,
      action_type,
      payload,
    });
    if (error) {
      console.error(
        `[bulk-availability] audit insert error iap=${iapId} action=${action_type}: ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[bulk-availability] audit insert threw iap=${iapId} action=${action_type}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
