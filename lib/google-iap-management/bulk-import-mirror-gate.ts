/**
 * D0 + D2 [arc-google-missing-purchase-options] — ONE gate for every bulk-import
 * route that trusts the IAP mirror (preview decides NEW/EXISTING from it;
 * execute writes the plan that was built from it).
 *
 * Incident (com.vnggames.ballisticherotwid, 2026-10-16): the mirror had never
 * been filled, preview reported 28/28 NEW, execute sent 28 CREATEs onto 28
 * products that already existed on Google. Three states had collapsed into
 * one ("mirror empty ⇒ no item exists"):
 *
 *   never   — the IAP list was never refreshed completely   → REFUSE (D0)
 *   error   — the sync state / mirror could not be read      → REFUSE (D2)
 *   synced  — a complete refresh happened at `syncedAt`      → proceed
 *
 * ⚠ "Could not read" must NEVER become "empty" or "never". Both refusals are
 *   distinct, named codes so the UI can say which one happened.
 */
import { getIapsMirrorSyncedAt } from "./repository/apps";

export const IAPS_NEVER_SYNCED = "IAPS_NEVER_SYNCED" as const;
export const MIRROR_READ_FAILED = "MIRROR_READ_FAILED" as const;

export type MirrorGate =
  | { kind: "synced"; syncedAt: string }
  | { kind: "never" }
  | { kind: "error"; message: string };

export async function readMirrorGate(appId: string): Promise<MirrorGate> {
  try {
    const syncedAt = await getIapsMirrorSyncedAt(appId);
    return syncedAt ? { kind: "synced", syncedAt } : { kind: "never" };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function neverSyncedMessage(packageName: string): string {
  return (
    `The IAP list of ${packageName} has never been refreshed from Google, so the tool ` +
    `cannot tell which SKUs already exist. Bulk import is blocked: click "Refresh IAP list", ` +
    `then preview again.`
  );
}

export function mirrorReadFailedMessage(detail: string): string {
  return (
    `Could not read the cached IAP list (${detail}). This is NOT the same as "no item ` +
    `exists" — nothing was imported. Try again; if it persists, refresh the IAP list.`
  );
}
