/**
 * ⭐ O1 — when BOTH the new API and the legacy fallback fail, BOTH are kept.
 *
 * The hole this closes, precisely: six fallback sites ended in
 * `catch { throw err }`, which discarded the legacy call's error. That is
 * worse than it sounds, because the discarded call is the one that had just
 * written the Railway line an operator goes on to read. On 2026-10-12 the
 * line said
 *
 *   [google-iap:publisher] method=inappproducts.batchUpdate … status=403
 *     err="The caller does not have permission"
 *
 * while the error that actually reached the Manager came from
 * `monetization.onetimeproducts.batchUpdate` — a different call, same
 * sentence, and nothing anywhere to tell them apart. An investigation spent
 * a full round-trip establishing that from source.
 *
 * ⚠ MUTATION BAR. Restoring `catch { throw err }` at any of the six sites
 * must turn this file RED. The dual-path assertions below are written
 * against the THROWN VALUE, not against a log spy, so a site that merely
 * logs both and still throws one is also caught.
 *
 * ⚠ PARITY. The success path is the other half of the bar: `lightandnight`
 * imported 9/9 cleanly the week before and must keep doing so. The parity
 * block pins that an untouched new-API call neither logs the both-failed
 * line nor reaches the legacy resource at all.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getProductSpy,
  newBatchUpdateSpy,
  batchActivateSpy,
  legacyBatchUpdateSpy,
  logSpy,
} = vi.hoisted(() => ({
  getProductSpy: vi.fn(),
  newBatchUpdateSpy: vi.fn(),
  batchActivateSpy: vi.fn(),
  legacyBatchUpdateSpy: vi.fn(),
  logSpy: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    androidpublisher: () => ({
      monetization: {
        onetimeproducts: {
          get: getProductSpy,
          batchUpdate: newBatchUpdateSpy,
          purchaseOptions: { batchUpdateStates: batchActivateSpy },
        },
      },
      inappproducts: { batchUpdate: legacyBatchUpdateSpy },
    }),
  },
}));
vi.mock("./logging", () => ({ logPublisherCall: logSpy }));
vi.mock("google-auth-library", () => ({ JWT: class {} }));

import { batchUpsertInAppProducts } from "./publisher-client";
import type { BatchUpsertInput } from "./publisher-client";
import { GoogleDualPathError } from "./google-error-descriptor";

const jwt = {} as never;
const PKG = "vng.games.tamquoc.chienky";

function createInput(sku = "sku.new"): BatchUpsertInput {
  return {
    body: {
      sku,
      status: "active",
      purchaseType: "managedUser",
      defaultLanguage: "en-US",
      defaultPrice: { currency: "USD", priceMicros: "990000" },
      prices: { US: { currency: "USD", priceMicros: "990000" } },
      listings: { "en-US": { title: "New Product", description: "d" } },
    },
    regionsVersion: "2022/02",
    isOverwrite: false,
  };
}

/** The real 403, with the body Google actually sends. */
function permissionDenied(message: string, status = "PERMISSION_DENIED") {
  return Object.assign(new Error(message), {
    code: 403,
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          message,
          errors: [{ message, domain: "global", reason: "forbidden" }],
          status,
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "IAM_PERMISSION_DENIED",
              domain: "googleapis.com",
              metadata: { permission: "androidpublisher.inappproducts.update" },
            },
          ],
        },
      },
    },
  });
}

/**
 * Await a call that MUST reject, and hand back the thrown value typed.
 *
 * ⚠ The `.catch(e => e as T)` shape this replaces types as
 * `T | InAppProduct[]`, and — worse — silently passes the thrown-value
 * assertions by never running them if the call ever starts resolving. This
 * fails loudly instead.
 */
async function rejectionOf(
  p: Promise<unknown>,
): Promise<GoogleDualPathError> {
  try {
    await p;
  } catch (e) {
    return e as GoogleDualPathError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

beforeEach(() => {
  getProductSpy.mockReset();
  newBatchUpdateSpy.mockReset();
  batchActivateSpy.mockReset();
  legacyBatchUpdateSpy.mockReset();
  logSpy.mockReset();
  batchActivateSpy.mockResolvedValue({ data: {} });
});

describe("⭐ both paths failed — the fallback's error is no longer deleted", () => {
  /** ⚠ Fresh Error instances per attempt: reusing one rejected instance
   *  across two mocked calls produces spurious failures (see
   *  feedback_vitest_mock_rejected — IAP.o.10a). */
  function bothFail() {
    newBatchUpdateSpy.mockRejectedValueOnce(
      permissionDenied("The caller does not have permission"),
    );
    legacyBatchUpdateSpy.mockRejectedValueOnce(
      permissionDenied("Please migrate to the new publishing API.", "FAILED_PRECONDITION"),
    );
  }

  it("⭐ throws a GoogleDualPathError, not a bare rethrow of the new API's error", async () => {
    bothFail();
    await expect(
      batchUpsertInAppProducts(jwt, PKG, [createInput()]),
    ).rejects.toBeInstanceOf(GoogleDualPathError);
  });

  it("⭐ the thrown message names BOTH failures", async () => {
    bothFail();
    const err = await rejectionOf(
      batchUpsertInAppProducts(jwt, PKG, [createInput()]),
    );
    expect(err.message).toContain("The caller does not have permission");
    expect(err.message).toContain("Please migrate to the new publishing API.");
  });

  it("⭐ both halves survive STRUCTURALLY, not only as prose", async () => {
    bothFail();
    const err = await rejectionOf(
      batchUpsertInAppProducts(jwt, PKG, [createInput()]),
    );
    expect(err.primary.status).toBe("PERMISSION_DENIED");
    expect(err.primary.details?.[0].metadata).toEqual({
      permission: "androidpublisher.inappproducts.update",
    });
    expect(err.fallback.status).toBe("FAILED_PRECONDITION");
    expect(err.fallback.httpStatus).toBe(403);
  });

  it("⚠ keeps `code` = 403 so the execute route answers 403, not 500", async () => {
    bothFail();
    const err = await rejectionOf(
      batchUpsertInAppProducts(jwt, PKG, [createInput()]),
    );
    expect(err.code).toBe(403);
  });

  it("logs ONE both-failed line carrying both statuses", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    bothFail();
    await batchUpsertInAppProducts(jwt, PKG, [createInput()]).catch(() => {});
    const lines = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("BOTH PATHS FAILED"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`pkg=${PKG}`);
    expect(lines[0]).toContain("new_api_err_status=PERMISSION_DENIED");
    expect(lines[0]).toContain("legacy_err_status=FAILED_PRECONDITION");
    spy.mockRestore();
  });

  it("still logs BOTH per-call lines, so the method names stay distinguishable", async () => {
    bothFail();
    await batchUpsertInAppProducts(jwt, PKG, [createInput()]).catch(() => {});
    const methods = logSpy.mock.calls.map((c) => c[0].method);
    expect(methods).toContain("monetization.onetimeproducts.batchUpdate");
    expect(methods).toContain("inappproducts.batchUpdate");
  });

  it("the per-call error lines carry err_status, not just a message tail", async () => {
    bothFail();
    await batchUpsertInAppProducts(jwt, PKG, [createInput()]).catch(() => {});
    const failed = logSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.outcome === "err");
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.map((e) => e.errStatus)).toContain("PERMISSION_DENIED");
    expect(failed.map((e) => e.errReason)).toContain("forbidden");
  });
});

describe("the legacy fallback still WORKS when it can (unchanged behaviour)", () => {
  it("returns the legacy result and does not throw when only the new API fails", async () => {
    newBatchUpdateSpy.mockRejectedValueOnce(new Error("new API blew up"));
    legacyBatchUpdateSpy.mockResolvedValueOnce({
      data: { inappproducts: [{ sku: "sku.new", status: "active" }] },
    });
    const out = await batchUpsertInAppProducts(jwt, PKG, [createInput()]);
    expect(out).toHaveLength(1);
    expect(out[0].sku).toBe("sku.new");
  });
});

describe("⚠ PARITY — the path that already works is untouched", () => {
  function newApiSucceeds() {
    newBatchUpdateSpy.mockResolvedValueOnce({
      data: {
        oneTimeProducts: [
          {
            productId: "sku.new",
            packageName: "vng.games.lightandnight",
            purchaseOptions: [
              {
                purchaseOptionId: "buy",
                buyOption: { legacyCompatible: true },
                state: "DRAFT",
                regionalPricingAndAvailabilityConfigs: [],
              },
            ],
            listings: [],
          },
        ],
      },
    });
  }

  it("⭐ a clean batch returns its products, exactly as before", async () => {
    newApiSucceeds();
    const out = await batchUpsertInAppProducts(
      jwt,
      "vng.games.lightandnight",
      [createInput()],
    );
    expect(out).toHaveLength(1);
    expect(out[0].sku).toBe("sku.new");
  });

  it("⭐ never touches the legacy resource on the success path", async () => {
    newApiSucceeds();
    await batchUpsertInAppProducts(jwt, "vng.games.lightandnight", [
      createInput(),
    ]);
    expect(legacyBatchUpdateSpy).not.toHaveBeenCalled();
  });

  it("⭐ logs no both-failed line and no error outcome", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    newApiSucceeds();
    await batchUpsertInAppProducts(jwt, "vng.games.lightandnight", [
      createInput(),
    ]);
    expect(
      spy.mock.calls.filter((c) => String(c[0]).includes("BOTH PATHS FAILED")),
    ).toHaveLength(0);
    expect(
      logSpy.mock.calls.map((c) => c[0]).filter((e) => e.outcome === "err"),
    ).toHaveLength(0);
    spy.mockRestore();
  });

  it("⭐ the success log line still carries method/pkg/outcome/dur_ms", async () => {
    newApiSucceeds();
    await batchUpsertInAppProducts(jwt, "vng.games.lightandnight", [
      createInput(),
    ]);
    const entry = logSpy.mock.calls
      .map((c) => c[0])
      .find((e) => e.method === "monetization.onetimeproducts.batchUpdate");
    expect(entry).toMatchObject({
      method: "monetization.onetimeproducts.batchUpdate",
      packageName: "vng.games.lightandnight",
      outcome: "ok",
    });
    expect(typeof entry.durationMs).toBe("number");
  });
});
