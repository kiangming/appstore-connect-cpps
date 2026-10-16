/**
 * D0 + D2 + D3 [arc-google-missing-purchase-options] — the bulk-import
 * preview must never answer "every SKU is NEW" when it does not KNOW.
 *
 * Incident (com.vnggames.ballisticherotwid, 2026-10-16): the IAP mirror had
 * never been filled; preview said 28/28 NEW; execute sent 28 CREATEs onto 28
 * products that already existed on Google ⇒ FAILED_PRECONDITION. Census also
 * measured that a mirror READ ERROR produced a response byte-identical to a
 * genuinely empty mirror (`listIapsForApp(...).catch(() => [])`).
 *
 * Three states that must stay distinct:
 *   never refreshed  → 409 IAPS_NEVER_SYNCED   (D0)
 *   unreadable       → 503 MIRROR_READ_FAILED  (D2)
 *   refreshed        → 200 + iapsLastSyncedAt  (D3)
 *
 * Only the route's own decisions are under test: parser, template lookups
 * and repositories are faked at the module boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const listAccounts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({ listAccounts }));

const getAppByPackage = vi.hoisted(() => vi.fn());
const getIapsMirrorSyncedAt = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage,
  getIapsMirrorSyncedAt,
}));

const listIapsForApp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/iaps", () => ({ listIapsForApp }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

const parseIapTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/parsers/excel-parser", () => ({ parseIapTemplate }));

vi.mock("@/lib/google-iap-management/queries/templates", () => ({
  findRowCandidates: vi.fn(),
  getPrimaryTierFromCandidates: vi.fn(() => null),
}));

import { POST } from "./route";

const ctx = { params: { packageName: "com.vnggames.ballisticherotwid" } };

function previewReq(): Request {
  const form = new FormData();
  form.append("file", new File(["x"], "items.xlsx"));
  form.append("pricingSource", "google_default");
  return new Request("http://localhost/api/x", { method: "POST", body: form });
}

function parsedRow(sku: string, rowNumber: number) {
  return {
    rowNumber,
    sku,
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    priceHeaderSource: "explicit" as const,
    regionOverrides: [],
    listings: [],
  };
}

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { email: "m@vng.com.vn" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  getAppByPackage.mockReset().mockResolvedValue({
    id: "app-1",
    default_currency: "USD",
    google_console_account_id: "acc1",
  });
  getIapsMirrorSyncedAt.mockReset().mockResolvedValue("2026-10-16T03:25:10.000Z");
  listIapsForApp.mockReset().mockResolvedValue([]);
  parseIapTemplate.mockReset().mockReturnValue({
    rows: [parsedRow("com.vnggames.ballisticherotwid.0.99", 2), parsedRow("com.vnggames.ballisticherotwid.1.99", 3)],
    warnings: [],
    errors: [],
    skippedSampleRows: [],
  });
});

describe("Google bulk-import preview — D0: never refreshed ≠ refreshed and empty", () => {
  it("IAP list never refreshed ⇒ 409 IAPS_NEVER_SYNCED; the mirror is not even read", async () => {
    getIapsMirrorSyncedAt.mockResolvedValue(null);
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string; rows?: unknown };
    expect(body.code).toBe("IAPS_NEVER_SYNCED");
    expect(body.error).toMatch(/never been refreshed/);
    expect(body.error).toMatch(/Refresh IAP list/);
    expect(body.rows).toBeUndefined();
    expect(listIapsForApp).not.toHaveBeenCalled();
    expect(parseIapTemplate).not.toHaveBeenCalled();
  });

  it("refreshed AND empty is a real answer: rows are NEW, and the response says when the list was read", async () => {
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      iapsLastSyncedAt?: string;
      counts: { new: number; existing: number };
    };
    expect(body.iapsLastSyncedAt).toBe("2026-10-16T03:25:10.000Z");
    expect(body.counts).toMatchObject({ new: 2, existing: 0 });
  });

  it("the gate reads the sync state of THIS app row", async () => {
    await POST(previewReq(), ctx);
    expect(getIapsMirrorSyncedAt).toHaveBeenCalledWith("app-1");
  });
});

describe("Google bulk-import preview — D2: could not read ≠ empty", () => {
  it("mirror READ ERROR ⇒ 503 MIRROR_READ_FAILED, never a 200 with every row NEW", async () => {
    listIapsForApp.mockRejectedValue(new Error("Failed to list IAPs: connection reset"));
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      code?: string;
      error?: string;
      rows?: unknown;
      counts?: unknown;
    };
    expect(body.code).toBe("MIRROR_READ_FAILED");
    expect(body.error).toMatch(/connection reset/);
    expect(body.error).toMatch(/NOT the same as "no item exists"/);
    expect(body.rows).toBeUndefined();
    expect(body.counts).toBeUndefined();
  });

  it("sync-state READ ERROR ⇒ 503 MIRROR_READ_FAILED, not IAPS_NEVER_SYNCED", async () => {
    getIapsMirrorSyncedAt.mockRejectedValue(new Error("column apps.iaps_last_synced_at does not exist"));
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("MIRROR_READ_FAILED");
    expect(listIapsForApp).not.toHaveBeenCalled();
  });

  it("a readable mirror still classifies EXISTING vs NEW exactly as before", async () => {
    listIapsForApp.mockResolvedValue([{ sku: "com.vnggames.ballisticherotwid.0.99" }]);
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ sku: string; exists: boolean }>;
      counts: { new: number; existing: number };
    };
    expect(body.rows.map((r) => [r.sku, r.exists])).toEqual([
      ["com.vnggames.ballisticherotwid.0.99", true],
      ["com.vnggames.ballisticherotwid.1.99", false],
    ]);
    expect(body.counts).toMatchObject({ new: 1, existing: 1 });
  });
});
