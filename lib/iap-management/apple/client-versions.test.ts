/**
 * Endpoint-wrapper payload-shape tests for the v2 submit migration's
 * version helpers — mirrors client.test.ts's style (mock iapFetch, assert
 * on method/endpoint/body).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as fetchModule from "./fetch";
import { listInAppPurchaseVersions, createInAppPurchaseVersion } from "./client";
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

describe("listInAppPurchaseVersions", () => {
  it("GETs /v2/inAppPurchases/{id}/versions", async () => {
    await listInAppPurchaseVersions(creds, "iap-1");
    expect(iapFetch).toHaveBeenCalledWith(creds, "GET", "/v2/inAppPurchases/iap-1/versions");
  });
});

describe("createInAppPurchaseVersion (rare defensive fallback)", () => {
  it("POSTs /v1/inAppPurchaseVersions with only the inAppPurchase relationship (no attributes — Apple assigns them server-side)", async () => {
    await createInAppPurchaseVersion(creds, "iap-1");
    expect(iapFetch).toHaveBeenCalledWith(creds, "POST", "/v1/inAppPurchaseVersions", {
      data: {
        type: "inAppPurchaseVersions",
        relationships: {
          inAppPurchase: { data: { type: "inAppPurchases", id: "iap-1" } },
        },
      },
    });
  });
});
