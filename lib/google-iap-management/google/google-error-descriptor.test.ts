/**
 * The error-capture contract, pinned.
 *
 * Every test here corresponds to a field that was being thrown away before
 * 2026-10-12, and whose absence is the reason the chienky 403 had to be
 * diagnosed by inference. Deleting any one of them is the mutation that
 * must go RED.
 */
import { describe, it, expect } from "vitest";

import {
  describeGoogleError,
  errorPayloadFields,
  googleErrorPayload,
  redactSecrets,
  GoogleDualPathError,
} from "./google-error-descriptor";

/** The exact body Google returns for the chienky failure, as documented in
 *  Query B's `payload.error` plus the standard JSON-API error envelope. */
function permissionDeniedError() {
  const err = new Error("The caller does not have permission") as Error & {
    code?: number;
    response?: { status: number; data: unknown };
  };
  err.code = 403;
  err.response = {
    status: 403,
    data: {
      error: {
        code: 403,
        message: "The caller does not have permission",
        errors: [
          {
            message: "The caller does not have permission",
            domain: "global",
            reason: "forbidden",
          },
        ],
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            domain: "googleapis.com",
            metadata: {
              service: "androidpublisher.googleapis.com",
              method:
                "google.play.developer.v3.InappproductsService.BatchUpdate",
            },
          },
        ],
      },
    },
  };
  return err;
}

describe("describeGoogleError — the fields that were being dropped", () => {
  it("keeps error.status, the enum code should branch on", () => {
    expect(describeGoogleError(permissionDeniedError()).status).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("keeps errors[].reason", () => {
    expect(describeGoogleError(permissionDeniedError()).reasons).toEqual([
      "forbidden",
    ]);
  });

  it("keeps details[] VERBATIM, including @type and metadata", () => {
    const details = describeGoogleError(permissionDeniedError()).details;
    expect(details).toHaveLength(1);
    expect(details?.[0]["@type"]).toBe(
      "type.googleapis.com/google.rpc.ErrorInfo",
    );
    expect(details?.[0].reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    expect(details?.[0].metadata).toEqual({
      service: "androidpublisher.googleapis.com",
      method: "google.play.developer.v3.InappproductsService.BatchUpdate",
    });
  });

  it("keeps the HTTP status", () => {
    expect(describeGoogleError(permissionDeniedError()).httpStatus).toBe(403);
  });

  it("`full` carries the COMPLETE body and is never sliced", () => {
    const desc = describeGoogleError(permissionDeniedError());
    expect(desc.full).toContain("PERMISSION_DENIED");
    expect(desc.full).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    expect(desc.full).toContain("androidpublisher.googleapis.com");
  });

  it("`message` stays capped so it is still safe for a table cell", () => {
    const err = new Error("x".repeat(5000));
    expect(describeGoogleError(err).message).toHaveLength(500);
  });

  it("reads the status off response.status when code is absent", () => {
    const err = Object.assign(new Error("nope"), {
      response: { status: 404, data: {} },
    });
    expect(describeGoogleError(err).httpStatus).toBe(404);
  });

  it("reads a numeric-string code (googleapis' historical shape)", () => {
    const err = Object.assign(new Error("nope"), { code: "403" });
    expect(describeGoogleError(err).httpStatus).toBe(403);
  });

  it("does NOT mistake a system error code for an HTTP status", () => {
    const err = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    expect(describeGoogleError(err).httpStatus).toBeUndefined();
  });

  it("parses a body that arrived as a raw JSON string", () => {
    const err = Object.assign(new Error("nope"), {
      response: {
        status: 403,
        data: JSON.stringify({ error: { status: "PERMISSION_DENIED" } }),
      },
    });
    expect(describeGoogleError(err).status).toBe("PERMISSION_DENIED");
  });

  it("is total: a plain throw still yields message + full", () => {
    const desc = describeGoogleError("something broke");
    expect(desc.message).toBe("something broke");
    expect(desc.full).toBe("something broke");
    expect(desc.status).toBeUndefined();
  });

  it("survives a non-serializable body without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = Object.assign(new Error("nope"), {
      response: { status: 500, data: circular },
    });
    expect(() => describeGoogleError(err)).not.toThrow();
  });
});

describe("redactSecrets — ⛔ no key material may leave this module", () => {
  const KEY =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BA\nQEFAASC\n-----END PRIVATE KEY-----";

  it("strips a complete PEM block", () => {
    const out = redactSecrets(`scope error near ${KEY} at offset 12`);
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BA");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).toContain("[REDACTED PRIVATE KEY]");
    expect(out).toContain("at offset 12");
  });

  it("strips a TRUNCATED PEM tail (no END marker)", () => {
    const out = redactSecrets(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG",
    );
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG");
    expect(out).toBe("[REDACTED PRIVATE KEY]");
  });

  it("does not let the greedy tail pattern eat a whole body after one key", () => {
    const out = redactSecrets(`a ${KEY} b ${KEY} c`);
    expect(out).toBe(
      "a [REDACTED PRIVATE KEY] b [REDACTED PRIVATE KEY] c",
    );
  });

  it("strips a private_key JSON field", () => {
    const out = redactSecrets('{"private_key":"-----BEGIN X","x":1}');
    expect(out).not.toContain("BEGIN X");
    expect(out).toContain('"x":1');
  });

  it("runs over the error message AND the full body", () => {
    const err = Object.assign(new Error(`bad key ${KEY}`), {
      response: { status: 400, data: { error: { message: KEY } } },
    });
    const desc = describeGoogleError(err);
    expect(desc.message).not.toContain("MIIEvQIBADANBgkqhkiG9w0BA");
    expect(desc.full).not.toContain("MIIEvQIBADANBgkqhkiG9w0BA");
  });

  it("leaves an ordinary message untouched", () => {
    expect(redactSecrets("The caller does not have permission")).toBe(
      "The caller does not have permission",
    );
  });
});

describe("GoogleDualPathError — both halves survive", () => {
  const dual = () =>
    new GoogleDualPathError(
      "batch upsert",
      describeGoogleError(permissionDeniedError()),
      describeGoogleError(
        Object.assign(new Error("Please migrate to the new publishing API."), {
          code: 403,
        }),
      ),
    );

  it("names BOTH failures in the message", () => {
    const e = dual();
    expect(e.message).toContain("The caller does not have permission");
    expect(e.message).toContain("Please migrate to the new publishing API.");
  });

  it("exposes both descriptors structurally, not just as prose", () => {
    const e = dual();
    expect(e.primary.status).toBe("PERMISSION_DENIED");
    expect(e.fallback.message).toContain("Please migrate");
  });

  it("⚠ carries `code` so the route still answers 403, not 500", () => {
    expect(dual().code).toBe(403);
  });

  it("is a real Error (instanceof + stack), so existing catches work", () => {
    expect(dual()).toBeInstanceOf(Error);
    expect(dual().stack).toBeTruthy();
  });
});

describe("payload shape written to actions_log", () => {
  it("keeps `error` meaning exactly what it meant before", () => {
    const p = googleErrorPayload(permissionDeniedError());
    expect(p.error).toBe("The caller does not have permission");
  });

  it("adds the structured fields alongside it", () => {
    const p = googleErrorPayload(permissionDeniedError());
    expect(p.error_status).toBe("PERMISSION_DENIED");
    expect(p.error_http_status).toBe(403);
    expect(p.error_reasons).toEqual(["forbidden"]);
    expect(Array.isArray(p.error_details)).toBe(true);
    expect(p.error_full).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("stores BOTH halves under distinct prefixes when both paths failed", () => {
    const p = googleErrorPayload(
      new GoogleDualPathError(
        "batch upsert",
        describeGoogleError(permissionDeniedError()),
        describeGoogleError(
          Object.assign(new Error("legacy is gone"), { code: 410 }),
        ),
      ),
    );
    expect(p.error).toBe("The caller does not have permission");
    expect(p.error_status).toBe("PERMISSION_DENIED");
    expect(p.error_fallback).toBe("legacy is gone");
    expect(p.error_fallback_http_status).toBe(410);
    expect(p.error_both_paths_failed).toBe(true);
  });

  it("omits absent fields rather than writing nulls into the payload", () => {
    const p = errorPayloadFields(describeGoogleError(new Error("plain")));
    expect(Object.keys(p).sort()).toEqual(["error", "error_full"]);
  });
});
