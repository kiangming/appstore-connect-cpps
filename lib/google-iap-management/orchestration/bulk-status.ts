/**
 * Cycle 41 — Bulk Activate / Bulk Deactivate orchestrator.
 *
 * Manager flips the sale state of N selected items on Google Play in a
 * single Manager action. Google's `monetization.onetimeproducts.
 * purchaseOptions.batchUpdateStates` endpoint is multi-product native
 * (uses `productId="-"` as a cross-product wildcard), so one POST flips
 * up to ~100 products at once. The orchestrator chunks the input
 * sequentially at the documented batch ceiling and aggregates per-item
 * results into the modal-facing roll-up.
 *
 * Architecture pivot vs Apple Cycle 40 Phase A:
 *   Apple's `availabilities` endpoint is per-IAP only, so that path
 *   needed `withConcurrency(2)` + `withRetry` + per-row RetryCounters
 *   to stay under the ~1 req/sec ASC budget. Google's batch endpoint
 *   bypasses that machinery — sequential 1-POST-per-chunk handles 1000
 *   items in 10 round-trips × ~3-5s each ≈ 30-50s total wall time,
 *   well under Google's per-minute quota.
 *
 * Per-chunk error handling:
 *   If a chunk POST fails (network, 5xx, auth, etc.), all items in that
 *   chunk are surfaced as failed with the same error message. Sibling
 *   chunks continue. A future enhancement could fall back to per-item
 *   legacy `inappproducts.patch` for the failing chunk, but Manager
 *   workflow today is "re-trigger the modal" which gives the same
 *   recovery without the orchestrator owning fallback complexity.
 *
 * Cache write-back:
 *   On successful chunks, the orchestrator updates `iaps.status` in the
 *   local cache directly (no need to re-fetch full products since we
 *   know what state we set — mirrors the Hotfix 12 desired-state
 *   overlay pattern). List page will then render the updated state on
 *   the next render after router.refresh().
 *
 * Audit log:
 *   One `BULK_ACTIVATE` or `BULK_DEACTIVATE` entry per Manager action
 *   with payload carrying { sku_count, succeeded, failed, items[] }.
 *   Append-only (CLAUDE.md invariant §10.1).
 */
import type { JWT } from "google-auth-library";

import {
  batchUpdateProductStates,
  DEFAULT_PURCHASE_OPTION_ID,
  type BulkStateRequest,
} from "../google/publisher-client";
import { googleIapDb } from "../db";
import { appendAction } from "../repository/actions-log";

export type BulkStatusAction = "activate" | "deactivate";

export interface BulkStatusItemResult {
  sku: string;
  ok: boolean;
  error?: string;
}

export interface BulkStatusOutcome {
  action: BulkStatusAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkStatusItemResult[];
  overall: "SUCCESS" | "PARTIAL" | "FAILURE" | "NO_OP";
  summary: string;
  /** Convenience for the modal — number of chunks fired against Google. */
  batches: number;
}

export interface BulkStatusArgs {
  jwt: JWT;
  appId: string;
  packageName: string;
  skus: readonly string[];
  action: BulkStatusAction;
  actorEmail: string | null;
  /** Chunk ceiling — defaults to 100 (Google batch quota guidance). */
  chunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 100;

export async function executeBulkStatus(
  args: BulkStatusArgs,
): Promise<BulkStatusOutcome> {
  const {
    jwt,
    appId,
    packageName,
    skus,
    action,
    actorEmail,
    chunkSize = DEFAULT_CHUNK_SIZE,
  } = args;

  if (skus.length === 0) {
    return {
      action,
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      overall: "NO_OP",
      summary: "No items selected.",
      batches: 0,
    };
  }

  const chunks = chunkArray(skus, chunkSize);
  const apiState: "ACTIVATE" | "DEACTIVATE" =
    action === "activate" ? "ACTIVATE" : "DEACTIVATE";
  const newCacheStatus: "active" | "inactive" =
    action === "activate" ? "active" : "inactive";

  console.log(
    `[bulk-status] start action=${action} pkg=${packageName} count=${skus.length} chunks=${chunks.length} actor=${actorEmail ?? "?"}`,
  );

  const results: BulkStatusItemResult[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const requests: BulkStateRequest[] = chunk.map((sku) => ({
      productId: sku,
      purchaseOptionId: DEFAULT_PURCHASE_OPTION_ID,
      state: apiState,
    }));

    try {
      await batchUpdateProductStates(jwt, packageName, requests);
      for (const sku of chunk) {
        results.push({ sku, ok: true });
      }
      await updateCachedStatus(appId, chunk, newCacheStatus);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[bulk-status] chunk ${i + 1}/${chunks.length} failed pkg=${packageName} action=${action} size=${chunk.length} err="${errorMessage.replace(/"/g, "'")}"`,
      );
      for (const sku of chunk) {
        results.push({ sku, ok: false, error: errorMessage });
      }
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const overall: BulkStatusOutcome["overall"] =
    succeeded === results.length
      ? "SUCCESS"
      : succeeded === 0
        ? "FAILURE"
        : "PARTIAL";
  const summary = `${succeeded}/${results.length} succeeded${
    failed > 0 ? ` · ${failed} failed` : ""
  }`;

  await appendAction({
    actionType: action === "activate" ? "BULK_ACTIVATE" : "BULK_DEACTIVATE",
    actorEmail,
    targetId: appId,
    payload: {
      package_name: packageName,
      total: results.length,
      succeeded,
      failed,
      batches: chunks.length,
      chunk_size: chunkSize,
      items: results,
    },
  });

  console.log(
    `[bulk-status] complete action=${action} pkg=${packageName} overall=${overall} ${summary} batches=${chunks.length}`,
  );

  return {
    action,
    total: results.length,
    succeeded,
    failed,
    results,
    overall,
    summary,
    batches: chunks.length,
  };
}

/**
 * Slice an array into N-sized chunks. Order-preserving so the result
 * ordering aligns with input ordering (the modal renders rows in input
 * order so Manager sees their selection sequence reflected).
 */
export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunkArray: size must be ≥ 1");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Batch-update `iaps.status` for one chunk of SKUs after a successful
 * Google batch call. Failures here are logged but non-fatal — the cache
 * will reconcile on the next Refresh from Google.
 */
async function updateCachedStatus(
  appId: string,
  skus: readonly string[],
  status: "active" | "inactive",
): Promise<void> {
  if (skus.length === 0) return;
  try {
    const { error } = await googleIapDb()
      .from("iaps")
      .update({
        status,
        last_synced_at: new Date().toISOString(),
      })
      .eq("app_id", appId)
      .in("sku", skus as string[]);
    if (error) {
      console.error(
        `[bulk-status] cache update failed appId=${appId} count=${skus.length} err="${error.message.replace(/"/g, "'")}"`,
      );
    }
  } catch (err) {
    console.error(
      `[bulk-status] cache update threw appId=${appId} count=${skus.length} err="${err instanceof Error ? err.message.replace(/"/g, "'") : String(err)}"`,
    );
  }
}
