import { describe, it, expect } from "vitest";
import {
  computeBulkImportTerminalStatus,
  deriveTerminalStatusOnUnexpectedError,
} from "./status-mapping";

describe("computeBulkImportTerminalStatus (CPP — per-CPP success unit)", () => {
  it("maps all CPPs succeeding to SUCCESS", () => {
    expect(computeBulkImportTerminalStatus({ total: 5, succeeded: 5, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps an empty batch (total===0) to SUCCESS — nothing failed", () => {
    expect(computeBulkImportTerminalStatus({ total: 0, succeeded: 0, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps succeeded=1 of total=1 (single-CPP batch) to SUCCESS, not PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 1, succeeded: 1, failed: 0 })).toEqual({
      status: "SUCCESS",
    });
  });

  it("maps all CPPs failing to FAILED with a count-based reason", () => {
    expect(computeBulkImportTerminalStatus({ total: 4, succeeded: 0, failed: 4 })).toEqual({
      status: "FAILED",
      errorMessage: "4/4 CPPs failed",
    });
  });

  it("maps a single failed CPP (total=1) to FAILED", () => {
    expect(computeBulkImportTerminalStatus({ total: 1, succeeded: 0, failed: 1 })).toEqual({
      status: "FAILED",
      errorMessage: "1/1 CPPs failed",
    });
  });

  it("maps a mix of succeeded + failed CPPs to PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 10, succeeded: 6, failed: 4 })).toEqual({
      status: "PARTIAL",
    });
  });

  it("maps succeeded=1/failed=1 (smallest possible PARTIAL) to PARTIAL", () => {
    expect(computeBulkImportTerminalStatus({ total: 2, succeeded: 1, failed: 1 })).toEqual({
      status: "PARTIAL",
    });
  });
});

describe("deriveTerminalStatusOnUnexpectedError (R1 — finalize-in-finally backstop)", () => {
  it("maps a mid-batch throw with zero prior successes to FAILED — never RUNNING, never a guessed SUCCESS", () => {
    const result = deriveTerminalStatusOnUnexpectedError(0, new Error("worker loop exploded"));
    expect(result.status).toBe("FAILED");
    expect(result.errorMessage).toContain("worker loop exploded");
  });

  it("maps a mid-batch throw with at least one prior success to PARTIAL, not FAILED", () => {
    const result = deriveTerminalStatusOnUnexpectedError(3, new Error("boom"));
    expect(result.status).toBe("PARTIAL");
  });

  it("never returns SUCCESS or CANCELLED regardless of succeededCount — the whole point of the backstop", () => {
    for (const succeededCount of [0, 1, 5, 100]) {
      const result = deriveTerminalStatusOnUnexpectedError(succeededCount, new Error("x"));
      expect(result.status).not.toBe("SUCCESS");
      expect(result.status).not.toBe("CANCELLED");
    }
  });

  it("stringifies a non-Error thrown value instead of crashing", () => {
    const result = deriveTerminalStatusOnUnexpectedError(0, "a raw string throw");
    expect(result.errorMessage).toContain("a raw string throw");
  });
});
