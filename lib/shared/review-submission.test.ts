/**
 * Tests for the shared reviewSubmissions helpers — the create-or-reuse
 * logic (never blind-creates, closing CPP's latent 409 bug) and the
 * conflict-summary pure functions Decision A's dialog is built on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findOpenReviewSubmission,
  createReviewSubmission,
  createOrReuseReviewSubmission,
  getReviewSubmissionItems,
  addReviewSubmissionItem,
  submitReviewSubmission,
  deleteReviewSubmission,
  classifyReviewSubmissionItem,
  summarizeForeignItems,
} from "./review-submission";
import type { AscCredentials } from "@/lib/asc-jwt";
import type { ReviewSubmission, ReviewSubmissionItem } from "@/types/asc";

vi.mock("@/lib/asc-jwt", () => ({
  generateAscToken: vi.fn().mockResolvedValue("fake-jwt"),
}));
vi.mock("@/lib/logger", () => ({
  log: vi.fn().mockResolvedValue(undefined),
}));

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "KEY",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function submission(id: string, state: ReviewSubmission["attributes"]["state"]): ReviewSubmission {
  return { type: "reviewSubmissions", id, attributes: { state } };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("findOpenReviewSubmission", () => {
  it("returns the open one when Apple returns a non-COMPLETE submission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(200, { data: [submission("s1", "WAITING_FOR_REVIEW")] }),
      ),
    );
    const result = await findOpenReviewSubmission(creds, "app1", "IOS", "test");
    expect(result?.id).toBe("s1");
  });

  it("returns null when Apple only has COMPLETE submissions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(200, { data: [submission("s1", "COMPLETE")] })),
    );
    const result = await findOpenReviewSubmission(creds, "app1", "IOS", "test");
    expect(result).toBeNull();
  });

  it("returns null when the app has no reviewSubmissions at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { data: [] })));
    const result = await findOpenReviewSubmission(creds, "app1", "IOS", "test");
    expect(result).toBeNull();
  });

  it("queries with the platform filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await findOpenReviewSubmission(creds, "app1", "IOS", "test");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/apps/app1/reviewSubmissions");
    expect(fetchMock.mock.calls[0][0]).toContain("filter[platform]=IOS");
  });
});

describe("createOrReuseReviewSubmission — never blind-creates", () => {
  it("reuses an existing open submission instead of creating a new one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: [submission("existing-1", "IN_REVIEW")] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createOrReuseReviewSubmission(creds, "app1", "IOS", "test");
    expect(result.reused).toBe(true);
    expect(result.submission.id).toBe("existing-1");
    // Only the GET happened — no POST create call.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("creates a new submission only when none exists (closing CPP's blind-create 409 bug)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: [] })) // find → none
      .mockResolvedValueOnce(mockResponse(201, { data: submission("new-1", "READY_FOR_REVIEW") }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createOrReuseReviewSubmission(creds, "app1", "IOS", "test");
    expect(result.reused).toBe(false);
    expect(result.submission.id).toBe("new-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
  });
});

describe("createReviewSubmission", () => {
  it("POSTs with app relationship + platform attribute", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(201, { data: submission("s1", "READY_FOR_REVIEW") }));
    vi.stubGlobal("fetch", fetchMock);
    await createReviewSubmission(creds, "app1", "IOS", "test");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.data.attributes.platform).toBe("IOS");
    expect(body.data.relationships.app.data).toEqual({ type: "apps", id: "app1" });
  });
});

describe("getReviewSubmissionItems / addReviewSubmissionItem / submitReviewSubmission / deleteReviewSubmission", () => {
  it("getReviewSubmissionItems GETs the items sub-resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await getReviewSubmissionItems(creds, "sub1", "test");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/reviewSubmissions/sub1/items");
  });

  it("addReviewSubmissionItem POSTs with the given relationship key/type/id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(201, { data: { type: "reviewSubmissionItems", id: "item1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await addReviewSubmissionItem(
      creds, "sub1", "inAppPurchaseVersion", "inAppPurchaseVersions", "ver1", "test",
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.data.relationships.reviewSubmission.data).toEqual({
      type: "reviewSubmissions", id: "sub1",
    });
    expect(body.data.relationships.inAppPurchaseVersion.data).toEqual({
      type: "inAppPurchaseVersions", id: "ver1",
    });
  });

  it("submitReviewSubmission PATCHes submitted:true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await submitReviewSubmission(creds, "sub1", "test");
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.data.attributes.submitted).toBe(true);
  });

  it("deleteReviewSubmission DELETEs the container", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(204, ""));
    vi.stubGlobal("fetch", fetchMock);
    await deleteReviewSubmission(creds, "sub1", "test");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/reviewSubmissions/sub1");
  });
});

describe("classifyReviewSubmissionItem", () => {
  function item(relationships: ReviewSubmissionItem["relationships"]): ReviewSubmissionItem {
    return { type: "reviewSubmissionItems", id: "i1", relationships };
  }

  it("identifies a CPP item", () => {
    expect(
      classifyReviewSubmissionItem(
        item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "v1" } } }),
      ),
    ).toBe("appCustomProductPageVersion");
  });

  it("identifies an IAP item", () => {
    expect(
      classifyReviewSubmissionItem(
        item({ inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "v1" } } }),
      ),
    ).toBe("inAppPurchaseVersion");
  });

  it("ignores the reviewSubmission relationship itself", () => {
    expect(
      classifyReviewSubmissionItem(
        item({
          reviewSubmission: { data: { type: "reviewSubmissions", id: "s1" } },
          inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "v1" } },
        }),
      ),
    ).toBe("inAppPurchaseVersion");
  });

  it("returns 'unknown' when Apple returns opaque relationships (no data, only links)", () => {
    expect(classifyReviewSubmissionItem(item({}))).toBe("unknown");
  });
});

describe("summarizeForeignItems — Decision A conflict-dialog data", () => {
  function item(relationships: ReviewSubmissionItem["relationships"]): ReviewSubmissionItem {
    return { type: "reviewSubmissionItems", id: `i-${Math.random()}`, relationships };
  }

  it("excludes items matching the caller's own target ids", () => {
    const items = [
      item({ inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "mine-1" } } }),
      item({ inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "mine-2" } } }),
    ];
    const summary = summarizeForeignItems(items, "inAppPurchaseVersion", new Set(["mine-1", "mine-2"]));
    expect(summary.count).toBe(0);
  });

  it("counts items under a DIFFERENT relationship key as foreign (CPP items when caller is IAP)", () => {
    const items = [
      item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "cpp-1" } } }),
      item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "cpp-2" } } }),
      item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "cpp-3" } } }),
    ];
    const summary = summarizeForeignItems(items, "inAppPurchaseVersion", new Set());
    expect(summary.count).toBe(3);
    expect(summary.byKind).toEqual({ appCustomProductPageVersion: 3 });
    expect(summary.typesKnown).toBe(true);
  });

  it("mixes kinds correctly (CPP pages + other IAPs)", () => {
    const items = [
      item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "cpp-1" } } }),
      item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "cpp-2" } } }),
      item({ appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: "cpp-3" } } }),
      item({ inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "other-iap-1" } } }),
      item({ inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: "other-iap-2" } } }),
    ];
    const summary = summarizeForeignItems(items, "inAppPurchaseVersion", new Set(["mine-not-present"]));
    expect(summary.count).toBe(5);
    expect(summary.byKind).toEqual({ appCustomProductPageVersion: 3, inAppPurchaseVersion: 2 });
  });

  it("degrades typesKnown to false when Apple returns opaque items", () => {
    const items = [item({})];
    const summary = summarizeForeignItems(items, "inAppPurchaseVersion", new Set());
    expect(summary.typesKnown).toBe(false);
    expect(summary.byKind.unknown).toBe(1);
  });

  it("returns count 0 for an empty submission", () => {
    const summary = summarizeForeignItems([], "inAppPurchaseVersion", new Set());
    expect(summary.count).toBe(0);
    expect(summary.typesKnown).toBe(true);
  });
});
