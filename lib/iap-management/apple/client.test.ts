/**
 * Endpoint-wrapper payload-shape tests. Mocks iapFetch so the wrappers run
 * without hitting Apple, then asserts on the (method, endpoint, body)
 * arguments the wrapper passes to iapFetch.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as fetchModule from "./fetch";
import {
  createInAppPurchase,
  updateInAppPurchase,
  deleteInAppPurchase,
  createInAppPurchaseLocalization,
  updateInAppPurchaseLocalization,
  reserveInAppPurchaseScreenshot,
  confirmInAppPurchaseScreenshot,
  deleteInAppPurchaseScreenshot,
  submitInAppPurchase,
  listInAppPurchases,
  listAllInAppPurchases,
  getInAppPurchase,
} from "./client";
import type { AscCredentials } from "@/lib/asc-jwt";

vi.mock("./fetch", async () => {
  const actual = await vi.importActual<typeof import("./fetch")>("./fetch");
  return {
    ...actual,
    iapFetch: vi.fn().mockResolvedValue({ data: { id: "stub" } }),
  };
});

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

const iapFetch = fetchModule.iapFetch as Mock;

beforeEach(() => {
  iapFetch.mockClear();
  iapFetch.mockResolvedValue({ data: { id: "stub" } });
});

describe("createInAppPurchase", () => {
  it("POSTs /v2/inAppPurchases with attributes + app relationship", async () => {
    await createInAppPurchase(creds, {
      appId: "12345",
      name: "Diamond Pack S",
      productId: "com.vng.x.diamond_s",
      inAppPurchaseType: "CONSUMABLE",
    });
    expect(iapFetch).toHaveBeenCalledOnce();
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v2/inAppPurchases");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchases",
        attributes: {
          name: "Diamond Pack S",
          productId: "com.vng.x.diamond_s",
          inAppPurchaseType: "CONSUMABLE",
        },
        relationships: {
          app: { data: { type: "apps", id: "12345" } },
        },
      },
    });
  });

  it("omits reviewNote when not provided", async () => {
    await createInAppPurchase(creds, {
      appId: "1",
      name: "n",
      productId: "p",
      inAppPurchaseType: "NON_CONSUMABLE",
    });
    const [, , , body] = iapFetch.mock.calls[0];
    expect((body as { data: { attributes: Record<string, unknown> } }).data.attributes)
      .not.toHaveProperty("reviewNote");
  });

  it("includes reviewNote and familySharable when provided", async () => {
    await createInAppPurchase(creds, {
      appId: "1",
      name: "n",
      productId: "p",
      inAppPurchaseType: "NON_RENEWING_SUBSCRIPTION",
      reviewNote: "see screenshot",
      familySharable: true,
    });
    const [, , , body] = iapFetch.mock.calls[0];
    const attrs = (body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs.reviewNote).toBe("see screenshot");
    expect(attrs.familySharable).toBe(true);
  });
});

describe("updateInAppPurchase", () => {
  it("PATCHes the IAP with only provided attributes", async () => {
    await updateInAppPurchase(creds, "iap-id-1", {
      name: "Renamed",
    });
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("PATCH");
    expect(endpoint).toBe("/v2/inAppPurchases/iap-id-1");
    const attrs = (body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs).toEqual({ name: "Renamed" });
  });

  it("includes familySharable when it's explicitly false (not just truthy)", async () => {
    await updateInAppPurchase(creds, "iap-id-2", { familySharable: false });
    const [, , , body] = iapFetch.mock.calls[0];
    const attrs = (body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs).toEqual({ familySharable: false });
  });
});

describe("deleteInAppPurchase", () => {
  it("DELETEs /v2/inAppPurchases/{id}", async () => {
    await deleteInAppPurchase(creds, "iap-id-9");
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("DELETE");
    expect(endpoint).toBe("/v2/inAppPurchases/iap-id-9");
    expect(body).toBeUndefined();
  });
});

describe("createInAppPurchaseLocalization", () => {
  it("POSTs /v1/inAppPurchaseLocalizations with relationship to V2 IAP", async () => {
    await createInAppPurchaseLocalization(creds, {
      iapId: "iap-id-1",
      locale: "vi",
      name: "Gói Kim Cương",
      description: "Mua 100 kim cương",
    });
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchaseLocalizations");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseLocalizations",
        attributes: {
          locale: "vi",
          name: "Gói Kim Cương",
          description: "Mua 100 kim cương",
        },
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: "iap-id-1" },
          },
        },
      },
    });
  });

  it("omits description when not provided", async () => {
    await createInAppPurchaseLocalization(creds, {
      iapId: "x",
      locale: "ko",
      name: "Korean name",
    });
    const [, , , body] = iapFetch.mock.calls[0];
    const attrs = (body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs).not.toHaveProperty("description");
    expect(attrs).toMatchObject({ locale: "ko", name: "Korean name" });
  });
});

describe("updateInAppPurchaseLocalization", () => {
  it("PATCHes only provided fields", async () => {
    await updateInAppPurchaseLocalization(creds, "loc-1", {
      description: "updated",
    });
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("PATCH");
    expect(endpoint).toBe("/v1/inAppPurchaseLocalizations/loc-1");
    const attrs = (body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs).toEqual({ description: "updated" });
  });
});

describe("reserveInAppPurchaseScreenshot", () => {
  it("POSTs reserve with fileName + fileSize + IAP relationship", async () => {
    await reserveInAppPurchaseScreenshot(creds, "iap-1", "shot.png", 4096);
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchaseAppStoreReviewScreenshots");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        attributes: { fileName: "shot.png", fileSize: 4096 },
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: "iap-1" },
          },
        },
      },
    });
  });
});

describe("confirmInAppPurchaseScreenshot", () => {
  it("PATCHes uploaded:true with sourceFileChecksum", async () => {
    await confirmInAppPurchaseScreenshot(creds, "scr-1", "abc123md5");
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("PATCH");
    expect(endpoint).toBe("/v1/inAppPurchaseAppStoreReviewScreenshots/scr-1");
    expect(body).toMatchObject({
      data: {
        attributes: { uploaded: true, sourceFileChecksum: "abc123md5" },
      },
    });
  });
});

// IAP.o.8a — overwrite path needs to drop a stale screenshot before
// uploading a replacement, since Apple's appStoreReviewScreenshot relationship
// is to-one. The wrapper is a thin DELETE; the orchestration logic lives in
// replaceScreenshotOnApple (see screenshot-upload.test.ts).
describe("deleteInAppPurchaseScreenshot", () => {
  it("DELETEs /v1/inAppPurchaseAppStoreReviewScreenshots/{id} with no body", async () => {
    await deleteInAppPurchaseScreenshot(creds, "scr-99");
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("DELETE");
    expect(endpoint).toBe("/v1/inAppPurchaseAppStoreReviewScreenshots/scr-99");
    expect(body).toBeUndefined();
  });
});

describe("submitInAppPurchase", () => {
  it("POSTs /v1/inAppPurchaseSubmissions with IAP relationship only", async () => {
    await submitInAppPurchase(creds, "iap-99");
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
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
    // No attributes — Apple infers state server-side.
    expect((body as { data: { attributes?: unknown } }).data.attributes)
      .toBeUndefined();
  });
});

describe("listInAppPurchases / getInAppPurchase URL shape", () => {
  it("listInAppPurchases hits the v1 apps/<id>/inAppPurchasesV2 path", async () => {
    await listInAppPurchases(creds, "app-id-1");
    const [, method, endpoint] = iapFetch.mock.calls[0];
    expect(method).toBe("GET");
    expect(endpoint).toBe("/v1/apps/app-id-1/inAppPurchasesV2?limit=200");
  });

  it("getInAppPurchase includes localizations + appStoreReviewScreenshot", async () => {
    await getInAppPurchase(creds, "iap-1");
    const [, , endpoint] = iapFetch.mock.calls[0];
    expect(endpoint).toContain("/v2/inAppPurchases/iap-1");
    expect(endpoint).toContain(
      "include=inAppPurchaseLocalizations,appStoreReviewScreenshot",
    );
  });
});

// IAP.o.7a — Apple's `links.next` pagination wrapper. Single-page legacy
// `listInAppPurchases` truncated at 200, which broke conflict resolution +
// IAP list UI for apps with >200 IAPs (Manager MV30 surfaced 409 ENTITY_ERROR
// + IAP-list truncation). Tests pin the iteration shape, accumulation, and
// terminal conditions so regressions are caught at unit-test time.
describe("listAllInAppPurchases (paginated)", () => {
  function makeIap(id: string, productId: string) {
    return {
      type: "inAppPurchases",
      id,
      attributes: {
        productId,
        name: productId,
        inAppPurchaseType: "CONSUMABLE",
        state: "READY_TO_SUBMIT",
      },
    };
  }

  it("returns single-page data when `links.next` is absent", async () => {
    iapFetch.mockResolvedValueOnce({
      data: [makeIap("1", "p.a"), makeIap("2", "p.b")],
    });

    const res = await listAllInAppPurchases(creds, "app-id-1");
    expect(res.data).toHaveLength(2);
    expect(res.data.map((d) => d.id)).toEqual(["1", "2"]);
    expect(iapFetch).toHaveBeenCalledOnce();
    const [, method, endpoint] = iapFetch.mock.calls[0];
    expect(method).toBe("GET");
    expect(endpoint).toBe("/v1/apps/app-id-1/inAppPurchasesV2?limit=200");
  });

  it("accumulates across two pages and stops when `links.next` clears", async () => {
    iapFetch
      .mockResolvedValueOnce({
        data: [makeIap("1", "p.a"), makeIap("2", "p.b")],
        links: {
          self: "https://api.appstoreconnect.apple.com/v1/apps/app-id-1/inAppPurchasesV2?limit=200",
          next: "https://api.appstoreconnect.apple.com/v1/apps/app-id-1/inAppPurchasesV2?cursor=PAGE2&limit=200",
        },
      })
      .mockResolvedValueOnce({
        data: [makeIap("3", "p.c")],
        // No `links.next` → terminate
      });

    const res = await listAllInAppPurchases(creds, "app-id-1");
    expect(res.data).toHaveLength(3);
    expect(res.data.map((d) => d.id)).toEqual(["1", "2", "3"]);
    expect(iapFetch).toHaveBeenCalledTimes(2);

    // Page 2 call uses the path+query extracted from Apple's absolute URL.
    const [, method2, endpoint2] = iapFetch.mock.calls[1];
    expect(method2).toBe("GET");
    expect(endpoint2).toBe("/v1/apps/app-id-1/inAppPurchasesV2?cursor=PAGE2&limit=200");
  });

  it("accumulates across three pages", async () => {
    iapFetch
      .mockResolvedValueOnce({
        data: [makeIap("1", "p.a")],
        links: {
          self: "https://api.appstoreconnect.apple.com/v1/apps/app/inAppPurchasesV2?limit=200",
          next: "https://api.appstoreconnect.apple.com/v1/apps/app/inAppPurchasesV2?cursor=P2",
        },
      })
      .mockResolvedValueOnce({
        data: [makeIap("2", "p.b"), makeIap("3", "p.c")],
        links: {
          self: "https://api.appstoreconnect.apple.com/v1/apps/app/inAppPurchasesV2?cursor=P2",
          next: "https://api.appstoreconnect.apple.com/v1/apps/app/inAppPurchasesV2?cursor=P3",
        },
      })
      .mockResolvedValueOnce({
        data: [makeIap("4", "p.d")],
      });

    const res = await listAllInAppPurchases(creds, "app");
    expect(res.data).toHaveLength(4);
    expect(iapFetch).toHaveBeenCalledTimes(3);
    // Page 3 call uses path-and-query stripped from absolute URL.
    expect(iapFetch.mock.calls[2][2]).toBe(
      "/v1/apps/app/inAppPurchasesV2?cursor=P3",
    );
  });

  it("returns empty data when first page is empty (no IAPs registered)", async () => {
    iapFetch.mockResolvedValueOnce({ data: [] });

    const res = await listAllInAppPurchases(creds, "empty-app");
    expect(res.data).toEqual([]);
    expect(iapFetch).toHaveBeenCalledOnce();
  });

  it("tolerates missing `data` field on page response without crashing", async () => {
    iapFetch.mockResolvedValueOnce({});

    const res = await listAllInAppPurchases(creds, "weird-app");
    expect(res.data).toEqual([]);
  });

  it("terminates when `links.next` is malformed (not a parseable URL)", async () => {
    iapFetch.mockResolvedValueOnce({
      data: [makeIap("1", "p.a")],
      links: {
        self: "https://api.appstoreconnect.apple.com/...",
        next: "not-a-url-at-all",
      },
    });

    const res = await listAllInAppPurchases(creds, "app");
    expect(res.data).toHaveLength(1);
    // No infinite loop: only the first call fires.
    expect(iapFetch).toHaveBeenCalledOnce();
  });

  it("aggregate response drops per-page `links` and `meta`", async () => {
    iapFetch.mockResolvedValueOnce({
      data: [makeIap("1", "p.a")],
      links: { self: "x" },
      meta: { paging: { total: 1, limit: 200 } },
    });

    const res = await listAllInAppPurchases(creds, "app");
    expect(res.links).toBeUndefined();
    expect(res.meta).toBeUndefined();
  });
});
