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
  // ⚠ `mockReset`, NOT `mockClear`. `mockClear` wipes call history but leaves
  // QUEUED `mockResolvedValueOnce` values in place, so a test that queues three
  // and consumes one leaks the other two into whatever runs next. That is
  // invisible while everything passes and turns a mutation run into noise: the
  // first broken test poisons its neighbours and three files go red for a
  // reason that has nothing to do with the mutation.
  iapFetch.mockReset();
  iapFetch.mockResolvedValue({ data: { id: "stub" } });
});

const version = (id: string, state: string) => ({
  id,
  type: "inAppPurchaseVersions",
  attributes: { state },
});

describe("listInAppPurchaseVersions", () => {
  it("GETs /v2/inAppPurchases/{id}/versions with an EXPLICIT limit", async () => {
    // ⚠ The limit is stated because OAS 4.4.1 declares a `maximum` but NO
    // `default` for it (`…/versions/get/parameters/5/schema`) — omitting it
    // means Apple's undocumented page size silently becomes the ceiling.
    iapFetch.mockResolvedValue({ data: [] });
    await listInAppPurchaseVersions(creds, "iap-1");
    expect(iapFetch).toHaveBeenCalledWith(
      creds,
      "GET",
      "/v2/inAppPurchases/iap-1/versions?limit=200",
    );
  });

  it("returns complete:true with the rows when Apple answers in one page", async () => {
    iapFetch.mockResolvedValue({ data: [version("v1", "APPROVED")] });
    const listing = await listInAppPurchaseVersions(creds, "iap-1");
    expect(listing.complete).toBe(true);
    expect(listing.versions.map((v) => v.id)).toEqual(["v1"]);
  });

  it("⭐⭐ a DRAFT on the LAST page is still found — links.next is followed to the end", async () => {
    // This is the whole chunk in one assertion. Before the fix the call sent no
    // `limit` and never read `links.next`, so a draft sitting past page 1 was
    // invisible — and invisible here does not mean "stale data", it means
    // `resolveWriteTargetVersion` sees no draft and POSTs a version that has
    // no DELETE, onto a product that already had one.
    iapFetch
      .mockResolvedValueOnce({
        data: [version("v1", "APPROVED"), version("v2", "REPLACED_WITH_NEW_VERSION")],
        links: { next: "https://api.appstoreconnect.apple.com/v2/inAppPurchases/iap-1/versions?limit=200&cursor=AQ" },
      })
      .mockResolvedValueOnce({
        data: [version("v3", "REPLACED_WITH_NEW_VERSION")],
        links: { next: "https://api.appstoreconnect.apple.com/v2/inAppPurchases/iap-1/versions?limit=200&cursor=AR" },
      })
      .mockResolvedValueOnce({ data: [version("v-draft", "PREPARE_FOR_SUBMISSION")] });

    const listing = await listInAppPurchaseVersions(creds, "iap-1");

    expect(iapFetch).toHaveBeenCalledTimes(3);
    expect(listing.complete).toBe(true);
    expect(listing.versions.map((v) => v.id)).toEqual(["v1", "v2", "v3", "v-draft"]);
    expect(
      listing.versions.some((v) => v.attributes.state === "PREPARE_FOR_SUBMISSION"),
    ).toBe(true);
  });

  it("the cursor page is fetched at the PATH Apple pointed at, origin stripped", async () => {
    iapFetch
      .mockResolvedValueOnce({
        data: [version("v1", "APPROVED")],
        links: { next: "https://api.appstoreconnect.apple.com/v2/inAppPurchases/iap-1/versions?limit=200&cursor=AQ" },
      })
      .mockResolvedValueOnce({ data: [] });
    await listInAppPurchaseVersions(creds, "iap-1");
    expect(iapFetch).toHaveBeenNthCalledWith(
      2,
      creds,
      "GET",
      "/v2/inAppPurchases/iap-1/versions?limit=200&cursor=AQ",
    );
  });

  it("⚠⚠ a page with NO data[] ⇒ complete:false — a shape we cannot read is NOT 'no versions'", async () => {
    // `?? []` here would turn "we did not understand the answer" into the
    // sentence "this IAP has no versions", which both callers act on by
    // creating one. `complete:false` is how the caller learns it must refuse.
    iapFetch.mockResolvedValue({ errors: [{ code: "WEIRD" }] });
    const listing = await listInAppPurchaseVersions(creds, "iap-1");
    expect(listing.complete).toBe(false);
    expect(listing.versions).toEqual([]);
  });

  it("⚠ a MISSING data[] on page 2 does not silently keep page 1 as the whole truth", async () => {
    iapFetch
      .mockResolvedValueOnce({
        data: [version("v1", "APPROVED")],
        links: { next: "https://api.appstoreconnect.apple.com/v2/inAppPurchases/iap-1/versions?limit=200&cursor=AQ" },
      })
      .mockResolvedValueOnce({});
    const listing = await listInAppPurchaseVersions(creds, "iap-1");
    expect(listing.complete).toBe(false);
    // Page 1's rows are still returned, but flagged — the caller refuses on
    // the flag, never on the emptiness of the array.
    expect(listing.versions.map((v) => v.id)).toEqual(["v1"]);
  });

  it("⚠ an unparseable links.next THROWS rather than returning a short list", async () => {
    iapFetch.mockResolvedValueOnce({
      data: [version("v1", "APPROVED")],
      links: { next: "not-a-url" },
    });
    await expect(listInAppPurchaseVersions(creds, "iap-1")).rejects.toThrow(
      /listInAppPurchaseVersions: unparseable links\.next/,
    );
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
