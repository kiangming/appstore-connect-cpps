/**
 * Tests for IAP.o.12a state-machine helper. The helper drives the pre-warn
 * banner copy in the edit form — it must never pre-block, only flag the two
 * states that Apple consistently rejects with state-related 409/422.
 */
import { describe, it, expect } from "vitest";
import { isStateEditLikelyBlocked } from "./state-edit-blocked";

describe("isStateEditLikelyBlocked", () => {
  it("returns true for WAITING_FOR_REVIEW", () => {
    expect(isStateEditLikelyBlocked("WAITING_FOR_REVIEW")).toBe(true);
  });
  it("returns true for IN_REVIEW", () => {
    expect(isStateEditLikelyBlocked("IN_REVIEW")).toBe(true);
  });
  it("returns false for MISSING_METADATA (editable)", () => {
    expect(isStateEditLikelyBlocked("MISSING_METADATA")).toBe(false);
  });
  it("returns false for READY_TO_SUBMIT (editable)", () => {
    expect(isStateEditLikelyBlocked("READY_TO_SUBMIT")).toBe(false);
  });
  it("returns false for READY_FOR_SALE (edits allowed at attribute level)", () => {
    expect(isStateEditLikelyBlocked("READY_FOR_SALE")).toBe(false);
  });
  it("returns false for REJECTED (revision allowed)", () => {
    expect(isStateEditLikelyBlocked("REJECTED")).toBe(false);
  });
  it("returns false for null/undefined/empty (cache miss)", () => {
    expect(isStateEditLikelyBlocked(null)).toBe(false);
    expect(isStateEditLikelyBlocked(undefined)).toBe(false);
    expect(isStateEditLikelyBlocked("")).toBe(false);
  });
  it("returns false for an unknown state string (forward-compat)", () => {
    expect(isStateEditLikelyBlocked("FUTURE_STATE")).toBe(false);
  });
});
