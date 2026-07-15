import { describe, it, expect } from "vitest";
import { computeBulkImportTerminalStatus } from "./status-mapping";

describe("computeBulkImportTerminalStatus", () => {
  it("maps all rows succeeding to SUCCESS", () => {
    expect(computeBulkImportTerminalStatus({ total: 5, succeeded: 5, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps a submit-deferred/failed row that still created OK to SUCCESS (create succeeded = import succeeded)", () => {
    // succeeded counts every row with status:"SUCCESS", regardless of
    // submit_outcome — a deferred/failed submit doesn't downgrade this.
    expect(computeBulkImportTerminalStatus({ total: 3, succeeded: 3, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps all rows failing to FAILED with a count-based reason", () => {
    expect(computeBulkImportTerminalStatus({ total: 4, succeeded: 0, failed: 4 })).toEqual({
      status: "FAILED",
      errorMessage: "4/4 rows failed",
    });
  });

  it("maps a mixed batch to PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 10, succeeded: 6, failed: 4 })).toEqual({
      status: "PARTIAL",
    });
  });

  it("maps an empty batch (total===0) to FAILED — the run already started at step 1", () => {
    expect(computeBulkImportTerminalStatus({ total: 0, succeeded: 0, failed: 0 })).toEqual({
      status: "FAILED",
      errorMessage: "no rows to import",
    });
  });

  it("maps a batch that was entirely SKIPPED (no successes, no failures) to FAILED per the locked formula", () => {
    // Known nuance: skipped rows aren't "succeeded", so succeeded===0 here
    // even though nothing technically errored either.
    expect(computeBulkImportTerminalStatus({ total: 3, succeeded: 0, failed: 0 })).toEqual({
      status: "FAILED",
      errorMessage: "0/3 rows failed",
    });
  });

  it("maps succeeded=1 of total=1 (single-row batch) to SUCCESS, not PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 1, succeeded: 1, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });
});
