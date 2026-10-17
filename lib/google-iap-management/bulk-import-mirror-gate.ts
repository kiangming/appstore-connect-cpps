/**
 * THE bulk-import gate [arc-google-missing-purchase-options — D0, D2].
 * ONE gate for every route that runs a bulk import (preview decides
 * NEW/EXISTING from the IAP mirror; execute writes that plan). A second,
 * private gate in a route is forbidden — app-defaults.structural.test.ts
 * (block G) pins it.
 *
 * Incident (com.vnggames.ballisticherotwid, 2026-10-16): the IAP mirror had
 * never been filled ⇒ 28/28 "NEW" ⇒ 28 CREATEs onto products that already
 * existed on Google.
 *
 * ONE condition: the app row's IAP list was refreshed completely at least once
 * (apps.iaps_last_synced_at, backfilled once from history by 20261016020000).
 *
 * ⚠ The app's currency / language are NOT conditions (C2.1, Manager
 *   2026-10-16): the currency in the import file is meant to be the only
 *   source of prices, so the app's value must not decide whether an import
 *   runs. Nothing here may read their provenance.
 *
 * States, never collapsed:
 *   error    — the sync state could not be READ   → 503 IMPORT_READINESS_READ_FAILED (D2)
 *   blocked  — never refreshed completely (D0)     → 409 IAPS_NEVER_SYNCED
 *   ok       — refreshed completely at least once  → proceed
 * MIRROR_READ_FAILED is the IAP list itself, read later by preview.
 *
 * ⚠ "Could not read" must NEVER become "never synced" or ok.
 */
import { getIapsMirrorSyncedAt } from "./repository/apps";

export const IAPS_NEVER_SYNCED = "IAPS_NEVER_SYNCED" as const;
export const MIRROR_READ_FAILED = "MIRROR_READ_FAILED" as const;
export const IMPORT_READINESS_READ_FAILED = "IMPORT_READINESS_READ_FAILED" as const;

export type BulkImportBlocker = typeof IAPS_NEVER_SYNCED;

export type BulkImportGate =
  | { kind: "error"; message: string }
  | { kind: "blocked"; blockers: BulkImportBlocker[]; iapsLastSyncedAt: null }
  | { kind: "ok"; iapsLastSyncedAt: string };

export async function readBulkImportGate(appId: string): Promise<BulkImportGate> {
  let syncedAt: string | null;
  try {
    syncedAt = await getIapsMirrorSyncedAt(appId);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (!syncedAt) {
    return { kind: "blocked", blockers: [IAPS_NEVER_SYNCED], iapsLastSyncedAt: null };
  }
  return { kind: "ok", iapsLastSyncedAt: syncedAt };
}

/**
 * The ONE refusal both routes return for a gate that is not open. Routes only
 * test `gate.kind !== "ok"` and hand the rest over — they must not branch on
 * gate internals themselves.
 */
export function bulkImportGateRefusal(
  gate: Exclude<BulkImportGate, { kind: "ok" }>,
  packageName: string,
): { status: number; message: string; body: Record<string, unknown> } {
  if (gate.kind === "error") {
    const message = readinessReadFailedMessage(gate.message);
    return { status: 503, message, body: { error: message, code: IMPORT_READINESS_READ_FAILED } };
  }
  const message = neverSyncedMessage(packageName);
  return {
    status: 409,
    message,
    body: {
      error: message,
      // First blocker for clients that read one code; the full list alongside.
      code: gate.blockers[0],
      blockers: gate.blockers,
    },
  };
}

/**
 * C2.1a — the ONE rule for whether an IAP Refresh may stamp
 * apps.iaps_last_synced_at (the gate's only input). The refresh route asks;
 * nothing else decides.
 *
 *   failed > 0                          → no stamp: some products did not reach the mirror.
 *   0 products AND the mirror holds N>0 → no stamp: an empty answer from Google next to
 *                                         a populated mirror is a suspicious read, not
 *                                         proof the app has nothing (tamquoc.chienky,
 *                                         2026-10-12: empty_response, mirror 16).
 *   0 products AND an empty mirror      → stamp: the app genuinely has no items.
 *   otherwise                           → stamp.
 * "The mirror holds items" = countLiveMirrorItems (rows not flagged deleted on
 * Google) — the same definition the one-time backfill uses.
 */
export const STAMP_SKIPPED_FAILED_ROWS = "FAILED_ROWS" as const;
export const STAMP_SKIPPED_EMPTY_LIST = "EMPTY_LIST_WITH_MIRROR_ITEMS" as const;

export type MirrorStampDecision =
  | { stamp: true }
  | {
      stamp: false;
      reason: typeof STAMP_SKIPPED_FAILED_ROWS | typeof STAMP_SKIPPED_EMPTY_LIST;
      message: string;
    };

export function decideMirrorStamp(args: {
  fetched: number;
  failed: number;
  /** Measured only when `fetched === 0`; null otherwise. */
  liveMirrorItems: number | null;
}): MirrorStampDecision {
  if (args.failed > 0) {
    return {
      stamp: false,
      reason: STAMP_SKIPPED_FAILED_ROWS,
      message:
        `Refresh finished with ${args.failed} item(s) that could not be cached — the IAP ` +
        `list is not complete yet. Try Refresh again.`,
    };
  }
  if (args.fetched === 0) {
    if (args.liveMirrorItems === null) {
      // A caller that skipped the measurement must not get a stamp by default.
      throw new Error("decideMirrorStamp: liveMirrorItems must be measured when Google returned 0 products.");
    }
    if (args.liveMirrorItems > 0) {
      return {
        stamp: false,
        reason: STAMP_SKIPPED_EMPTY_LIST,
        // ⚠ True whether or not the app was refreshed completely before: the
        //   gate only needs SOME complete refresh, and a skipped stamp never
        //   clears an earlier one (review C2.1a). The wizard banner shows which.
        message:
          `Google returned an EMPTY IAP list while the tool holds ${args.liveMirrorItems} item(s) ` +
          `for this app — not counted as a complete refresh (the last-complete-refresh time was ` +
          `not updated). If this app has never been refreshed completely, bulk import stays ` +
          `blocked; otherwise it keeps using the list from its last complete refresh. Check the ` +
          `app on Play Console (and the service account's access), then Refresh again.`,
      };
    }
  }
  return { stamp: true };
}

export function neverSyncedMessage(packageName: string): string {
  return (
    `The IAP list of ${packageName} has no complete refresh from Google on record, so the ` +
    `tool cannot tell which SKUs already exist. Bulk import is blocked: click "Refresh IAP ` +
    `list", then preview again.`
  );
}

/** The sync state (apps.iaps_last_synced_at) was unreadable. */
export function readinessReadFailedMessage(detail: string): string {
  return (
    `Could not read whether this app's IAP list has been refreshed (${detail}). This is NOT ` +
    `"never refreshed" — nothing was imported. Try again; if it persists, check that the ` +
    `database migrations are applied.`
  );
}

/** The IAP mirror itself (the SKU list preview classifies against) was unreadable. */
export function mirrorReadFailedMessage(detail: string): string {
  return (
    `Could not read the cached IAP list (${detail}). This is NOT the same as "no item ` +
    `exists" — nothing was imported. Try again; if it persists, refresh the IAP list.`
  );
}
