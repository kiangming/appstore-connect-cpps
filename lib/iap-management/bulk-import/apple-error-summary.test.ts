import { describe, it, expect } from "vitest";
import { summarizeAppleError } from "./apple-error-summary";

describe("summarizeAppleError", () => {
  it("uses errors[0].detail when present", () => {
    const raw = JSON.stringify({
      errors: [{ status: "409", code: "ENTITY_ERROR", title: "Conflict", detail: "This name is already being used." }],
    });
    const result = summarizeAppleError({ raw, fallback: "409: (fallback)", stage: "apple-create", httpStatus: 409 });
    expect(result.isAppleJson).toBe(true);
    expect(result.summary).toBe("apple-create 409 — This name is already being used.");
  });

  it("falls back to title when detail is absent", () => {
    const raw = JSON.stringify({
      errors: [{ status: "422", code: "ENTITY_ERROR", title: "Invalid attribute" }],
    });
    const result = summarizeAppleError({ raw, fallback: "422: (fallback)" });
    expect(result.summary).toBe("Invalid attribute");
  });

  it("falls back to code when both detail and title are absent", () => {
    const raw = JSON.stringify({ errors: [{ code: "ENTITY_ERROR.ATTRIBUTE.INVALID" }] });
    const result = summarizeAppleError({ raw, fallback: "422: (fallback)" });
    expect(result.summary).toBe("ENTITY_ERROR.ATTRIBUTE.INVALID");
  });

  it("falls back to 'Unknown Apple error' when the entry has no detail/title/code", () => {
    const raw = JSON.stringify({ errors: [{ status: "500" }] });
    const result = summarizeAppleError({ raw, fallback: "500: (fallback)" });
    expect(result.summary).toBe("Unknown Apple error");
  });

  it("uses the raw-truncated fallback for a non-JSON string (network error / timeout)", () => {
    const result = summarizeAppleError({
      raw: "TypeError: fetch failed",
      fallback: "apple-create: TypeError: fetch failed",
      stage: "apple-create",
    });
    expect(result.isAppleJson).toBe(false);
    expect(result.summary).toBe(
      `apple-create: ${"apple-create: TypeError: fetch failed".slice(0, 120)}`,
    );
  });

  it("uses the raw-truncated fallback when `raw` is undefined (older rows without error_full)", () => {
    const result = summarizeAppleError({ raw: undefined, fallback: "409: some capped body", stage: "apple-create" });
    expect(result.isAppleJson).toBe(false);
    expect(result.summary).toBe("apple-create: 409: some capped body");
  });

  it("multi-error: prefixes with the count and shows the first error's detail", () => {
    const raw = JSON.stringify({
      errors: [
        { detail: "First problem." },
        { detail: "Second problem." },
        { detail: "Third problem." },
      ],
    });
    const result = summarizeAppleError({ raw, fallback: "422: (fallback)", stage: "apple-patch", httpStatus: 422 });
    expect(result.summary).toBe("apple-patch 422 — 3 errors: First problem.");
  });

  it("truncates the non-JSON fallback to 120 chars", () => {
    const longText = "x".repeat(300);
    const result = summarizeAppleError({ raw: longText, fallback: longText });
    expect(result.summary.length).toBeLessThanOrEqual(120);
  });
});
