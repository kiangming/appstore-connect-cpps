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
  submitInAppPurchase,
  listInAppPurchases,
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
    expect(endpoint).toBe("/v1/inAppPurchaseReviewScreenshots");
    expect(body).toMatchObject({
      data: {
        type: "inAppPurchaseReviewScreenshots",
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
    expect(endpoint).toBe("/v1/inAppPurchaseReviewScreenshots/scr-1");
    expect(body).toMatchObject({
      data: {
        attributes: { uploaded: true, sourceFileChecksum: "abc123md5" },
      },
    });
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

  it("getInAppPurchase includes localizations + reviewScreenshot", async () => {
    await getInAppPurchase(creds, "iap-1");
    const [, , endpoint] = iapFetch.mock.calls[0];
    expect(endpoint).toContain("/v2/inAppPurchases/iap-1");
    expect(endpoint).toContain("include=inAppPurchaseLocalizations,reviewScreenshot");
  });
});
