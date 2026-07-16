import { describe, it, expect } from "vitest";
import { computeGoogleBulkImportTerminalStatus } from "./status-mapping";

describe("computeGoogleBulkImportTerminalStatus", () => {
  it("maps all rows succeeding (created+overwritten) to SUCCESS", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 5, succeeded: 5, failed: 0 }),
    ).toEqual({ status: "SUCCESS" });
  });

  it("maps a batch that was entirely SKIPPED (no successes, no failures) to SUCCESS", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 3, succeeded: 0, failed: 0 }),
    ).toEqual({ status: "SUCCESS" });
  });

  it("maps a batch that was entirely REFUSED (cross-currency fail-soft, folded into skipped) to SUCCESS", () => {
    // rowsRefused is folded into "skipped" by the caller before this
    // function runs — an all-refused batch arrives here as succeeded=0,
    // failed=0, same as all-skipped.
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 4, succeeded: 0, failed: 0 }),
    ).toEqual({ status: "SUCCESS" });
  });

  it("maps a mix of succeeded + skipped/refused rows with zero failures to SUCCESS", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 5, succeeded: 3, failed: 0 }),
    ).toEqual({ status: "SUCCESS" });
  });

  it("maps all rows failing to FAILED with a count-based reason", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 4, succeeded: 0, failed: 4 }),
    ).toEqual({ status: "FAILED", errorMessage: "4/4 rows failed" });
  });

  it("maps some-failed-none-succeeded (remainder skipped/refused) to FAILED", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 5, succeeded: 0, failed: 2 }),
    ).toEqual({ status: "FAILED", errorMessage: "2/5 rows failed" });
  });

  it("maps a mix of succeeded + failed rows to PARTIAL", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 10, succeeded: 6, failed: 4 }),
    ).toEqual({ status: "PARTIAL" });
  });

  it("maps succeeded + failed + skipped/refused all present to PARTIAL", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 10, succeeded: 3, failed: 2 }),
    ).toEqual({ status: "PARTIAL" });
  });

  it("maps an empty batch (total===0) to SUCCESS — nothing failed", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 0, succeeded: 0, failed: 0 }),
    ).toEqual({ status: "SUCCESS" });
  });

  it("maps succeeded=1 of total=1 (single-row batch) to SUCCESS, not PARTIAL", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 1, succeeded: 1, failed: 0 }),
    ).toEqual({ status: "SUCCESS" });
  });

  it("maps a single failed row (total=1) to FAILED", () => {
    expect(
      computeGoogleBulkImportTerminalStatus({ total: 1, succeeded: 0, failed: 1 }),
    ).toEqual({ status: "FAILED", errorMessage: "1/1 rows failed" });
  });
});
