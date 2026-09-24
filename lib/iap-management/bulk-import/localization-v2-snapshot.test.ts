/**
 * Arc `[LOC-V2-model]` V0-snapshot — these tests pin the DISTINCTIONS the
 * snapshot exists to make.
 *
 * ⚠ The failure mode being guarded is NOT "the line is wrong". It is "the line
 * is confidently wrong in the reassuring direction" — reporting a version as
 * owning no localizations when the truth is that Apple did not send the edge.
 * That answer would go into the KB and be believed. Same lesson as
 * `localization-state-probe.test.ts` (ABSENT ≠ EMPTY).
 */
import { describe, it, expect } from "vitest";
import {
  summarizeVersionSnapshot,
  describeVersionSnapshotForLog,
} from "./localization-v2-snapshot";

const version = (
  id: string,
  state: string,
  locIds: string[] | null,
) => ({
  id,
  attributes: { state },
  ...(locIds === null
    ? { relationships: { localizations: {} } }
    : {
        relationships: {
          localizations: {
            data: locIds.map((i) => ({ type: "inAppPurchaseLocalizations", id: i })),
          },
        },
      }),
});

const loc = (id: string, locale: string) => ({
  type: "inAppPurchaseLocalizations",
  id,
  attributes: { locale, name: "n", description: "d" },
});

describe("summarizeVersionSnapshot", () => {
  it("joins localizations to versions through the PRIMARY-side edge", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1", "l2"])],
      [loc("l1", "vi"), loc("l2", "en-US")],
    );
    expect(s.versions[0].locales).toEqual(["vi", "en-US"]);
    expect(s.includedTotal).toBe(2);
    expect(s.unclaimedLocales).toEqual([]);
  });

  it("⭐ THE INHERITANCE QUESTION: a draft owning fewer locales than the approved version", () => {
    // This is the shape that would mean NO inheritance — and it is the single
    // most consequential thing the read-only snapshot can discover.
    const s = summarizeVersionSnapshot(
      "com.a",
      [
        version("v1", "APPROVED", ["l1", "l2"]),
        version("v2", "PREPARE_FOR_SUBMISSION", ["l3"]),
      ],
      [loc("l1", "vi"), loc("l2", "en-US"), loc("l3", "vi")],
    );
    expect(s.versions[0].locales).toEqual(["vi", "en-US"]);
    expect(s.versions[1].locales).toEqual(["vi"]);
    expect(describeVersionSnapshotForLog(s)).toContain(
      "locsByVersion=[v1:{vi,en-US}, v2:{vi}]",
    );
  });

  it("⚠⚠ NO_EDGE is NOT an empty list — the distinction the probe exists for", () => {
    const missing = summarizeVersionSnapshot("com.a", [version("v1", "APPROVED", null)], []);
    const empty = summarizeVersionSnapshot("com.a", [version("v1", "APPROVED", [])], []);

    expect(missing.versions[0].edge.kind).toBe("NO_EDGE");
    expect(empty.versions[0].edge).toEqual({ kind: "IDS", ids: [] });

    // And the two must not render the same, or the distinction dies in the log.
    expect(describeVersionSnapshotForLog(missing)).toContain("v1:NO_EDGE");
    expect(describeVersionSnapshotForLog(empty)).toContain("v1:{}");
    expect(describeVersionSnapshotForLog(missing)).not.toContain("v1:{}");
  });

  it("⚠ an included localization NO version claims is reported, never silently attached", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1"])],
      [loc("l1", "vi"), loc("l9", "th")],
    );
    expect(s.unclaimedLocales).toEqual(["th"]);
    expect(s.versions[0].locales).toEqual(["vi"]);
    expect(describeVersionSnapshotForLog(s)).toContain("unclaimed=[th]");
  });

  it("⚠ an edge id with no included row is UNRESOLVED, not dropped", () => {
    // Dropping it would understate the version's contents — the exact
    // direction that makes "no inheritance" look true when it isn't.
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1", "lX"])],
      [loc("l1", "vi")],
    );
    expect(s.versions[0].locales).toEqual(["vi"]);
    expect(s.versions[0].unresolvedIds).toEqual(["lX"]);
    expect(describeVersionSnapshotForLog(s)).toContain("UNRESOLVED(lX)");
  });

  it("a localization row with no locale still counts, and is named", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1"])],
      [{ type: "inAppPurchaseLocalizations", id: "l1", attributes: {} }],
    );
    expect(s.includedTotal).toBe(1);
    expect(s.versions[0].locales).toEqual(["LOCALE_ABSENT"]);
  });

  it("non-localization included rows are ignored, not counted", () => {
    const s = summarizeVersionSnapshot(
      "com.a",
      [version("v1", "APPROVED", ["l1"])],
      [loc("l1", "vi"), { type: "inAppPurchases", id: "iap-1", attributes: {} }],
    );
    expect(s.includedTotal).toBe(1);
  });

  it("a missing state is named, never coerced to a plausible one", () => {
    const s = summarizeVersionSnapshot("com.a", [{ id: "v1" }], []);
    expect(s.versions[0].state).toBe("STATE_ABSENT");
    expect(describeVersionSnapshotForLog(s)).toContain("v1:STATE_ABSENT");
  });

  it("an empty version list does not throw and says so", () => {
    const s = summarizeVersionSnapshot("com.a", [], []);
    expect(s.versions).toEqual([]);
    expect(describeVersionSnapshotForLog(s)).toContain("versions=[]");
    expect(describeVersionSnapshotForLog(s)).toContain("total=0");
  });

  it("the log line carries the product id and the stable prefix the Manager greps", () => {
    const s = summarizeVersionSnapshot("com.vng.x", [version("v1", "APPROVED", [])], []);
    expect(describeVersionSnapshotForLog(s)).toMatch(
      /^LOCV2-SNAPSHOT product=com\.vng\.x versions=\[/,
    );
  });
});
