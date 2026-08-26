/**
 * The availability mirror's PURE half — types, bucketing, and the "as of last
 * sync" label.
 *
 * ⚠ WHY THIS IS A SEPARATE MODULE FROM `queries/availability-mirror.ts`.
 * Same reason `availability-classify.ts` exists: that module imports `iapDb`,
 * which reaches Node's `fs` transitively, and webpack rejects it in a client
 * bundle. The list column and the export wizard are both client components and
 * both need these helpers, so the helpers live where a client can import them.
 * The query module imports its types from HERE rather than declaring its own,
 * so there is still exactly one definition of each.
 *
 * ⚠ AND WHY THE LABEL IS A FUNCTION RATHER THAN JSX. `asOfSummary` is the one
 * piece of this feature that can be wrong in a way nobody notices: a label
 * reading "as of 5 minutes ago" over data that is mostly a week old looks
 * completely normal. Making it a pure function means the rule — oldest, never
 * newest — is asserted by a test instead of living inside a component's
 * render.
 */

/** Stored verdict. `"unknown"` is deliberately NOT a member — see below. */
export type AvailabilityMirrorState = "AVAILABLE" | "REMOVED";

export interface AvailabilityMirrorRecord {
  state: AvailabilityMirrorState;
  territoryCount: number;
  /** ISO-8601. When Apple was last successfully asked about this item. */
  syncedAt: string;
}

/**
 * Apple IAP id → cached verdict.
 *
 * ⚠ ABSENT MEANS UNKNOWN, AND UNKNOWN IS A REAL ANSWER. Never `?? "REMOVED"`,
 * and above all never `?? "AVAILABLE"` — that is the U3 defect, which marked
 * every removed item Available by reading the presence of a relationship as a
 * verdict. Absence here carries the same trap and the same rule.
 */
export type AvailabilityMirrorByAppleId = Record<
  string,
  AvailabilityMirrorRecord
>;

/** The three buckets every availability surface filters on. */
export type AvailabilityFilterValue = "ALL" | "AVAILABLE" | "REMOVED" | "UNKNOWN";

/**
 * Which bucket an item falls in, given what the mirror knows about it.
 *
 * ⚠ The `undefined` case returns "UNKNOWN" and there is no other branch that
 * can. A test pins it, because "just default it to available so the list looks
 * full" is a one-word change that would pass every other test in the suite.
 */
export function mirrorBucket(
  record: AvailabilityMirrorRecord | undefined,
): Exclude<AvailabilityFilterValue, "ALL"> {
  if (!record) return "UNKNOWN";
  return record.state;
}

/** Does an item pass the chosen availability filter? */
export function matchesAvailabilityFilter(
  record: AvailabilityMirrorRecord | undefined,
  filter: AvailabilityFilterValue,
): boolean {
  if (filter === "ALL") return true;
  return mirrorBucket(record) === filter;
}

/**
 * The OLDEST sync among the records given.
 *
 * ⚠ MIN, NEVER MAX. The label answers "how old is what I am looking at", and
 * the only honest answer for a mixed set is its oldest member. `max()` would
 * date a screen by its freshest row and quietly misrepresent every item synced
 * before it — the precise failure this label exists to prevent.
 */
export function oldestSyncedAt(
  records: readonly AvailabilityMirrorRecord[],
): string | null {
  let oldest: string | null = null;
  for (const record of records) {
    if (oldest === null || record.syncedAt < oldest) oldest = record.syncedAt;
  }
  return oldest;
}

/** The newest — used only to say how wide a mixed screen's spread is. */
export function newestSyncedAt(
  records: readonly AvailabilityMirrorRecord[],
): string | null {
  let newest: string | null = null;
  for (const record of records) {
    if (newest === null || record.syncedAt > newest) newest = record.syncedAt;
  }
  return newest;
}

/** Beyond this spread the screen is mixing meaningfully different vintages and
 *  says so rather than presenting one date as if it covered everything. */
export const AS_OF_SPREAD_WARN_MS = 24 * 60 * 60 * 1000;

export interface AsOfSummary {
  /** ISO of the oldest sync on screen; null when nothing has ever synced. */
  oldest: string | null;
  /** ISO of the newest sync on screen; null when nothing has ever synced. */
  newest: string | null;
  /** How many items on screen have never been synced at all. */
  unknownCount: number;
  /** How many items on screen the mirror knows about. */
  knownCount: number;
  /** True when oldest and newest are more than a day apart. */
  spreadWide: boolean;
}

/**
 * Summarise a screen's availability vintage.
 *
 * Takes the Apple ids currently on screen plus the mirror, rather than a
 * pre-filtered record list, because `unknownCount` — the number the label is
 * incomplete without — is only knowable from the ids that have NO record.
 */
export function asOfSummary(
  appleIapIds: readonly string[],
  mirror: AvailabilityMirrorByAppleId,
): AsOfSummary {
  const records: AvailabilityMirrorRecord[] = [];
  let unknownCount = 0;
  for (const id of appleIapIds) {
    const record = mirror[id];
    if (record) records.push(record);
    else unknownCount += 1;
  }
  const oldest = oldestSyncedAt(records);
  const newest = newestSyncedAt(records);
  const spreadWide =
    oldest !== null &&
    newest !== null &&
    Date.parse(newest) - Date.parse(oldest) > AS_OF_SPREAD_WARN_MS;
  return {
    oldest,
    newest,
    unknownCount,
    knownCount: records.length,
    spreadWide,
  };
}

/**
 * Relative age, in the plainest words that stay true.
 *
 * ⚠ Rounds DOWN. "3 hours ago" for something 3h59m old understates the age by
 * under an hour; "4 hours ago" for something 3h01m old overstates freshness,
 * which is the direction that misleads.
 */
export function formatRelativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The sentence the two surfaces render. ONE definition, so the list and the
 * wizard cannot drift into telling the Manager different things about the same
 * data — which is the divergence this whole feature was censused over.
 *
 * ⚠ Never claims a date it does not have. With nothing synced there is no "as
 * of" at all, and the string says so rather than falling back to "now".
 */
export function asOfLabel(summary: AsOfSummary, now: number = Date.now()): string {
  const { oldest, newest, unknownCount, knownCount, spreadWide } = summary;
  if (knownCount === 0) {
    return unknownCount === 0
      ? "No items"
      : `Availability never synced · ${unknownCount} unknown`;
  }
  const parts = [`Availability as of ${formatRelativeAge(oldest!, now)}`];
  if (spreadWide && newest) {
    // ⚠ Names the spread instead of hiding it behind one date. A screen mixing
    //   a week-old item with a minute-old one is not "as of a minute ago", and
    //   pretending otherwise is how a stale row gets acted on.
    parts.push(`oldest of ${knownCount}; newest ${formatRelativeAge(newest, now)}`);
  }
  if (unknownCount > 0) {
    parts.push(`${unknownCount} never synced (Unknown)`);
  }
  return parts.join(" · ");
}
