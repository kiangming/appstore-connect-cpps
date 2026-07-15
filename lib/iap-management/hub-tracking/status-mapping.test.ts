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

  it("maps a batch that was entirely SKIPPED (no successes, no failures) to SUCCESS — conflict-skip isn't a failure", () => {
    expect(computeBulkImportTerminalStatus({ total: 3, succeeded: 0, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps a mix of succeeded + skipped rows with zero failures to SUCCESS", () => {
    expect(computeBulkImportTerminalStatus({ total: 5, succeeded: 3, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps all rows failing to FAILED with a count-based reason", () => {
    expect(computeBulkImportTerminalStatus({ total: 4, succeeded: 0, failed: 4 })).toEqual({
      status: "FAILED",
      errorMessage: "4/4 rows failed",
    });
  });

  it("maps some-failed-none-succeeded (remainder skipped) to FAILED", () => {
    expect(computeBulkImportTerminalStatus({ total: 5, succeeded: 0, failed: 2 })).toEqual({
      status: "FAILED",
      errorMessage: "2/5 rows failed",
    });
  });

  it("maps a mix of succeeded + failed rows to PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 10, succeeded: 6, failed: 4 })).toEqual({
      status: "PARTIAL",
    });
  });

  it("maps succeeded + failed + skipped all present to PARTIAL (skipped doesn't change the verdict)", () => {
    expect(computeBulkImportTerminalStatus({ total: 10, succeeded: 3, failed: 2 })).toEqual({
      status: "PARTIAL",
    });
  });

  it("maps an empty batch (total===0) to SUCCESS — nothing failed", () => {
    expect(computeBulkImportTerminalStatus({ total: 0, succeeded: 0, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps succeeded=1 of total=1 (single-row batch) to SUCCESS, not PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 1, succeeded: 1, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps a single failed row (total=1) to FAILED", () => {
    expect(computeBulkImportTerminalStatus({ total: 1, succeeded: 0, failed: 1 })).toEqual({
      status: "FAILED",
      errorMessage: "1/1 rows failed",
    });
  });
});
