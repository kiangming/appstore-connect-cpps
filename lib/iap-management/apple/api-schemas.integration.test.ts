/**
 * IAP.o.9d — Apple API schema integration tests.
 *
 * Pins the request URL + method + body shape for every Apple endpoint the
 * Manager workflow hits. The IAP.o.6 → IAP.o.9 hotfix cycle traced every
 * recurring "feature not working" report to a payload-shape mismatch between
 * code and Apple's actual schema; this file is the contract enforcement
 * layer to prevent the cycle from recurring.
 *
 * Strategy: mock `iapFetch` to capture each call, then drive each public
 * wrapper end-to-end and assert the captured args match the documented
 * Apple schema exactly. When Apple's docs change, expect this file to fail
 * first — that's the point.
 *
 * Apple Docs cross-reference (see docs/iap-management/apple-api-reference.md
 * for the full table + URLs).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AscCredentials } from "@/lib/asc-jwt";

const iapFetch = vi.hoisted(() => vi.fn());

vi.mock("./fetch", () => ({
  iapFetch,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  AppleApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, _m: string, _e: string, body: string) {
      super(body);
      this.status = status;
      this.body = body;
    }
  },
}));

import {
  createInAppPurchase,
  updateInAppPurchase,
  deleteInAppPurchase,
  getInAppPurchase,
  listInAppPurchases,
  createInAppPurchaseLocalization,
  updateInAppPurchaseLocalization,
  reserveInAppPurchaseScreenshot,
  confirmInAppPurchaseScreenshot,
  deleteInAppPurchaseScreenshot,
  submitInAppPurchase,
} from "./client";
import {
  listPricePointsForIap,
  findPricePointByUsdPrice,
  type InAppPurchasePricePoint,
} from "./price-points";
import { setPriceSchedule, getPriceScheduleForIap } from "./price-schedules";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

beforeEach(() => {
  iapFetch.mockReset();
  iapFetch.mockResolvedValue({ data: { id: "stub", type: "stub" } });
});

function callArgs() {
  const [, method, endpoint, body] = iapFetch.mock.calls[0];
  return { method, endpoint, body };
}

// ─── IAP CRUD ────────────────────────────────────────────────────────────────

describe("API schema: IAP CRUD endpoints", () => {
  it("list IAPs → GET /v1/apps/{id}/inAppPurchasesV2?limit=200", async () => {
    await listInAppPurchases(creds, "app-1");
    expect(callArgs()).toMatchObject({
      method: "GET",
      endpoint: "/v1/apps/app-1/inAppPurchasesV2?limit=200",
    });
  });

  it("get IAP → GET /v2/inAppPurchases/{id} with localizations + appStoreReviewScreenshot include", async () => {
    await getInAppPurchase(creds, "iap-1");
    const { method, endpoint } = callArgs();
    expect(method).toBe("GET");
    expect(endpoint).toContain("/v2/inAppPurchases/iap-1");
    expect(endpoint).toContain(
      "include=inAppPurchaseLocalizations,appStoreReviewScreenshot",
    );
  });

  it("create IAP → POST /v2/inAppPurchases with app relationship", async () => {
    await createInAppPurchase(creds, {
      appId: "app-1",
      name: "Diamonds",
      productId: "com.x.diamonds",
      inAppPurchaseType: "CONSUMABLE",
    });
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v2/inAppPurchases");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchases",
        attributes: {
          name: "Diamonds",
          productId: "com.x.diamonds",
          inAppPurchaseType: "CONSUMABLE",
        },
        relationships: {
          app: { data: { type: "apps", id: "app-1" } },
        },
      },
    });
  });

  it("update IAP → PATCH /v2/inAppPurchases/{id}", async () => {
    await updateInAppPurchase(creds, "iap-1", { name: "Renamed" });
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("PATCH");
    expect(endpoint).toBe("/v2/inAppPurchases/iap-1");
    expect(body).toMatchObject({
      data: { type: "inAppPurchases", id: "iap-1", attributes: { name: "Renamed" } },
    });
  });

  it("delete IAP → DELETE /v2/inAppPurchases/{id}", async () => {
    await deleteInAppPurchase(creds, "iap-9");
    expect(callArgs()).toMatchObject({
      method: "DELETE",
      endpoint: "/v2/inAppPurchases/iap-9",
    });
  });
});

// ─── Localizations ───────────────────────────────────────────────────────────

describe("API schema: localization endpoints", () => {
  it("create loc → POST /v1/inAppPurchaseLocalizations with inAppPurchaseV2 rel", async () => {
    await createInAppPurchaseLocalization(creds, {
      iapId: "iap-1",
      locale: "vi",
      name: "Kim cương",
      description: "Mô tả",
    });
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchaseLocalizations");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseLocalizations",
        attributes: { locale: "vi", name: "Kim cương", description: "Mô tả" },
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: "iap-1" },
          },
        },
      },
    });
  });

  it("update loc → PATCH /v1/inAppPurchaseLocalizations/{id}", async () => {
    await updateInAppPurchaseLocalization(creds, "loc-1", { name: "New" });
    expect(callArgs()).toMatchObject({
      method: "PATCH",
      endpoint: "/v1/inAppPurchaseLocalizations/loc-1",
    });
  });
});

// ─── Screenshots (appStoreReviewScreenshot family, IAP.o.9b fix) ────────────

describe("API schema: screenshot endpoints (appStoreReviewScreenshot family)", () => {
  it("reserve → POST /v1/inAppPurchaseAppStoreReviewScreenshots with inAppPurchaseV2 rel", async () => {
    await reserveInAppPurchaseScreenshot(creds, "iap-1", "x.png", 1234);
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchaseAppStoreReviewScreenshots");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        attributes: { fileName: "x.png", fileSize: 1234 },
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: "iap-1" },
          },
        },
      },
    });
  });

  it("confirm → PATCH /v1/inAppPurchaseAppStoreReviewScreenshots/{id} with uploaded:true + MD5", async () => {
    await confirmInAppPurchaseScreenshot(creds, "scr-1", "deadbeef");
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("PATCH");
    expect(endpoint).toBe("/v1/inAppPurchaseAppStoreReviewScreenshots/scr-1");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        id: "scr-1",
        attributes: { uploaded: true, sourceFileChecksum: "deadbeef" },
      },
    });
  });

  it("delete → DELETE /v1/inAppPurchaseAppStoreReviewScreenshots/{id}", async () => {
    await deleteInAppPurchaseScreenshot(creds, "scr-9");
    expect(callArgs()).toMatchObject({
      method: "DELETE",
      endpoint: "/v1/inAppPurchaseAppStoreReviewScreenshots/scr-9",
    });
  });
});

// ─── Pricing (IAP.o.9a) ──────────────────────────────────────────────────────

describe("API schema: pricing endpoints", () => {
  it("list price points → GET /v2/inAppPurchases/{id}/pricePoints?filter[territory]=USA&limit=1000 (IAP.o.11a)", async () => {
    iapFetch.mockResolvedValueOnce({ data: [] });
    await listPricePointsForIap(creds, "iap-1", "USA");
    const { method, endpoint } = callArgs();
    expect(method).toBe("GET");
    expect(endpoint).toBe(
      "/v2/inAppPurchases/iap-1/pricePoints?filter[territory]=USA&limit=1000",
    );
  });

  it("set schedule → POST /v1/inAppPurchasePriceSchedules with manual price + included pairing", async () => {
    iapFetch.mockResolvedValueOnce({ data: { id: "sched-1", type: "x" } });
    await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-5",
    });
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchasePriceSchedules");

    const payload = body as {
      data: {
        type: string;
        relationships: {
          inAppPurchase: { data: { type: string; id: string } };
          baseTerritory: { data: { type: string; id: string } };
          manualPrices: { data: Array<{ type: string; id: string }> };
        };
      };
      included: Array<{
        type: string;
        id: string;
        attributes: { startDate: null };
        relationships: {
          inAppPurchasePricePoint: { data: { type: string; id: string } };
          inAppPurchaseV2: { data: { type: string; id: string } };
        };
      }>;
    };
    expect(payload.data.type).toBe("inAppPurchasePriceSchedules");
    expect(payload.data.relationships.inAppPurchase.data).toEqual({
      type: "inAppPurchases",
      id: "iap-1",
    });
    expect(payload.data.relationships.baseTerritory.data).toEqual({
      type: "territories",
      id: "USA",
    });
    expect(payload.data.relationships.manualPrices.data).toHaveLength(1);
    // CRITICAL: the manualPrices.data[].id must equal the included[].id —
    // Apple uses this to link the primary relationship to the side-loaded
    // resource. Mis-pairing silently breaks the schedule POST.
    const refId = payload.data.relationships.manualPrices.data[0].id;
    expect(payload.included).toHaveLength(1);
    expect(payload.included[0].id).toBe(refId);
    expect(payload.included[0].type).toBe("inAppPurchasePrices");
    expect(payload.included[0].attributes.startDate).toBeNull();
    expect(payload.included[0].relationships.inAppPurchasePricePoint.data).toEqual({
      type: "inAppPurchasePricePoints",
      id: "pp-5",
    });
    // Apple uses `inAppPurchaseV2` inside `included` (vs `inAppPurchase` at
    // the top level) — a known gotcha; pinning here so a stray rename
    // breaks at test time, not at Manager UAT time.
    expect(payload.included[0].relationships.inAppPurchaseV2.data).toEqual({
      type: "inAppPurchases",
      id: "iap-1",
    });

    // IAP.o.11d: Apple rejects plain UUIDs with
    // ENTITY_ERROR.INCLUDED.INVALID_ID — required format is "${...}" lid.
    expect(refId).toMatch(/^\$\{.+\}$/);
  });

  /**
   * Per-stage helpers + reusable Stage 1 / 2 / 3 fixtures.
   *
   * Call ordering when manualPrices.length ≥ 1 AND baseTerritory is set
   * (the common case): Stage 1 → [Stage 2, Stage 3] in parallel. The
   * Stage 2/3 calls are *initiated* in code order (Stage 2 first), so
   * `iapFetch.mock.calls` indices [1] = Stage 2 page 1, [2] = Stage 3
   * (and [3+] = Stage 2 subsequent pages if pagination kicks in).
   */
  function stage1Response(opts: {
    scheduleId?: string;
    manualPriceIds?: string[];
    baseTerritory?: string | null;
  }) {
    const baseTerritory =
      opts.baseTerritory === null ? undefined : opts.baseTerritory ?? "USA";
    return {
      data: {
        id: opts.scheduleId ?? "sched-1",
        type: "inAppPurchasePriceSchedules",
        relationships: {
          ...(baseTerritory
            ? {
                baseTerritory: {
                  data: { type: "territories", id: baseTerritory },
                },
              }
            : {}),
          manualPrices: {
            data: (opts.manualPriceIds ?? []).map((id) => ({
              type: "inAppPurchasePrices",
              id,
            })),
          },
        },
      },
    };
  }

  it("get schedule Stage 1 → GET /v2/inAppPurchases/{id}/iapPriceSchedule with top-level includes only (IAP.p2.j)", async () => {
    // IAP.p2.i: path segment is the relationship NAME (`iapPriceSchedule`),
    // not the resource TYPE (`inAppPurchasePriceSchedule`).
    // IAP.p2.j: Apple enforces a strict include whitelist —
    // `baseTerritory,manualPrices,automaticPrices` only (per OpenAPI
    // operationId `inAppPurchasesV2_iapPriceSchedule_getToOneRelated`).
    // Nested includes return Apple 400 `PARAMETER_ERROR.INVALID`.
    iapFetch.mockResolvedValueOnce(
      stage1Response({ manualPriceIds: [], baseTerritory: null }),
    );
    await getPriceScheduleForIap(creds, "iap-1");
    const { method, endpoint } = callArgs();
    expect(method).toBe("GET");
    expect(endpoint).toBe(
      "/v2/inAppPurchases/iap-1/iapPriceSchedule?include=baseTerritory,manualPrices&limit[manualPrices]=50",
    );
  });

  it("get schedule Stage 2 → GET /v1/inAppPurchasePriceSchedules/{scheduleId}/manualPrices with deep include (IAP.p2.j)", async () => {
    // Stage 2 fires when Stage 1 returns ≥1 manualPrice. Endpoint per
    // OpenAPI operationId `inAppPurchasePriceSchedules_manualPrices_getToManyRelated`
    // accepts `include=inAppPurchasePricePoint,territory` (direct
    // relationships on InAppPurchasePrice — no nesting).
    iapFetch
      .mockResolvedValueOnce(
        stage1Response({
          scheduleId: "sched-42",
          manualPriceIds: ["p-1"],
          baseTerritory: null,
        }),
      )
      // Stage 2 returns p-1 (matches Stage 1 manualPriceIds → no recovery).
      .mockResolvedValueOnce({
        data: [{ type: "inAppPurchasePrices", id: "p-1" }],
      });

    await getPriceScheduleForIap(creds, "iap-1");
    expect(iapFetch.mock.calls.length).toBe(2);
    const [, method2, endpoint2] = iapFetch.mock.calls[1];
    expect(method2).toBe("GET");
    expect(endpoint2).toBe(
      "/v1/inAppPurchasePriceSchedules/sched-42/manualPrices?include=inAppPurchasePricePoint,territory&limit=200",
    );
  });

  it("get schedule short-circuits Stage 2 when Stage 1 has no manualPrices (IAP.p2.j)", async () => {
    iapFetch.mockResolvedValueOnce(
      stage1Response({ manualPriceIds: [], baseTerritory: null }),
    );
    await getPriceScheduleForIap(creds, "iap-1");
    expect(iapFetch.mock.calls.length).toBe(1);
  });

  it("get schedule follows links.next when Stage 2 paginates — absolute URL (IAP.p2.l)", async () => {
    // Manager UAT MV30: 11-row schedule lost the alphabetically-last
    // entry because Apple paginated and our links.next follow was
    // brittle. URL-parser approach handles both absolute + relative.
    // The manualPriceIds match the data returned so the recovery step
    // doesn't fire — this test is isolated to pagination.
    iapFetch
      .mockResolvedValueOnce(
        stage1Response({
          scheduleId: "sched-99",
          manualPriceIds: ["p-1", "p-2"],
          baseTerritory: null,
        }),
      )
      .mockResolvedValueOnce({
        data: [{ type: "inAppPurchasePrices", id: "p-1" }],
        links: {
          next: "https://api.appstoreconnect.apple.com/v1/inAppPurchasePriceSchedules/sched-99/manualPrices?cursor=PAGE2",
        },
      })
      .mockResolvedValueOnce({
        data: [{ type: "inAppPurchasePrices", id: "p-2" }],
      });

    await getPriceScheduleForIap(creds, "iap-1");
    expect(iapFetch.mock.calls.length).toBe(3);
    const [, , endpoint3] = iapFetch.mock.calls[2];
    expect(endpoint3).toBe(
      "/v1/inAppPurchasePriceSchedules/sched-99/manualPrices?cursor=PAGE2",
    );
  });

  it("get schedule follows links.next when Stage 2 paginates — relative URL (IAP.p2.l)", async () => {
    iapFetch
      .mockResolvedValueOnce(
        stage1Response({
          scheduleId: "sched-99",
          manualPriceIds: ["p-1"],
          baseTerritory: null,
        }),
      )
      .mockResolvedValueOnce({
        data: [{ type: "inAppPurchasePrices", id: "p-1" }],
        links: { next: "/v1/inAppPurchasePriceSchedules/sched-99/manualPrices?cursor=REL" },
      })
      .mockResolvedValueOnce({ data: [] });

    await getPriceScheduleForIap(creds, "iap-1");
    expect(iapFetch.mock.calls.length).toBe(3);
    const [, , endpoint3] = iapFetch.mock.calls[2];
    expect(endpoint3).toBe(
      "/v1/inAppPurchasePriceSchedules/sched-99/manualPrices?cursor=REL",
    );
  });

  it("get schedule respects MAX_STAGE2_PAGES safety cap (IAP.p2.l)", async () => {
    // Bounded loop guard against malformed cursors that link back to
    // themselves. Stage 1 + 20 Stage 2 pages = 21 total calls; we stop
    // after page 20 even if Apple keeps offering `links.next`.
    iapFetch.mockResolvedValueOnce(
      stage1Response({
        scheduleId: "sched-loop",
        manualPriceIds: ["p-1"],
        baseTerritory: null,
      }),
    );
    // Every Stage 2 page returns a next link → forces hitting the cap.
    // Each page returns p-1 so the recovery step doesn't trigger.
    for (let i = 0; i < 25; i++) {
      iapFetch.mockResolvedValueOnce({
        data: [{ type: "inAppPurchasePrices", id: "p-1" }],
        links: { next: `/v1/inAppPurchasePriceSchedules/sched-loop/manualPrices?cursor=LOOP${i}` },
      });
    }

    await getPriceScheduleForIap(creds, "iap-1");
    // 1 Stage-1 + 20 Stage-2 pages (cap MAX_STAGE2_PAGES).
    expect(iapFetch.mock.calls.length).toBe(21);
  });

  // ── IAP.p2.m — Stage 1 truncation tolerance ────────────────────────────
  it("get schedule succeeds when Stage 1's manualRel is truncated by Apple (IAP.p2.m)", async () => {
    // Manager UAT MV30 Railway logs: Apple's V2
    // `/iapPriceSchedule?include=manualPrices` returns only 10 of 12
    // manualPrice IDs even with `limit[manualPrices]=50` requested.
    // Stage 2 returns the full 12. The fetcher does NOT trust Stage 1's
    // manualRel as canonical — it just gates on `manualRefs.length > 0`
    // and lets Stage 2's data flow through. The unpacker (tested
    // separately in iap-detail.test) iterates Stage 2's prices, not
    // Stage 1's manualRel.
    iapFetch
      .mockResolvedValueOnce(
        stage1Response({
          scheduleId: "sched-trunc",
          // Stage 1 enumerates only 10 IDs — truncated by Apple.
          manualPriceIds: Array.from({ length: 10 }, (_, i) => `p-${i + 1}`),
          baseTerritory: null,
        }),
      )
      // Stage 2 returns the full 12 (including the 2 IDs missing from
      // Stage 1's enumeration).
      .mockResolvedValueOnce({
        data: Array.from({ length: 12 }, (_, i) => ({
          type: "inAppPurchasePrices",
          id: `p-${i + 1}`,
        })),
        meta: { paging: { total: 12, limit: 200 } },
      });

    const out = await getPriceScheduleForIap(creds, "iap-1");
    // Stage 1 + Stage 2 only (no recovery — that strategy was removed
    // since Stage 1's manualRel can't be trusted as canonical).
    expect(iapFetch.mock.calls.length).toBe(2);
    // All 12 prices made it through the merge.
    const prices = (out.included ?? []).filter(
      (r) => r.type === "inAppPurchasePrices",
    );
    expect(prices).toHaveLength(12);
  });
});

// ─── IAP.o.10a — customerPrice match across Apple's 2024 tier rollover ──────

describe("API schema: customerPrice matching (IAP.o.10a)", () => {
  // Apple's developer forum thread 728081 confirmed priceTier numbering
  // changed from "1, 2, 3..." to "10000, 10001, ..." in 2024, with some
  // legacy IAPs still on the old numbering. customerPrice is the only
  // stable join key — pin this contract here.

  const mixed: InAppPurchasePricePoint[] = [
    {
      type: "inAppPurchasePricePoints",
      id: "pp-new-099",
      attributes: { customerPrice: "0.99", proceeds: "0.7", priceTier: "10000" },
    },
    {
      type: "inAppPurchasePricePoints",
      id: "pp-legacy-099",
      attributes: { customerPrice: "0.99", proceeds: "0.7", priceTier: "1" },
    },
    {
      type: "inAppPurchasePricePoints",
      id: "pp-new-499",
      attributes: { customerPrice: "4.99", proceeds: "3.49", priceTier: "10004" },
    },
  ];

  it("matches USD 0.99 on Apple's new (10000+) priceTier numbering", () => {
    expect(findPricePointByUsdPrice(mixed, 0.99)?.id).toBe("pp-new-099");
  });

  it("matches USD 4.99 to the only Apple price point at that price", () => {
    expect(findPricePointByUsdPrice(mixed, 4.99)?.id).toBe("pp-new-499");
  });

  it("surfaces null (NOT a silent match) when USD price has no Apple counterpart", () => {
    // Manager's IAP.o.9a → IAP.o.10a root cause: silent null caused the
    // pricing POST to skip. The orchestration test layer asserts the result
    // surfaces as skipped-no-match — this test pins the contract at the
    // matcher level so a regression can't reintroduce a silent fallthrough.
    expect(findPricePointByUsdPrice(mixed, 99.99)).toBeNull();
  });
});

// ─── Submit ──────────────────────────────────────────────────────────────────

describe("API schema: submit endpoint", () => {
  it("submit → POST /v1/inAppPurchaseSubmissions with inAppPurchaseV2 rel only", async () => {
    await submitInAppPurchase(creds, "iap-99");
    const { method, endpoint, body } = callArgs();
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchaseSubmissions");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseSubmissions",
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: "iap-99" } },
        },
      },
    });
    const payload = body as { data: { attributes?: unknown } };
    expect(payload.data.attributes).toBeUndefined();
  });
});
