/**
 * [EXPORT-availability-filter] — the two rules that can be wrong invisibly.
 *
 * MUTATION (a): unknown must never read as available.
 * MUTATION (d): the as-of label must date a screen by its OLDEST record.
 *
 * Both are one-word changes that leave every other test in the suite green and
 * produce a UI that looks entirely normal — which is exactly why they get their
 * own file rather than a corner of someone else's.
 */

import { describe, it, expect } from "vitest";
import {
  asOfLabel,
  asOfSummary,
  formatRelativeAge,
  matchesAvailabilityFilter,
  mirrorBucket,
  newestSyncedAt,
  oldestSyncedAt,
  type AvailabilityMirrorByAppleId,
  type AvailabilityMirrorRecord,
} from "./availability-as-of";

const AVAILABLE = (syncedAt: string, n = 175): AvailabilityMirrorRecord => ({
  state: "AVAILABLE",
  territoryCount: n,
  syncedAt,
});
const REMOVED = (syncedAt: string): AvailabilityMirrorRecord => ({
  state: "REMOVED",
  territoryCount: 0,
  syncedAt,
});

// ─── MUTATION (a) — unknown is never available ──────────────────────────────

describe("⚠ MUTATION (a) — an item with no mirror record is UNKNOWN, never available", () => {
  it("mirrorBucket(undefined) is UNKNOWN", () => {
    // The U3 defect restated: "no record yet ⇒ available" is the same mistake
    // as "has an availability relationship ⇒ available". Both mark removed
    // items as sellable.
    expect(mirrorBucket(undefined)).toBe("UNKNOWN");
  });

  it("an unsynced item does NOT pass the Available filter", () => {
    expect(matchesAvailabilityFilter(undefined, "AVAILABLE")).toBe(false);
  });

  it("an unsynced item does NOT pass the Removed filter either", () => {
    // Symmetry matters: folding unknown into REMOVED would be a different
    // wrong answer, not a safer one — a Manager filtering Removed to re-enable
    // items would act on items nobody has checked.
    expect(matchesAvailabilityFilter(undefined, "REMOVED")).toBe(false);
  });

  it("an unsynced item DOES pass the Unknown filter — it is a real bucket", () => {
    expect(matchesAvailabilityFilter(undefined, "UNKNOWN")).toBe(true);
  });

  it("ALL includes everything, including the unsynced", () => {
    expect(matchesAvailabilityFilter(undefined, "ALL")).toBe(true);
    expect(matchesAvailabilityFilter(AVAILABLE("2026-08-26T00:00:00Z"), "ALL")).toBe(true);
  });

  it("a synced item filters by its stored verdict, both ways", () => {
    const a = AVAILABLE("2026-08-26T00:00:00Z");
    const r = REMOVED("2026-08-26T00:00:00Z");
    expect(matchesAvailabilityFilter(a, "AVAILABLE")).toBe(true);
    expect(matchesAvailabilityFilter(a, "REMOVED")).toBe(false);
    expect(matchesAvailabilityFilter(r, "REMOVED")).toBe(true);
    expect(matchesAvailabilityFilter(r, "AVAILABLE")).toBe(false);
    expect(matchesAvailabilityFilter(a, "UNKNOWN")).toBe(false);
  });

  it("⚠ a REMOVED item with a stale timestamp is still REMOVED — age is not a verdict", () => {
    // Guards a plausible-sounding 'fix': "the record is old, treat it as
    // unknown". Age belongs in the label, not in the bucket; silently
    // reclassifying old records would empty the Removed filter over time.
    expect(mirrorBucket(REMOVED("2020-01-01T00:00:00Z"))).toBe("REMOVED");
  });
});

// ─── MUTATION (d) — oldest, never newest ────────────────────────────────────

describe("⚠ MUTATION (d) — the as-of label dates a screen by its OLDEST record", () => {
  const OLD = "2026-08-20T00:00:00Z";
  const NEW = "2026-08-26T12:00:00Z";

  it("oldestSyncedAt picks the minimum, not the maximum", () => {
    expect(oldestSyncedAt([AVAILABLE(NEW), REMOVED(OLD), AVAILABLE(NEW)])).toBe(OLD);
  });

  it("newestSyncedAt picks the maximum — the companion, so the two cannot be swapped silently", () => {
    expect(newestSyncedAt([AVAILABLE(NEW), REMOVED(OLD)])).toBe(NEW);
  });

  it("the summary reports the oldest as `oldest` and the newest as `newest`", () => {
    const mirror: AvailabilityMirrorByAppleId = {
      a: AVAILABLE(NEW),
      b: REMOVED(OLD),
    };
    const summary = asOfSummary(["a", "b"], mirror);
    expect(summary.oldest).toBe(OLD);
    expect(summary.newest).toBe(NEW);
  });

  it("⚠ the rendered label shows the OLD age, not the NEW one", () => {
    // The mutation this exists for: swapping min→max here makes a screen
    // holding week-old data read "as of just now". Nothing else in the app
    // would notice.
    const now = Date.parse("2026-08-26T12:00:00Z");
    const mirror: AvailabilityMirrorByAppleId = {
      a: AVAILABLE(NEW),
      b: REMOVED(OLD),
    };
    const label = asOfLabel(asOfSummary(["a", "b"], mirror), now);
    expect(label).toContain("6 days ago");
    expect(label).not.toMatch(/as of just now/);
  });

  it("a wide spread is NAMED, not hidden behind one date", () => {
    const now = Date.parse("2026-08-26T12:00:00Z");
    const mirror: AvailabilityMirrorByAppleId = {
      a: AVAILABLE(NEW),
      b: REMOVED(OLD),
    };
    const label = asOfLabel(asOfSummary(["a", "b"], mirror), now);
    expect(label).toContain("oldest of 2");
    expect(label).toContain("newest just now");
  });

  it("a tight spread does NOT add the noise", () => {
    const now = Date.parse("2026-08-26T12:00:00Z");
    const mirror: AvailabilityMirrorByAppleId = {
      a: AVAILABLE("2026-08-26T11:00:00Z"),
      b: REMOVED("2026-08-26T10:30:00Z"),
    };
    const label = asOfLabel(asOfSummary(["a", "b"], mirror), now);
    expect(label).not.toContain("oldest of");
  });
});

// ─── The Unknown count — the half a date alone cannot carry ─────────────────

describe("the label counts what it does NOT know", () => {
  it("names how many items have never been synced", () => {
    const now = Date.parse("2026-08-26T12:00:00Z");
    const mirror: AvailabilityMirrorByAppleId = {
      a: AVAILABLE("2026-08-26T11:00:00Z"),
    };
    const label = asOfLabel(asOfSummary(["a", "b", "c"], mirror), now);
    expect(label).toContain("2 never synced (Unknown)");
  });

  it("⚠ with NOTHING synced it refuses to claim a date at all", () => {
    // The tempting fallback is "as of now", which would be a claim about Apple
    // that was never made.
    const label = asOfLabel(asOfSummary(["a", "b"], {}), Date.parse("2026-08-26T12:00:00Z"));
    expect(label).toBe("Availability never synced · 2 unknown");
    expect(label).not.toContain("as of");
  });

  it("an empty screen says so rather than dividing by nothing", () => {
    expect(asOfLabel(asOfSummary([], {}))).toBe("No items");
  });

  it("knownCount counts records, unknownCount counts the gaps — they sum to the screen", () => {
    const mirror: AvailabilityMirrorByAppleId = { a: AVAILABLE("2026-08-26T11:00:00Z") };
    const summary = asOfSummary(["a", "b", "c"], mirror);
    expect(summary.knownCount).toBe(1);
    expect(summary.unknownCount).toBe(2);
    expect(summary.knownCount + summary.unknownCount).toBe(3);
  });
});

describe("formatRelativeAge rounds DOWN — understating freshness, never overstating it", () => {
  const base = Date.parse("2026-08-26T12:00:00Z");
  it.each([
    ["2026-08-26T11:59:30Z", "just now"],
    ["2026-08-26T11:58:00Z", "2 minutes ago"],
    ["2026-08-26T11:00:00Z", "1 hour ago"],
    ["2026-08-26T08:01:00Z", "3 hours ago"],
    ["2026-08-25T12:00:00Z", "1 day ago"],
  ])("%s → %s", (iso, expected) => {
    expect(formatRelativeAge(iso, base)).toBe(expected);
  });

  it("⚠ 3h59m reads as 3 hours, not 4 — the round that cannot flatter", () => {
    expect(formatRelativeAge("2026-08-26T08:01:00Z", base)).toBe("3 hours ago");
  });

  it("an unparseable timestamp says unknown rather than inventing an age", () => {
    expect(formatRelativeAge("not-a-date", base)).toBe("unknown");
  });
});
