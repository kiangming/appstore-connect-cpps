/**
 * C3 chunk B — the stage map has to survive being read by a person.
 *
 * These are the questions the badges and the results table ask of a row.
 * Every one of them is asked of the MAP; none may be answered from the row's
 * `status`, because the status is derived FROM the map and re-deriving it
 * backwards is how the two drift apart.
 */
import { describe, it, expect } from "vitest";
import {
  stageMapHasFindings,
  formatStageMap,
  formatLocalizationCounts,
  pricingRan,
} from "./stage-map-view";
import { rollUpRowOutcome, type RowStages } from "./row-outcome";

const ok = (): RowStages => ({
  create: { state: "OK" },
  localizations: { state: "OK", done: 3, total: 3, failed: [], skippedByStop: 0 },
  pricing: { state: "OK", outcome: "set" },
  screenshot: { state: "OK", note: "uploaded-new" },
  availability: { state: "OK" },
  submit: { state: "NOT_APPLICABLE" },
});

describe("stageMapHasFindings — what the results table gates its disclosure on", () => {
  it("a clean map has nothing to expand", () => {
    expect(stageMapHasFindings(ok())).toBe(false);
  });

  it("finds a FAILED stage", () => {
    const s = ok();
    s.screenshot = { state: "FAILED", note: "failed", error: "bad PNG" };
    expect(stageMapHasFindings(s)).toBe(true);
  });

  it("finds a SKIPPED_BY_STOP stage", () => {
    const s = ok();
    s.availability = { state: "SKIPPED_BY_STOP" };
    expect(stageMapHasFindings(s)).toBe(true);
  });

  it("⚠ finds a short locale set even when no single locale FAILED", () => {
    // 12 of 39 sent because the budget ran out: nothing "failed", and the
    // stage-state scan alone would have called this clean.
    const s = ok();
    s.localizations = {
      state: "SKIPPED_BY_STOP", done: 12, total: 39, failed: [], skippedByStop: 27,
    };
    expect(stageMapHasFindings(s)).toBe(true);
  });

  it("⚠ agrees with rollUpRowOutcome on every fixture — one population, two readers", () => {
    // The badge reads the roll-up, the Notes cell reads this. If they ever
    // disagree a row shows a PARTIAL badge with no explanation, or an
    // explanation next to a SUCCESS badge.
    const cases: RowStages[] = [
      ok(),
      { ...ok(), pricing: { state: "FAILED", outcome: "failed-set", error: "x" } },
      { ...ok(), submit: { state: "FAILED", outcome: "failed", error: "409" } },
      { ...ok(), screenshot: { state: "SKIPPED_BY_STOP" } },
      {
        ...ok(),
        localizations: {
          state: "SKIPPED_BY_STOP", done: 1, total: 9, failed: [], skippedByStop: 8,
        },
      },
      {
        ...ok(),
        localizations: {
          state: "NOT_APPLICABLE", done: 0, total: 0, failed: [], skippedByStop: 0,
        },
      },
    ];
    for (const s of cases) {
      expect(stageMapHasFindings(s)).toBe(rollUpRowOutcome(s).status === "PARTIAL");
    }
  });
});

describe("formatLocalizationCounts — the denominator chunk A added", () => {
  it("shows done over total", () => {
    expect(
      formatLocalizationCounts({
        state: "SKIPPED_BY_STOP", done: 12, total: 39, failed: [], skippedByStop: 27,
      }),
    ).toBe("12/39 done · 27 not sent");
  });

  it("names the locales that failed", () => {
    expect(
      formatLocalizationCounts({
        state: "FAILED", done: 2, total: 3, failed: ["de-DE"], skippedByStop: 0,
      }),
    ).toBe("2/3 done · 1 failed: de-DE");
  });

  it("says so when the row had no localizations at all", () => {
    expect(
      formatLocalizationCounts({
        state: "NOT_APPLICABLE", done: 0, total: 0, failed: [], skippedByStop: 0,
      }),
    ).toContain("no localizations");
  });
});

describe("formatStageMap — every stage is accounted for, in pipeline order", () => {
  it("lists all six stages", () => {
    const lines = formatStageMap(ok()).split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.trim().split(/\s{2,}/)[0])).toEqual([
      "Create", "Localizations", "Pricing", "Screenshot", "Availability", "Submit",
    ]);
  });

  it("⚠ a FAILED stage never reads 'ok'", () => {
    const s = ok();
    s.pricing = { state: "FAILED", outcome: "failed-set", error: "Apple said no" };
    const line = formatStageMap(s).split("\n").find((l) => l.startsWith("Pricing"))!;
    expect(line).toContain("failed");
    expect(line).not.toMatch(/\bok\b/);
    expect(line).toContain("Apple said no");
  });

  it("⚠ 'not sent' and 'failed' are different words", () => {
    // Safe-to-re-run versus needs-looking-at. Collapsing them is the whole
    // reason SKIPPED_BY_STOP exists as a state of its own.
    const stopped = { ...ok(), availability: { state: "SKIPPED_BY_STOP" as const } };
    const failed = {
      ...ok(),
      availability: { state: "FAILED" as const, error: "403" },
    };
    const lineOf = (s: RowStages) =>
      formatStageMap(s).split("\n").find((l) => l.startsWith("Availability"))!;
    expect(lineOf(stopped)).toContain("not sent");
    expect(lineOf(stopped)).not.toContain("failed");
    expect(lineOf(failed)).toContain("failed");
  });

  it("a NOT_APPLICABLE stage reads n/a, not ok", () => {
    const line = formatStageMap(ok()).split("\n").find((l) => l.startsWith("Submit"))!;
    expect(line).toContain("n/a");
  });
});

describe("pricingRan — asked instead of reading the row's status", () => {
  it("true when the pricing stage landed, even on a row that is PARTIAL overall", () => {
    const s = ok();
    s.screenshot = { state: "FAILED", note: "failed", error: "bad PNG" };
    expect(rollUpRowOutcome(s).status).toBe("PARTIAL");
    expect(pricingRan(s)).toBe(true);
  });

  it("false when pricing was never sent", () => {
    const s = ok();
    s.pricing = { state: "SKIPPED_BY_STOP", outcome: "skipped-not-ready" };
    expect(pricingRan(s)).toBe(false);
  });

  it("false when there is no map at all", () => {
    expect(pricingRan(undefined)).toBe(false);
  });
});
