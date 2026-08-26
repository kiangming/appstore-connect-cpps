/**
 * [EXPORT-availability-filter] — the mirror's write rules.
 *
 * The rule this file exists for, above all others: AN ERROR IS NOT A VERDICT.
 * A rate-limited or failed Apple read must leave the mirror alone. Writing
 * REMOVED because Apple was busy is the U3 defect with the sign flipped, and
 * unlike U3 it would be persisted with a timestamp on it — outliving and
 * outranking the honest blank it replaced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const update = vi.fn();
const eq = vi.fn();
const inFilter = vi.fn();
const from = vi.fn();

vi.mock("../db", () => ({ iapDb: () => ({ from }) }));

import {
  availabilityMirrorColumns,
  availabilityMirrorColumnsFromAcceptedWrite,
  buildAvailabilityMirrorMap,
  mirrorRecordFromRow,
  mirrorValuesFor,
  recordAvailabilityMirror,
  recordAvailabilityMirrorBatch,
  recordAvailabilityMirrorFromAcceptedWrite,
  type AvailabilityMirrorRow,
} from "./availability-mirror";

beforeEach(() => {
  vi.clearAllMocks();
  eq.mockResolvedValue({ error: null });
  inFilter.mockResolvedValue({ error: null });
  update.mockReturnValue({ eq, in: inFilter });
  from.mockReturnValue({ update });
});

const FULL = { availableInNewTerritories: true, territoryCount: 175, territoryIds: [] };
const SUBSET = { availableInNewTerritories: false, territoryCount: 42, territoryIds: [] };
const EMPTY = { availableInNewTerritories: false, territoryCount: 0, territoryIds: [] };

// ─── Verdict mapping ────────────────────────────────────────────────────────

describe("mirrorValuesFor — the verdict comes from the territory count", () => {
  it("territories present ⇒ AVAILABLE, and the count is kept", () => {
    expect(mirrorValuesFor(FULL)).toEqual({ state: "AVAILABLE", territoryCount: 175 });
  });

  it("a SUBSET is AVAILABLE too — 42 > 0 — and keeps its own count", () => {
    // The two-value verdict cannot express "a deliberate subset"; the count
    // beside it can, which is why both columns exist.
    expect(mirrorValuesFor(SUBSET)).toEqual({ state: "AVAILABLE", territoryCount: 42 });
  });

  it("zero territories ⇒ REMOVED", () => {
    expect(mirrorValuesFor(EMPTY)).toEqual({ state: "REMOVED", territoryCount: 0 });
  });

  it("⚠ `null` — Apple has NO availability resource — is a real answer: REMOVED", () => {
    // Not a failure. `getAvailabilityForIap` returns null on a 404 of the
    // sub-resource for an item that exists, which is the Removed-from-Sale
    // surface.
    expect(mirrorValuesFor(null)).toEqual({ state: "REMOVED", territoryCount: 0 });
  });

  it("⚠ availableInNewTerritories does NOT rescue an empty list", () => {
    // The forward-looking flag promises future markets; it does not make the
    // item sellable today, and the classifier says so.
    expect(
      mirrorValuesFor({ availableInNewTerritories: true, territoryCount: 0, territoryIds: [] }),
    ).toEqual({ state: "REMOVED", territoryCount: 0 });
  });
});

// ─── MUTATION (e), part 1 — the write actually issues, and pairs its columns ─

describe("recordAvailabilityMirror — writes all three columns together", () => {
  it("stamps state, count and timestamp in ONE update, keyed on the internal id", async () => {
    const ok = await recordAvailabilityMirror({
      iapId: "uuid-1",
      observed: FULL,
      observedAt: "2026-08-26T10:00:00Z",
    });
    expect(ok).toBe(true);
    expect(from).toHaveBeenCalledWith("iaps");
    expect(update).toHaveBeenCalledWith({
      availability_state: "AVAILABLE",
      availability_territory_count: 175,
      availability_synced_at: "2026-08-26T10:00:00Z",
    });
    expect(eq).toHaveBeenCalledWith("id", "uuid-1");
  });

  it("⚠ a Supabase error is CHECKED and reported, never swallowed", async () => {
    // KB §9 P2: the migration carries no CHECK precisely because a rejected
    // value would be silent. That trade is only sound if every write here
    // inspects `error`.
    eq.mockResolvedValue({ error: { message: "column does not exist" } });
    const ok = await recordAvailabilityMirror({ iapId: "uuid-1", observed: FULL });
    expect(ok).toBe(false);
  });

  it("⚠ NEVER THROWS — every caller rides this on top of work that succeeded", async () => {
    eq.mockRejectedValue(new Error("connection reset"));
    await expect(
      recordAvailabilityMirror({ iapId: "uuid-1", observed: FULL }),
    ).resolves.toBe(false);
  });
});

describe("⚠ recordAvailabilityMirrorFromAcceptedWrite — the count is the accepted selection", () => {
  it("a removal (empty list) stores REMOVED with a zero count", async () => {
    await recordAvailabilityMirrorFromAcceptedWrite({
      iapId: "uuid-9",
      territoryIds: [],
      availableInNewTerritories: false,
      observedAt: "2026-08-26T10:00:00Z",
    });
    expect(update).toHaveBeenCalledWith({
      availability_state: "REMOVED",
      availability_territory_count: 0,
      availability_synced_at: "2026-08-26T10:00:00Z",
    });
  });

  it("a per-territory selection stores its real size, not a rounded 'all'", async () => {
    await recordAvailabilityMirrorFromAcceptedWrite({
      iapId: "uuid-9",
      territoryIds: ["USA", "VNM", "JPN"],
      availableInNewTerritories: false,
      observedAt: "2026-08-26T10:00:00Z",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        availability_state: "AVAILABLE",
        availability_territory_count: 3,
      }),
    );
  });
});

// ─── MUTATION (g) support — the batch writes only what it is given ──────────

describe("recordAvailabilityMirrorBatch — one timestamp, grouped updates, nothing extra", () => {
  it("groups identical verdicts so a 500-item sweep is a handful of statements", async () => {
    await recordAvailabilityMirrorBatch(
      [
        { iapId: "a", observed: FULL },
        { iapId: "b", observed: FULL },
        { iapId: "c", observed: EMPTY },
      ],
      "2026-08-26T10:00:00Z",
    );
    // Two distinct (state, count) pairs ⇒ two updates, not three.
    expect(update).toHaveBeenCalledTimes(2);
    expect(inFilter).toHaveBeenCalledWith("id", ["a", "b"]);
    expect(inFilter).toHaveBeenCalledWith("id", ["c"]);
  });

  it("⚠ every item in one sweep shares ONE timestamp — 'as of' is an instant", async () => {
    await recordAvailabilityMirrorBatch(
      [
        { iapId: "a", observed: FULL },
        { iapId: "c", observed: EMPTY },
      ],
      "2026-08-26T10:00:00Z",
    );
    for (const call of update.mock.calls) {
      expect(call[0].availability_synced_at).toBe("2026-08-26T10:00:00Z");
    }
  });

  it("⚠ writes NOTHING for an empty list — a sweep that read nothing stamps nothing", async () => {
    expect(await recordAvailabilityMirrorBatch([], "2026-08-26T10:00:00Z")).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("a failed group does not abort the others, and is not counted as written", async () => {
    inFilter
      .mockResolvedValueOnce({ error: { message: "boom" } })
      .mockResolvedValueOnce({ error: null });
    const written = await recordAvailabilityMirrorBatch(
      [
        { iapId: "a", observed: FULL },
        { iapId: "c", observed: EMPTY },
      ],
      "2026-08-26T10:00:00Z",
    );
    expect(update).toHaveBeenCalledTimes(2);
    expect(written).toBe(1);
  });
});

// ─── Reading back ───────────────────────────────────────────────────────────

describe("mirrorRecordFromRow — a half-written row reads as UNKNOWN, not as its half", () => {
  const base: AvailabilityMirrorRow = {
    apple_iap_id: "6001",
    availability_state: "AVAILABLE",
    availability_territory_count: 175,
    availability_synced_at: "2026-08-26T10:00:00Z",
  };

  it("a complete row becomes a record", () => {
    expect(mirrorRecordFromRow(base)).toEqual({
      state: "AVAILABLE",
      territoryCount: 175,
      syncedAt: "2026-08-26T10:00:00Z",
    });
  });

  it("⚠ a verdict with NO timestamp is unknown — it cannot be dated, so it cannot be shown", () => {
    expect(mirrorRecordFromRow({ ...base, availability_synced_at: null })).toBeNull();
  });

  it("⚠ a timestamp with NO verdict is unknown — it claims we asked and learned nothing", () => {
    expect(mirrorRecordFromRow({ ...base, availability_state: null })).toBeNull();
  });

  it("⚠ an UNRECOGNISED verdict is unknown, never guessed at", () => {
    // There is no CHECK constraint on the column (KB §9 P2), so this function
    // is the only guard. A server ahead of this client is the benign case;
    // either way the answer is "we don't know".
    expect(mirrorRecordFromRow({ ...base, availability_state: "PARTIAL" })).toBeNull();
    expect(mirrorRecordFromRow({ ...base, availability_state: "UNKNOWN" })).toBeNull();
  });

  it("a missing count degrades to 0 but keeps the verdict — the count is the softer field", () => {
    expect(
      mirrorRecordFromRow({ ...base, availability_territory_count: null }),
    ).toEqual({ state: "AVAILABLE", territoryCount: 0, syncedAt: base.availability_synced_at });
  });
});

describe("buildAvailabilityMirrorMap — absence is how unknown is expressed", () => {
  it("keys by APPLE id, so one map serves the list and the export picker", () => {
    const map = buildAvailabilityMirrorMap([
      {
        apple_iap_id: "6001",
        availability_state: "AVAILABLE",
        availability_territory_count: 175,
        availability_synced_at: "2026-08-26T10:00:00Z",
      },
    ]);
    expect(map["6001"].state).toBe("AVAILABLE");
  });

  it("⚠ an unsynced row is OMITTED, not stored as a third string value", () => {
    const map = buildAvailabilityMirrorMap([
      {
        apple_iap_id: "6002",
        availability_state: null,
        availability_territory_count: null,
        availability_synced_at: null,
      },
    ]);
    expect(map["6002"]).toBeUndefined();
    expect(Object.keys(map)).toHaveLength(0);
  });

  it("a local draft (no Apple id) has nowhere to be keyed and is skipped", () => {
    const map = buildAvailabilityMirrorMap([
      {
        apple_iap_id: null,
        availability_state: "AVAILABLE",
        availability_territory_count: 175,
        availability_synced_at: "2026-08-26T10:00:00Z",
      },
    ]);
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe("availabilityMirrorColumns — ONE definition, two delivery shapes", () => {
  it("the UPDATE path and the UPSERT path produce identical columns", () => {
    // P1: Bulk Import spreads the columns into its own upsert rather than
    // issuing a second statement. That is only safe while both come from here.
    const viaObserved = availabilityMirrorColumns(
      { availableInNewTerritories: false, territoryCount: 3, territoryIds: [] },
      "2026-08-26T10:00:00Z",
    );
    const viaWrite = availabilityMirrorColumnsFromAcceptedWrite({
      territoryIds: ["USA", "VNM", "JPN"],
      availableInNewTerritories: false,
      observedAt: "2026-08-26T10:00:00Z",
    });
    expect(viaWrite).toEqual(viaObserved);
  });
});
