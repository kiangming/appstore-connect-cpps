/**
 * Arc `[LOC-V2-model]` V0-snapshot — these tests pin the DISTINCTIONS the
 * snapshot exists to make.
 *
 * ⚠ THE FAILURE BEING GUARDED IS NOT "the line is wrong". It is "the line is
 * confidently wrong in the reassuring direction" — a version reported as
 * owning FEWER locales than it does. Every such under-report reads as
 * **"the new version did not inherit the other locales"**, which is the
 * design-changing answer. Three separate mechanisms can produce it and each has
 * its own test below:
 *
 *   · stage 2 failed        → locales unknown, NOT empty
 *   · Apple paged the list  → `links.next`, the page read is short
 *   · the V2 pointer lied   → KB §4.1 LANDMARK, 10-ID truncation
 */
import { describe, it, expect } from "vitest";
import {
  summarizeVersionSnapshot,
  describeVersionSnapshotForLog,
} from "./localization-v2-snapshot";

const version = (id: string, state: string, ptrIds: string[] | null) => ({
  id,
  attributes: { state },
  ...(ptrIds === null
    ? { relationships: { localizations: {} } }
    : {
        relationships: {
          localizations: {
            data: ptrIds.map((i) => ({ type: "inAppPurchaseLocalizations", id: i })),
          },
        },
      }),
});

const loc = (id: string, locale: string) => ({
  type: "inAppPurchaseLocalizations",
  id,
  attributes: { locale, name: "n", description: "d" },
});

describe("summarizeVersionSnapshot — the authoritative read", () => {
  it("locales come from the V1 sub-resource, keyed by version", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1", "l2"])],
      [{ versionId: "v1", rows: [loc("l1", "vi"), loc("l2", "en-US")] }],
    );
    expect(s.versions[0].locales).toEqual(["vi", "en-US"]);
    expect(s.incomplete).toBe(false);
  });

  it("⭐ THE INHERITANCE QUESTION: a draft owning fewer locales than the approved version", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [
        version("v1", "APPROVED", ["l1", "l2"]),
        version("v2", "PREPARE_FOR_SUBMISSION", ["l3"]),
      ],
      [
        { versionId: "v1", rows: [loc("l1", "vi"), loc("l2", "en-US")] },
        { versionId: "v2", rows: [loc("l3", "vi")] },
      ],
    );
    expect(describeVersionSnapshotForLog(s)).toContain(
      "locsByVersion=[v1:{vi,en-US}, v2:{vi}]",
    );
    // ⚠ And with nothing wrong, `flags` must be EMPTY — otherwise the Manager
    // cannot tell a clean answer from a caveated one.
    expect(describeVersionSnapshotForLog(s)).toContain("flags=[]");
    expect(s.incomplete).toBe(false);
  });

  // ─── under-report mechanism 1: stage 2 failed ────────────────────────────

  it("⚠⚠ a failed fetch is UNKNOWN, never an empty locale list", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1"])],
      [{ versionId: "v1", rows: [], error: "429 rate limited" }],
    );
    expect(s.versions[0].fetchError).toBe("429 rate limited");
    expect(s.incomplete).toBe(true);
    const line = describeVersionSnapshotForLog(s);
    expect(line).toContain("v1:UNKNOWN");
    expect(line).toContain("FETCH_FAILED(v1)");
    // The reassuring rendering must NOT be reachable for a failed read.
    expect(line).not.toContain("v1:{}");
  });

  it("⚠ a version with no stage-2 entry at all is also UNKNOWN", () => {
    const s = summarizeVersionSnapshot("com.a", [version("v1", "APPROVED", [])], []);
    expect(s.versions[0].fetchError).toBe("not fetched");
    expect(s.incomplete).toBe(true);
  });

  it("a version that genuinely owns NO localization renders as empty, and is NOT incomplete", () => {
    // The other side of the same coin: `{}` must stay available for the real
    // fact, or the distinction above is worthless.
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "PREPARE_FOR_SUBMISSION", [])],
      [{ versionId: "v1", rows: [] }],
    );
    expect(s.incomplete).toBe(false);
    expect(describeVersionSnapshotForLog(s)).toContain("v1:{}");
    expect(describeVersionSnapshotForLog(s)).toContain("flags=[]");
  });

  // ─── under-report mechanism 2: Apple paged the list ──────────────────────

  it("⚠⚠ `links.next` ⇒ MORE_PAGES flag and incomplete — never a silent cut", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1"])],
      [{ versionId: "v1", rows: [loc("l1", "vi")], hasMorePages: true }],
    );
    expect(s.versions[0].truncatedPages).toBe(true);
    expect(s.incomplete).toBe(true);
    expect(describeVersionSnapshotForLog(s)).toContain("MORE_PAGES(v1)");
  });

  // ─── under-report mechanism 3: the V2 pointer lied (KB §4.1) ─────────────

  it("⭐ PTR_SHORT measures the §4.1 landmark on `localizations` — pointer shorter than reality", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1"])], // pointer says 1…
      [{ versionId: "v1", rows: [loc("l1", "vi"), loc("l2", "en-US")] }], // …reality is 2
    );
    expect(s.versions[0].pointerDisagrees).toBe(true);
    expect(describeVersionSnapshotForLog(s)).toContain("PTR_SHORT(v1 1<2)");
    // ⚠ The authoritative list is still the one reported.
    expect(s.versions[0].locales).toEqual(["vi", "en-US"]);
  });

  it("⚠ a pointer that AGREES raises nothing — the landmark must not be assumed", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1", "l2"])],
      [{ versionId: "v1", rows: [loc("l1", "vi"), loc("l2", "en-US")] }],
    );
    expect(s.versions[0].pointerDisagrees).toBe(false);
    expect(describeVersionSnapshotForLog(s)).toContain("flags=[]");
  });

  it("⚠ NO_EDGE never counts as disagreement — absent is not short", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", null)],
      [{ versionId: "v1", rows: [loc("l1", "vi")] }],
    );
    expect(s.versions[0].edge.kind).toBe("NO_EDGE");
    expect(s.versions[0].pointerDisagrees).toBe(false);
    expect(describeVersionSnapshotForLog(s)).toContain("v1:NO_EDGE");
  });

  it("a pointer LONGER than reality is not reported as the landmark", () => {
    // Different anomaly; blurring the two would turn a measurement into noise.
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1", "l2", "l3"])],
      [{ versionId: "v1", rows: [loc("l1", "vi")] }],
    );
    expect(s.versions[0].pointerDisagrees).toBe(false);
  });

  // ─── shape ────────────────────────────────────────────────────────────────

  it("a missing state is named, never coerced to a plausible one", () => {
    const s = summarizeVersionSnapshot("com.a", [{ id: "v1" }], [
      { versionId: "v1", rows: [] },
    ]);
    expect(s.versions[0].state).toBe("STATE_ABSENT");
    expect(describeVersionSnapshotForLog(s)).toContain("v1:STATE_ABSENT");
  });

  it("a localization row with no locale still counts, and is named", () => {
    const s = summarizeVersionSnapshot("com.a", [version("v1", "APPROVED", ["l1"])], [
      { versionId: "v1", rows: [{ type: "inAppPurchaseLocalizations", id: "l1", attributes: {} }] },
    ]);
    expect(s.versions[0].locales).toEqual(["LOCALE_ABSENT"]);
  });

  it("an empty version list does not throw and says so", () => {
    const s = summarizeVersionSnapshot("com.a", [], []);
    expect(s.versions).toEqual([]);
    expect(describeVersionSnapshotForLog(s)).toContain("versions=[]");
    expect(s.incomplete).toBe(false);
  });

  it("the log line carries the product id and the stable prefix the Manager greps", () => {
    const s = summarizeVersionSnapshot("com.pure3q.sea.mb6", [version("v1", "APPROVED", [])], [
      { versionId: "v1", rows: [] },
    ]);
    expect(describeVersionSnapshotForLog(s)).toMatch(
      /^LOCV2-SNAPSHOT product=com\.pure3q\.sea\.mb6 versions=\[/,
    );
  });
});
