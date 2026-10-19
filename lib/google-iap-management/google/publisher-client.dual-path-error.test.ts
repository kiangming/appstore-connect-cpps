/**
 * ⭐ Q8 (H4.2) — the batch upsert has NO legacy fallback; and ⭐ O1 — where a
 * fallback remains (the five single-item sites, until D4), when BOTH the new
 * API and the legacy fallback fail, BOTH are kept.
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
 * ⚠ H4.2: the batch site no longer has a fallback at all (Manager Q8) — the
 *   first block pins THAT, for a 403, a 503 and a plain Error alike (a
 *   fallback restored "only for transient 5xx" is caught too). The other
 *   five sites keep their fallback (D4); the O1 block pins `throwBothFailed`
 *   through one of them (getInAppProduct) — every one of the five ends in
 *   that same function, so one site carries the bar for all.
 *
 * ⚠ MUTATION BAR. Restoring a legacy fallback on the batch path, or making
 * `throwBothFailed` rethrow only the new API's error, must turn this file
 * RED. The O1 assertions are written against the THROWN VALUE, not against
 * a log spy, so a site that merely logs both and still throws one is caught.
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
  legacyGetSpy,
  logSpy,
} = vi.hoisted(() => ({
  getProductSpy: vi.fn(),
  newBatchUpdateSpy: vi.fn(),
  batchActivateSpy: vi.fn(),
  legacyBatchUpdateSpy: vi.fn(),
  legacyGetSpy: vi.fn(),
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
      inappproducts: { batchUpdate: legacyBatchUpdateSpy, get: legacyGetSpy },
    }),
  },
}));
vi.mock("./logging", () => ({ logPublisherCall: logSpy }));
vi.mock("google-auth-library", () => ({ JWT: class {} }));

import { batchUpsertInAppProducts, getInAppProduct } from "./publisher-client";
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
  legacyGetSpy.mockReset();
  logSpy.mockReset();
  batchActivateSpy.mockResolvedValue({ data: {} });
});

/**
 * ⭐ H4.2 — Manager Q8 (2026-10-17): the BATCH path has NO legacy fallback.
 * Its `inappproducts.batchUpdate` resend was a second, silent pricing path
 * (different rules: it demands defaultPrice in the app's currency). A
 * new-API error now reaches the caller as itself — verbatim and structured —
 * and the legacy resource is never called, even when it would succeed.
 * (Before H4.2 this block pinned the both-failed GoogleDualPathError of that
 * fallback; the five single-item fallbacks keep it until chunk D4.)
 */
describe("⭐ H4.2 / Q8 — the batch upsert has no legacy fallback", () => {
  it("⭐ v3 fails ⇒ the v3 error ITSELF is thrown, and inappproducts.batchUpdate is called 0 times — even if it would succeed", async () => {
    const v3err = permissionDenied("The caller does not have permission");
    newBatchUpdateSpy.mockRejectedValueOnce(v3err);
    legacyBatchUpdateSpy.mockResolvedValue({ data: { inappproducts: [{ sku: "sku.new", status: "active" }] } });
    const err = await rejectionOf(batchUpsertInAppProducts(jwt, PKG, [createInput()]));
    expect(err).toBe(v3err);
    expect(err).not.toBeInstanceOf(GoogleDualPathError);
    expect(legacyBatchUpdateSpy).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["a transient 503", () => Object.assign(new Error("Service unavailable"), { code: 503, response: { status: 503, data: { error: { code: 503, message: "Service unavailable", status: "UNAVAILABLE" } } } })],
    ["a plain Error with no code", () => new Error("socket hang up")],
  ])("⭐ %s ⇒ still the v3 error itself, still 0 legacy calls (no fallback on ANY failure)", async (_label, make) => {
    const v3err = make();
    newBatchUpdateSpy.mockRejectedValueOnce(v3err);
    legacyBatchUpdateSpy.mockResolvedValue({ data: { inappproducts: [{ sku: "sku.new", status: "active" }] } });
    const err = await rejectionOf(batchUpsertInAppProducts(jwt, PKG, [createInput()]));
    expect(err).toBe(v3err);
    expect(legacyBatchUpdateSpy).toHaveBeenCalledTimes(0);
  });

  it("⚠ the thrown error keeps its structure: code 403, status, reasons, details — so the execute route answers 403 with them", async () => {
    newBatchUpdateSpy.mockRejectedValueOnce(permissionDenied("The caller does not have permission"));
    const err = (await rejectionOf(batchUpsertInAppProducts(jwt, PKG, [createInput()]))) as unknown as {
      code: number;
      response: { data: { error: { status: string; errors: Array<{ reason: string }>; details: Array<{ metadata: { permission: string } }> } } };
    };
    expect(err.code).toBe(403);
    expect(err.response.data.error.status).toBe("PERMISSION_DENIED");
    expect(err.response.data.error.errors[0].reason).toBe("forbidden");
    expect(err.response.data.error.details[0].metadata.permission).toBe("androidpublisher.inappproducts.update");
  });

  it("logs ONE per-call error line, for the new API only, with err_status — no both-failed line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    newBatchUpdateSpy.mockRejectedValueOnce(permissionDenied("The caller does not have permission"));
    await batchUpsertInAppProducts(jwt, PKG, [createInput()]).catch(() => {});
    const failed = logSpy.mock.calls.map((c) => c[0]).filter((e) => e.outcome === "err");
    expect(failed.map((e) => e.method)).toEqual(["monetization.onetimeproducts.batchUpdate"]);
    expect(failed[0].errStatus).toBe("PERMISSION_DENIED");
    expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("BOTH PATHS FAILED"))).toBe(false);
    spy.mockRestore();
  });
});

/**
 * ⭐ O1 — kept on a SURVIVING fallback site. Before H4.2 this bar lived on
 * the batch path; Q8 deleted that fallback, and with it the only behavioural
 * test of `throwBothFailed`, which list/get/insert/patch/delete still end
 * in. getInAppProduct carries it until D4 removes those fallbacks.
 */
describe("⭐ O1 (on getInAppProduct) — both paths failed: the fallback's error is no longer deleted", () => {
  /** ⚠ Fresh Error instances per attempt (feedback_vitest_mock_rejected). */
  function bothFail() {
    getProductSpy.mockRejectedValueOnce(permissionDenied("The caller does not have permission"));
    legacyGetSpy.mockRejectedValueOnce(
      permissionDenied("Please migrate to the new publishing API.", "FAILED_PRECONDITION"),
    );
  }

  it("⭐ throws a GoogleDualPathError carrying BOTH halves structurally, code 403 kept", async () => {
    bothFail();
    const err = await rejectionOf(getInAppProduct(jwt, PKG, "sku.x"));
    expect(err).toBeInstanceOf(GoogleDualPathError);
    expect(err.message).toContain("The caller does not have permission");
    expect(err.message).toContain("Please migrate to the new publishing API.");
    expect(err.primary.status).toBe("PERMISSION_DENIED");
    expect(err.fallback.status).toBe("FAILED_PRECONDITION");
    expect(err.fallback.httpStatus).toBe(403);
    expect(err.code).toBe(403);
  });

  it("logs ONE both-failed line carrying both statuses", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    bothFail();
    await getInAppProduct(jwt, PKG, "sku.x").catch(() => {});
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("BOTH PATHS FAILED"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("op=get");
    expect(lines[0]).toContain("new_api_err_status=PERMISSION_DENIED");
    expect(lines[0]).toContain("legacy_err_status=FAILED_PRECONDITION");
    spy.mockRestore();
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
