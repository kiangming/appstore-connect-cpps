/**
 * [EXPORT-availability-filter] — the availability mirror: ONE write path,
 * one read shape, one place where "what Apple said" becomes "what we stored".
 *
 * Census M2 found the tool reading Apple availability constantly and keeping
 * none of it — 2 requests per item, held in a per-cell `useState`, discarded
 * on unmount. These functions are where that answer lands so the export wizard
 * can filter Available/Removed/Unknown at zero Apple cost and date what it
 * shows.
 *
 * ⚠ THE SINGLE WRITE PATH. Three callers write this mirror and they all come
 * through `recordAvailabilityMirror` / `recordAvailabilityMirrorBatch`:
 *
 *     C2  GET /api/iap-management/iaps/{id}/availability   (read-through)
 *     C3  orchestrators/bulk-availability.ts               (write-through)
 *     C4  POST .../iaps/sync-states                        (Refresh from Apple)
 *
 * That is the P1 twin-path rule applied before the twins exist. Three copies
 * of "map the verdict, stamp the time, check the error" is three chances for
 * one of them to skip the error check or invent a verdict from a failure — and
 * `availability-mirror.write-path.test.ts` fails if any of them starts calling
 * `.from("iaps").update({ availability_… })` directly.
 *
 * ⚠ AN ERROR IS NOT A VERDICT — the rule this module exists to enforce.
 * `recordAvailabilityMirror` takes `AvailabilityForIap | null`, and BOTH of
 * those are real answers from Apple: an object is "here are the territories",
 * `null` is "Apple has no availability resource for this item" (a 404 on the
 * sub-resource of an item that exists — see `getAvailabilityForIap`). There is
 * deliberately NO way to hand this function a rate-limit, a transport failure
 * or an unknown. Callers must not translate one into `null`: that would write
 * REMOVED for an item nobody successfully asked about, which is the U3 defect
 * with the sign flipped — and worse than U3, because it would be persisted.
 *
 * ⚠ CLASSIFICATION IS NOT RE-DERIVED HERE. It calls `classifyAvailability`,
 * the same pure function the list cell and the bulk modal use. If the rule for
 * "zero territories but availableInNewTerritories: true" ever changes, it
 * changes in one file and every surface moves together.
 */

import { iapDb } from "../db";
import { classifyAvailability } from "../apple/availability-classify";
import type { AvailabilityForIap } from "../apple/availabilities";
import type {
  AvailabilityMirrorByAppleId,
  AvailabilityMirrorRecord,
  AvailabilityMirrorState,
} from "../apple/availability-as-of";

/**
 * ⚠ THE TYPES LIVE IN `apple/availability-as-of.ts`, NOT HERE, and are
 * re-exported so server callers can keep importing them from the query module.
 *
 * The reason is the same one that split `availability-classify.ts` out: this
 * module imports `iapDb`, which reaches Node `fs` transitively, and the two
 * surfaces that consume the mirror — the IAP list column and the export wizard
 * — are client components. A type is erased at compile time, but a client
 * importing `oldestSyncedAt` from here would drag the Supabase client into the
 * browser bundle and webpack would refuse it.
 *
 * Keyed by APPLE id, not the internal UUID, because both consumers key on it:
 * the list rows come from Apple's list, and the export picker deliberately
 * never needs an internal id (design §2.G). One map serves both.
 */
export type {
  AvailabilityMirrorState,
  AvailabilityMirrorRecord,
  AvailabilityMirrorByAppleId,
} from "../apple/availability-as-of";
export { oldestSyncedAt, newestSyncedAt } from "../apple/availability-as-of";

/**
 * The shape the DB hands back. Exported so the query that already selects
 * from `iaps` (`listSyncedAppleIapDetail`) can reuse the row→record rule
 * instead of re-implementing it beside its own SELECT.
 */
export interface AvailabilityMirrorRow {
  apple_iap_id: string | null;
  availability_state: string | null;
  availability_territory_count: number | null;
  availability_synced_at: string | null;
}

/**
 * Row → record, PURE, and strict about what it accepts.
 *
 * Returns null — meaning "this row has no verdict, treat as unknown" — when:
 *   • the two paired columns disagree (verdict without a timestamp, or a
 *     timestamp without a verdict). They are written together and read
 *     together; a half-written row is a bug, and the honest reading of a bug
 *     is "we don't know", not the half we happen to have.
 *   • the stored string is not one of the two known verdicts. There is no
 *     CHECK constraint on the column (deliberately — KB §9 P2, see the
 *     migration), so this is the only place that guard exists. A server
 *     ahead of this client is the benign version of it; either way, an
 *     unrecognised verdict must not be guessed at.
 */
export function mirrorRecordFromRow(
  row: AvailabilityMirrorRow,
): AvailabilityMirrorRecord | null {
  const { availability_state: state, availability_synced_at: syncedAt } = row;
  if (!state || !syncedAt) return null;
  if (state !== "AVAILABLE" && state !== "REMOVED") return null;
  return {
    state,
    // A verdict with no count is still a verdict; 0 is the safe reading for
    // REMOVED and the degenerate-but-honest one for a legacy AVAILABLE row.
    territoryCount: row.availability_territory_count ?? 0,
    syncedAt,
  };
}

/** Build the by-Apple-id map from raw rows. Pure; rows lacking a verdict are
 *  simply absent (see the type's note — absence is the unknown). */
export function buildAvailabilityMirrorMap(
  rows: readonly AvailabilityMirrorRow[],
): AvailabilityMirrorByAppleId {
  const out: AvailabilityMirrorByAppleId = {};
  for (const row of rows) {
    if (!row.apple_iap_id) continue;
    const record = mirrorRecordFromRow(row);
    if (record) out[row.apple_iap_id] = record;
  }
  return out;
}

/**
 * Apple's answer → the two stored values. PURE, and the only mapping.
 *
 * ⚠ Returns null for the `"unknown"` bucket rather than picking a side. Today
 * `classifyAvailability(state, false)` cannot return "unknown" — that bucket
 * needs `hasError`, and this function is never handed an error. The branch is
 * here anyway: if the classifier ever grows a third answer from the data
 * itself, this must decline to store it rather than silently fold it into
 * REMOVED, and a test pins that.
 */
export function mirrorValuesFor(
  observed: AvailabilityForIap | null,
): { state: AvailabilityMirrorState; territoryCount: number } | null {
  const bucket = classifyAvailability(observed, false);
  if (bucket === "available") {
    return { state: "AVAILABLE", territoryCount: observed?.territoryCount ?? 0 };
  }
  if (bucket === "removed") {
    return { state: "REMOVED", territoryCount: observed?.territoryCount ?? 0 };
  }
  return null;
}

/** The three columns, as a spreadable payload. */
export interface AvailabilityMirrorColumns {
  availability_state: AvailabilityMirrorState;
  availability_territory_count: number;
  availability_synced_at: string;
}

/**
 * Apple's answer → the exact column payload. PURE, and THE ONLY DEFINITION.
 *
 * ⚠ WHY THIS IS SEPARATE FROM THE WRITE. Most callers want
 * `recordAvailabilityMirror` (an UPDATE keyed on the internal id). Bulk Import
 * cannot use it: at the moment it learns the availability outcome it is
 * building an UPSERT keyed on `(app_id, product_id)` for a row that may not
 * exist yet, and it has no internal id to update. Making it issue a second
 * statement would be a write it does not need; making it hand-roll the columns
 * would be the twin-path defect (P1) — a second place deciding what
 * `availability_state` means, free to drift from the classifier.
 *
 * So the column payload has one definition and two ways to deliver it. Callers
 * still never classify; they only choose UPDATE or UPSERT.
 *
 * Returns null when there is no verdict to store — see `mirrorValuesFor`.
 */
export function availabilityMirrorColumns(
  observed: AvailabilityForIap | null,
  observedAt?: string,
): AvailabilityMirrorColumns | null {
  const values = mirrorValuesFor(observed);
  if (!values) return null;
  return {
    availability_state: values.state,
    availability_territory_count: values.territoryCount,
    availability_synced_at: observedAt ?? new Date().toISOString(),
  };
}

/**
 * The same, from a selection Apple ACCEPTED — see
 * `recordAvailabilityMirrorFromAcceptedWrite` for why an accepted replace is a
 * sound source for the count.
 */
export function availabilityMirrorColumnsFromAcceptedWrite(args: {
  territoryIds: readonly string[];
  availableInNewTerritories: boolean;
  observedAt?: string;
}): AvailabilityMirrorColumns | null {
  return availabilityMirrorColumns(
    {
      availableInNewTerritories: args.availableInNewTerritories,
      territoryCount: args.territoryIds.length,
      territoryIds: [...args.territoryIds],
    },
    args.observedAt,
  );
}

export interface RecordAvailabilityMirrorArgs {
  /** Internal `iap_mgmt.iaps.id`. */
  iapId: string;
  /**
   * What Apple actually said. An object or `null` — BOTH are real answers.
   * See the module header: never pass `null` to stand in for a failure.
   */
  observed: AvailabilityForIap | null;
  /** ISO timestamp of the observation. Defaults to now. */
  observedAt?: string;
}

/**
 * Store one item's verdict. Returns whether the write landed.
 *
 * ⚠ NEVER THROWS, AND ALWAYS CHECKS `error`. Every caller rides this on top of
 * work that already succeeded — a read that must still return its answer, an
 * Apple write that already happened. A failed cache write must not undo any of
 * that, so it is logged and reported through the return value. That is also
 * why the migration carries no CHECK: per KB §9 P2 a constrained value would
 * be rejected silently, and the one thing worse than a mirror that fails is a
 * mirror that fails quietly.
 */
export async function recordAvailabilityMirror(
  args: RecordAvailabilityMirrorArgs,
): Promise<boolean> {
  const columns = availabilityMirrorColumns(args.observed, args.observedAt);
  if (!columns) return false;
  try {
    const { error } = await iapDb()
      .from("iaps")
      .update(columns)
      .eq("id", args.iapId);
    if (error) {
      console.error(
        `[availability-mirror] update failed iap=${args.iapId}: ${error.message}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[availability-mirror] update threw iap=${args.iapId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * C3 — store the verdict implied by an availability write Apple ACCEPTED.
 *
 * Census M3 found the write side deaf: `bulk-availability` POSTed to Apple,
 * wrote one `actions_log` row and nothing else, so after a Remove from Sales
 * the list column kept saying "Available" until a hard reload. This is the fix,
 * and it is the reason the mirror can be trusted right after a mutation rather
 * than only after the next read.
 *
 * ⚠ THE TERRITORY COUNT COMES FROM WHAT WE SENT, NOT FROM A RE-READ — say so
 * rather than let a reader assume otherwise. Apple's POST response carries the
 * availability resource but its attributes hold only
 * `availableInNewTerritories`; the territory list is not echoed back. So the
 * count here is the length of the accepted selection. That is sound because
 * `setAvailabilityTerritories` is a REPLACE (Apple exposes no PATCH and no
 * DELETE on this resource — KB §4.12), so a 2xx means the resource now holds
 * exactly this list. The alternative — a confirming re-read — would spend 1-2
 * more Apple requests per item on a path that just spent one, to re-learn what
 * Apple already confirmed.
 *
 * ⚠ CALL THIS ONLY AFTER A 2xx. An accepted write is an answer; an attempted
 * one is not. A row that threw, retried out, or was never sent must reach
 * neither this function nor `recordAvailabilityMirror`.
 */
export async function recordAvailabilityMirrorFromAcceptedWrite(args: {
  iapId: string;
  territoryIds: readonly string[];
  availableInNewTerritories: boolean;
  observedAt?: string;
}): Promise<boolean> {
  return recordAvailabilityMirror({
    iapId: args.iapId,
    observed: {
      availableInNewTerritories: args.availableInNewTerritories,
      territoryCount: args.territoryIds.length,
      territoryIds: [...args.territoryIds],
    },
    observedAt: args.observedAt,
  });
}

export interface AvailabilityObservation {
  iapId: string;
  observed: AvailabilityForIap | null;
}

/**
 * Store many verdicts from one sweep (C4's Refresh).
 *
 * ⚠ ONLY THE ITEMS PASSED IN ARE TOUCHED, and that is the stop-and-preserve
 * contract expressed as code. A Refresh that stops on rate-limit exhaustion
 * passes the items it actually read; everything it never reached keeps its old
 * `availability_synced_at`, including NULL. There is no "mark the rest" branch
 * and there must never be one — stamping now on an item nobody asked Apple
 * about makes the as-of label lie about exactly the data it exists to date.
 *
 * ⚠ ONE TIMESTAMP FOR THE SWEEP. Every item read in one Refresh shares the
 * `observedAt` the caller passes, so "as of" means the same instant across the
 * batch instead of drifting by however long the fan-out took.
 *
 * Grouped by (verdict, count) so a 500-item app costs 2-3 UPDATEs rather than
 * 500 round-trips — the real distribution is overwhelmingly (AVAILABLE, 175)
 * and (REMOVED, 0). Returns how many rows were successfully written.
 */
export async function recordAvailabilityMirrorBatch(
  observations: readonly AvailabilityObservation[],
  observedAt?: string,
): Promise<number> {
  if (observations.length === 0) return 0;
  const syncedAt = observedAt ?? new Date().toISOString();

  // key = `${state}|${territoryCount}` → the ids sharing those exact values.
  const buckets = new Map<string, { state: AvailabilityMirrorState; territoryCount: number; ids: string[] }>();
  for (const obs of observations) {
    const values = mirrorValuesFor(obs.observed);
    if (!values) continue;
    const key = `${values.state}|${values.territoryCount}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(obs.iapId);
    else buckets.set(key, { ...values, ids: [obs.iapId] });
  }

  let written = 0;
  const db = iapDb();
  for (const bucket of buckets.values()) {
    try {
      const { error } = await db
        .from("iaps")
        .update({
          availability_state: bucket.state,
          availability_territory_count: bucket.territoryCount,
          availability_synced_at: syncedAt,
        } satisfies AvailabilityMirrorColumns)
        .in("id", bucket.ids);
      if (error) {
        console.error(
          `[availability-mirror] batch update failed (${bucket.state}/${bucket.territoryCount}, ${bucket.ids.length} rows): ${error.message}`,
        );
        continue;
      }
      written += bucket.ids.length;
    } catch (err) {
      console.error(
        `[availability-mirror] batch update threw (${bucket.state}/${bucket.territoryCount}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return written;
}

/**
 * Read the mirror for one app, keyed by Apple id.
 *
 * Used by surfaces that don't already select from `iaps`. The IAP list page
 * gets the same map for free out of `listSyncedAppleIapDetail`, which selects
 * these columns alongside the id map in its existing round-trip.
 */
export async function getAvailabilityMirrorForApp(
  internalAppId: string,
): Promise<AvailabilityMirrorByAppleId> {
  const res = await iapDb()
    .from("iaps")
    .select(
      "apple_iap_id, availability_state, availability_territory_count, availability_synced_at",
    )
    .eq("app_id", internalAppId)
    .not("apple_iap_id", "is", null);
  if (res.error || !res.data) return {};
  return buildAvailabilityMirrorMap(res.data as AvailabilityMirrorRow[]);
}

