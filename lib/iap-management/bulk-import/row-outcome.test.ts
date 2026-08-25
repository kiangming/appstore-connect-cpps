/**
 * C3 chunk A — a row's status is DERIVED from its stage map, and the map is
 * what a Manager reads.
 *
 * ⚠ THE DEFECT THIS REPLACES. Five of the six CREATE stages swallowed their
 * own errors and the row returned a hard-coded `status: "SUCCESS"`. An IAP
 * created on Apple with no localizations, no price and no screenshot reported
 * as a clean success — KB §10.8 recorded the symptom under Hotfix 26 while
 * the cause stayed where it was. So the load-bearing assertion is not "a
 * PARTIAL exists" but "there is no longer any route to SUCCESS with a stage
 * missing".
 */
import { describe, it, expect } from "vitest";
import {
  rollUpRowOutcome,
  CREATE_STAGE_ORDER,
  type RowStages,
  type StageState,
} from "./row-outcome";

function stages(over: Partial<RowStages> = {}): RowStages {
  return {
    create: { state: "OK" },
    localizations: { state: "OK", done: 39, total: 39, failed: [], skippedByStop: 0 },
    pricing: { state: "OK", outcome: "set" },
    screenshot: { state: "OK", note: "uploaded-new" },
    availability: { state: "OK" },
    submit: { state: "OK", outcome: "submitted" },
    ...over,
  };
}

describe("⚠ no stage may fail and still leave the row SUCCESS", () => {
  // Driven off the stage list itself, so a seventh stage added later is
  // covered without anyone remembering to add a case.
  for (const key of CREATE_STAGE_ORDER) {
    if (key === "create" || key === "localizations") continue; // asserted separately
    it(`a FAILED ${key} makes the row PARTIAL`, () => {
      const s = stages({ [key]: { state: "FAILED" as StageState } } as Partial<RowStages>);
      expect(rollUpRowOutcome(s).status).toBe("PARTIAL");
    });
    it(`a SKIPPED_BY_STOP ${key} makes the row PARTIAL`, () => {
      const s = stages({ [key]: { state: "SKIPPED_BY_STOP" as StageState } } as Partial<RowStages>);
      expect(rollUpRowOutcome(s).status).toBe("PARTIAL");
    });
  }

  it("every stage OK → SUCCESS", () => {
    expect(rollUpRowOutcome(stages()).status).toBe("SUCCESS");
  });

  it("⚠ NOT_APPLICABLE is not a failure — no file, no tier, submit not asked", () => {
    const s = stages({
      screenshot: { state: "NOT_APPLICABLE", note: "no-file" },
      pricing: { state: "NOT_APPLICABLE", outcome: "skipped-no-tier" },
      submit: { state: "NOT_APPLICABLE" },
    });
    expect(rollUpRowOutcome(s).status).toBe("SUCCESS");
  });
});

describe("localizations count as incomplete even when nothing 'failed'", () => {
  it("⚠ 12 of 39 is PARTIAL — stopping short IS the case to surface", () => {
    const s = stages({
      localizations: {
        state: "SKIPPED_BY_STOP",
        done: 12,
        total: 39,
        failed: [],
        skippedByStop: 27,
      },
    });
    const out = rollUpRowOutcome(s);
    expect(out.status).toBe("PARTIAL");
    expect(out.summary).toContain("12/39 locales");
  });

  it("all 39 done → not short", () => {
    expect(rollUpRowOutcome(stages()).status).toBe("SUCCESS");
  });

  it("zero localizations is NOT_APPLICABLE, not 0/0 incomplete", () => {
    const s = stages({
      localizations: { state: "NOT_APPLICABLE", done: 0, total: 0, failed: [], skippedByStop: 0 },
    });
    expect(rollUpRowOutcome(s).status).toBe("SUCCESS");
  });
});

describe("the summary is the sentence [Q-C3.partial] asked for", () => {
  it("renders the canonical example", () => {
    const s = stages({
      localizations: { state: "FAILED", done: 12, total: 39, failed: ["de-DE"], skippedByStop: 0 },
      screenshot: { state: "FAILED", note: "failed" },
      pricing: { state: "FAILED", outcome: "failed-set" },
    });
    const out = rollUpRowOutcome(s);
    expect(out.summary).toBe(
      "Created on Apple · 12/39 locales · missing localizations, pricing, screenshot",
    );
  });

  it("names a rate-limit stop separately from a failure — different advice", () => {
    // "missing X" means investigate; "stopped by rate limit" means run again.
    const s = stages({
      screenshot: { state: "SKIPPED_BY_STOP" },
      availability: { state: "SKIPPED_BY_STOP" },
      submit: { state: "SKIPPED_BY_STOP" },
    });
    const out = rollUpRowOutcome(s);
    expect(out.summary).toContain("stopped by rate limit before");
    expect(out.summary).not.toContain("missing");
  });

  it("⚠ an OVERWRITE row does not claim it was created", () => {
    const s = stages({
      create: { state: "NOT_APPLICABLE" },
      screenshot: { state: "FAILED", note: "failed" },
    });
    expect(rollUpRowOutcome(s).summary).toMatch(/^Updated on Apple/);
    expect(rollUpRowOutcome(s).summary).not.toContain("Created");
  });

  it("a clean row still says so in one line", () => {
    expect(rollUpRowOutcome(stages()).summary).toBe("Created on Apple · all stages OK");
  });
});
