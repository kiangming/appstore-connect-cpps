import { describe, it, expect } from "vitest";
import { describeAppleError } from "./apple-error-descriptor";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";

describe("describeAppleError — un-truncation proof", () => {
  it("error_full carries the COMPLETE Apple body (content beyond char 500 survives); message stays capped at 500 for backward-compat", () => {
    // Build a multi-error Apple body deliberately long enough to exceed 500
    // chars, with a unique marker in the LAST error's source.pointer — well
    // past the 500-char cut point.
    const uniqueMarker = "UNIQUE_TAIL_MARKER_BEYOND_FIVE_HUNDRED_CHARS";
    const errors = Array.from({ length: 15 }, (_, i) => ({
      id: `err-${i}`,
      status: "422",
      code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
      title: `Padding error number ${i} — a moderately long title to inflate the body size`,
      detail: `Padding detail number ${i}: repeated filler text repeated filler text repeated filler text`,
      source: { pointer: `/data/attributes/field_${i}` },
    }));
    errors[errors.length - 1].source.pointer = `/data/attributes/${uniqueMarker}`;
    const body = JSON.stringify({ errors });
    expect(body.length).toBeGreaterThan(500);

    const err = new AppleApiError(422, "POST", "/v1/inAppPurchases", body);
    const desc = describeAppleError(err);

    // error_full === the genuinely complete body — the marker beyond char
    // 500 survives untouched.
    expect(desc.full).toBe(body);
    expect(desc.full).toContain(uniqueMarker);
    expect(desc.full.length).toBeGreaterThan(500);

    // message (feeds the backward-compat `error`/`submit_error` fields)
    // stays capped at 500 chars of body, exactly as the route's old
    // errMsg() always produced — the marker must NOT appear here.
    expect(desc.message).toBe(`422: ${body.slice(0, 500)}`);
    expect(desc.message).not.toContain(uniqueMarker);
    expect(desc.message.length).toBeLessThan(desc.full.length);

    expect(desc.httpStatus).toBe(422);
  });

  it("non-Apple errors: full and message are both the plain Error message (no JSON, nothing to cap)", () => {
    const desc = describeAppleError(new Error("fetch failed"));
    expect(desc.message).toBe("fetch failed");
    expect(desc.full).toBe("fetch failed");
    expect(desc.httpStatus).toBeUndefined();
  });

  it("non-Error thrown values stringify for both message and full", () => {
    const desc = describeAppleError("plain string throw");
    expect(desc.message).toBe("plain string throw");
    expect(desc.full).toBe("plain string throw");
  });

  it("a short (<500 char) Apple body is unaffected — message and full are equivalent content", () => {
    const body = JSON.stringify({ errors: [{ status: "409", detail: "Name already used." }] });
    expect(body.length).toBeLessThan(500);
    const desc = describeAppleError(new AppleApiError(409, "POST", "/v1/inAppPurchases", body));
    expect(desc.full).toBe(body);
    expect(desc.message).toBe(`409: ${body}`);
    expect(desc.httpStatus).toBe(409);
  });
});
