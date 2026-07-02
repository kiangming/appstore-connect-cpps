/**
 * listInAppProducts — pagination of the legacy fallback.
 *
 * The new Monetization API path already paginates. This locks the fix for
 * the legacy `inappproducts.list` path, which previously did a single call
 * (silently truncating at ~1000 items). We force the new API to error so
 * the fallback runs, and assert it follows tokenPagination across pages to
 * return the full set.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listSpy, onetimeListSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  onetimeListSpy: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    androidpublisher: () => ({
      inappproducts: { list: listSpy },
      monetization: { onetimeproducts: { list: onetimeListSpy } },
    }),
  },
}));
vi.mock("./logging", () => ({ logPublisherCall: vi.fn() }));

import { listInAppProducts } from "./publisher-client";

const jwt = {} as never;

beforeEach(() => {
  listSpy.mockReset();
  onetimeListSpy.mockReset();
});

describe("listInAppProducts — legacy fallback pagination", () => {
  it("follows tokenPagination.nextPageToken across pages (>1000 items, no truncation)", async () => {
    // New API errors → fallback engages.
    onetimeListSpy.mockRejectedValue({ code: 403, message: "migrate to new API" });

    // Two legacy pages of 1000 + 250; token drives the second call.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ sku: `sku.${i}` }));
    const page2 = Array.from({ length: 250 }, (_, i) => ({ sku: `sku.${1000 + i}` }));
    listSpy
      .mockResolvedValueOnce({
        data: { inappproduct: page1, tokenPagination: { nextPageToken: "PAGE2" } },
      })
      .mockResolvedValueOnce({ data: { inappproduct: page2 } });

    const products = await listInAppProducts(jwt, "com.example.big");

    expect(products.length).toBe(1250);
    expect(listSpy).toHaveBeenCalledTimes(2);
    // First call has no token; second passes the cursor.
    expect(listSpy.mock.calls[0][0]).toEqual({ packageName: "com.example.big", token: undefined });
    expect(listSpy.mock.calls[1][0]).toEqual({ packageName: "com.example.big", token: "PAGE2" });
  });

  it("single legacy page (no nextPageToken) makes exactly one call", async () => {
    onetimeListSpy.mockRejectedValue({ code: 403, message: "migrate" });
    listSpy.mockResolvedValueOnce({ data: { inappproduct: [{ sku: "only" }] } });

    const products = await listInAppProducts(jwt, "com.example.small");
    expect(products.length).toBe(1);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });
});
