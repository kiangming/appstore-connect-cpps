/**
 * Hotfix 20 — pagination tests for the ASC apps catalogue fetch.
 *
 * Mocks `./asc-jwt` (no real JWT signing) and `./logger` (no-op
 * loggers), then stubs global `fetch` per case to drive specific
 * page/cursor behaviours. Asserts on the URLs the wrapper requests
 * in order, the accumulated `data` array, and pagination link
 * stripping in the synthesised response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { getApps } from "./asc-client";
import type { AscCredentials } from "./asc-jwt";

vi.mock("./asc-jwt", () => ({
  generateAscToken: vi.fn().mockResolvedValue("fake-jwt"),
}));

vi.mock("./logger", () => ({
  log: vi.fn().mockResolvedValue(undefined),
}));

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "TESTKEY",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

const ASC_BASE = "https://api.appstoreconnect.apple.com";

function appRow(id: string) {
  return {
    id,
    type: "apps",
    attributes: { name: `App ${id}`, bundleId: `com.x.${id}`, sku: id, primaryLocale: "en-US" },
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("getApps (Hotfix 20 — cursor pagination)", () => {
  it("requests ?limit=200 on the first page (not the old ?limit=50)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [appRow("a1"), appRow("a2")], links: { self: "x" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getApps(creds);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ASC_BASE}/v1/apps?limit=200`);
  });

  it("returns all apps from a single-page response (no links.next)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [appRow("a"), appRow("b"), appRow("c")],
        links: { self: `${ASC_BASE}/v1/apps?limit=200` },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getApps(creds);
    expect(result.data).toHaveLength(3);
    expect(result.data.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("follows links.next across multiple pages and accumulates apps", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("a"), appRow("b")],
          links: {
            self: `${ASC_BASE}/v1/apps?limit=200`,
            next: `${ASC_BASE}/v1/apps?cursor=PAGE2&limit=200`,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("c"), appRow("d")],
          links: {
            self: `${ASC_BASE}/v1/apps?cursor=PAGE2&limit=200`,
            next: `${ASC_BASE}/v1/apps?cursor=PAGE3&limit=200`,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("e")],
          links: { self: `${ASC_BASE}/v1/apps?cursor=PAGE3&limit=200` },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getApps(creds);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.data.map((a) => a.id)).toEqual(["a", "b", "c", "d", "e"]);
    // Verify each subsequent request used Apple's full-URL cursor verbatim.
    expect(fetchMock.mock.calls[0][0]).toBe(`${ASC_BASE}/v1/apps?limit=200`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${ASC_BASE}/v1/apps?cursor=PAGE2&limit=200`);
    expect(fetchMock.mock.calls[2][0]).toBe(`${ASC_BASE}/v1/apps?cursor=PAGE3&limit=200`);
  });

  it("returns empty data array when the catalogue has zero apps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: [], links: { self: `${ASC_BASE}/v1/apps?limit=200` } }),
      ),
    );
    const result = await getApps(creds);
    expect(result.data).toEqual([]);
  });

  it("preserves the first page's self link and drops downstream cursors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("a")],
          links: {
            self: `${ASC_BASE}/v1/apps?limit=200`,
            next: `${ASC_BASE}/v1/apps?cursor=P2&limit=200`,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("b")],
          links: { self: `${ASC_BASE}/v1/apps?cursor=P2&limit=200` },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getApps(creds);
    // Synthesised response carries only the first-page self; next/prev are
    // dropped because the accumulated `data` no longer corresponds to a
    // single page that a cursor could point at.
    expect(result.links).toEqual({ self: `${ASC_BASE}/v1/apps?limit=200` });
  });

  it("merges `included` arrays across pages when present", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("a")],
          included: [{ type: "appCategories", id: "cat-1", attributes: {} }],
          links: { self: "x", next: `${ASC_BASE}/v1/apps?cursor=P2` },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("b")],
          included: [{ type: "appCategories", id: "cat-2", attributes: {} }],
          links: { self: `${ASC_BASE}/v1/apps?cursor=P2` },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getApps(creds);
    expect(result.included).toHaveLength(2);
    expect(result.included?.map((r) => r.id)).toEqual(["cat-1", "cat-2"]);
  });

  it("sets Authorization header on every paginated request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [appRow("a")],
          links: { self: "x", next: `${ASC_BASE}/v1/apps?cursor=P2` },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [appRow("b")], links: { self: "x" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await getApps(creds);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({
        Authorization: "Bearer fake-jwt",
        "Content-Type": "application/json",
      });
    }
  });
});
