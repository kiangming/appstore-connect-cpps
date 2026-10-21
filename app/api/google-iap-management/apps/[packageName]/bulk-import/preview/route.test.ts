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
 *   unreadable       → 503 MIRROR_READ_FAILED (IAP list) /
 *                      IMPORT_READINESS_READ_FAILED (readiness row)  (D2)
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
// Provided (guessed / empty values) so a re-introduced "currency must be
// declared" check would read realistic data and block — the C2.1 tests below
// then go red for the right reason, not on a missing mock export.
const getAppDefaults = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage,
  getIapsMirrorSyncedAt,
  getAppDefaults,
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
import * as templateQueries from "@/lib/google-iap-management/queries/templates";
import { PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";

const ctx = { params: { packageName: "com.vnggames.ballisticherotwid" } };

function previewReq(pricingSource = "google_default"): Request {
  const form = new FormData();
  form.append("file", new File(["x"], "items.xlsx"));
  form.append("pricingSource", pricingSource);
  form.append("pricing_rule", PRICING_RULE);
  return new Request("http://localhost/api/x", { method: "POST", body: form });
}

function parsedRow(sku: string, rowNumber: number) {
  return {
    rowNumber,
    sku,
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    listings: [],
  };
}

const SYNCED_AT = "2026-10-16T03:25:10.000Z";
const GUESSED_DEFAULTS = {
  currency: { value: "USD", source: "guessed" as const },
  language: { value: "en-US", source: "guessed" as const },
};

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
  // D0 — gate open by default: refreshed completely.
  getIapsMirrorSyncedAt.mockReset().mockResolvedValue(SYNCED_AT);
  getAppDefaults.mockReset().mockResolvedValue(GUESSED_DEFAULTS);
  listIapsForApp.mockReset().mockResolvedValue([]);
  parseIapTemplate.mockReset().mockReturnValue({
    rows: [parsedRow("com.vnggames.ballisticherotwid.0.99", 2), parsedRow("com.vnggames.ballisticherotwid.1.99", 3)],
    warnings: [],
    errors: [],
    refusedRows: [],
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
    expect(body.error).toMatch(/no complete refresh from Google on record/);
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

  it("readiness READ ERROR ⇒ 503 IMPORT_READINESS_READ_FAILED, not IAPS_NEVER_SYNCED / not declared", async () => {
    getIapsMirrorSyncedAt.mockRejectedValue(new Error("column apps.iaps_last_synced_at does not exist"));
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("IMPORT_READINESS_READ_FAILED");
    // Names what failed (§29.3) — not "the cached IAP list".
    expect(body.error).toMatch(/Could not read whether this app's IAP list has been refreshed/);
    expect(body.error).not.toMatch(/cached IAP list/);
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

describe("Google bulk-import preview — C2.1: the app's currency/language are NOT conditions", () => {
  it.each([
    ["currency + language GUESSED by the tool", GUESSED_DEFAULTS],
    ["currency + language EMPTY", { currency: { value: null, source: null }, language: { value: null, source: null } }],
    ["currency declared, language guessed", { ...GUESSED_DEFAULTS, currency: { value: "USD", source: "declared" as const } }],
  ])("%s ⇒ the preview runs (200), only the IAP sync state gates", async (_label, defaults) => {
    getAppDefaults.mockResolvedValue(defaults);
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(200);
    expect(parseIapTemplate).toHaveBeenCalledTimes(1);
  });

  it("the gate never reads the app's currency/language or their provenance", async () => {
    await POST(previewReq(), ctx);
    expect(getAppDefaults).not.toHaveBeenCalled();
  });

  it.each([["TWD"], [null]])(
    "H4.1: the parser gets the FILE only — never the app currency (app currency %s)",
    async (appCurrency) => {
      getAppByPackage.mockResolvedValue({ id: "app-1", default_currency: appCurrency, google_console_account_id: "acc1" });
      await POST(previewReq(), ctx);
      expect(parseIapTemplate).toHaveBeenCalledTimes(1);
      expect(parseIapTemplate.mock.calls[0]).toHaveLength(1);
      // …and that one argument is exactly the uploaded file's bytes.
      expect(parseIapTemplate.mock.calls[0][0]).toEqual(Buffer.from("x"));
    },
  );

  it("H4.1: rows the parser refused are passed to the wizard (refusedRows + count), never dropped silently", async () => {
    parseIapTemplate.mockReturnValue({
      rows: [parsedRow("com.vnggames.ballisticherotwid.0.99", 2)],
      warnings: ["w"],
      errors: [],
      refusedRows: [{ rowNumber: 3, sku: "bad", reason: "TWD only accepts whole numbers" }],
      skippedSampleRows: [],
    });
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refusedRows: unknown[];
      counts: { refusedInFile: number; total: number };
    };
    expect(body.refusedRows).toEqual([{ rowNumber: 3, sku: "bad", reason: "TWD only accepts whole numbers" }]);
    expect(body.counts.refusedInFile).toBe(1);
    expect(body.counts.total).toBe(1);
  });

  it.each([[null], ["TWD"]])(
    "H4.2/H4.3: an EUR row under Google Conversion is priced from the file whatever the app currency (%s) — no resolution kind, never refused",
    async (appCurrency) => {
      getAppByPackage.mockResolvedValue({ id: "app-1", default_currency: appCurrency, google_console_account_id: "acc1" });
      parseIapTemplate.mockReturnValue({
        rows: [{ ...parsedRow("com.vnggames.ballisticherotwid.eur", 2), baseCurrency: "EUR", basePriceDecimal: "1.09" }],
        warnings: [],
        errors: [],
        refusedRows: [],
        skippedSampleRows: [],
      });
      const res = await POST(previewReq(), ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: Array<Record<string, unknown>>;
        refusedRows: unknown[];
        warnings: string[];
      };
      // H4.3 — the dead cross-currency `resolution` is gone from the response.
      expect(body.rows[0]).not.toHaveProperty("resolution");
      expect(body.rows[0]).toMatchObject({ baseCurrency: "EUR", basePriceDecimal: "1.09" });
      expect(body.refusedRows).toEqual([]);
      // H4.2: the response says nothing about the app's currency.
      expect(body).not.toHaveProperty("appCurrency");
      expect(body.warnings.join(" ")).not.toMatch(/refused on push/);
    },
  );

  it("H4.3: a tier lookup that THROWS marks the row tierMatchedBy 'lookup_failed' — never indistinguishable from 'no tier'", async () => {
    getAppByPackage.mockResolvedValue({ id: "app-1", default_currency: null, google_console_account_id: "acc1" });
    vi.mocked(templateQueries.findRowCandidates)
      .mockRejectedValueOnce(new Error("db timeout"))
      .mockResolvedValueOnce({ candidates: [], matchedBy: "none" } as never);
    parseIapTemplate.mockReturnValue({
      rows: [parsedRow("com.vnggames.ballisticherotwid.a", 2), parsedRow("com.vnggames.ballisticherotwid.b", 3)],
      warnings: [],
      errors: [],
      refusedRows: [],
      skippedSampleRows: [],
    });
    const res = await POST(previewReq("default_template"), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ sku: string; tierMatchedBy: string }>; warnings: string[] };
    expect(body.rows.map((r) => r.tierMatchedBy)).toEqual(["lookup_failed", "none"]);
    expect(body.warnings.join(" ")).toMatch(/Tier lookup failed for one or more rows \(db timeout\)/);
  });

  it("no app currency ⇒ no extra warning, block or confirm — the response carries only the parser's own warnings", async () => {
    getAppByPackage.mockResolvedValue({ id: "app-1", default_currency: null, google_console_account_id: "acc1" });
    parseIapTemplate.mockReturnValue({
      rows: [parsedRow("com.vnggames.ballisticherotwid.0.99", 2)],
      warnings: ["parser says hi"],
      errors: [],
      refusedRows: [],
      skippedSampleRows: [],
    });
    const res = await POST(previewReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toEqual(["parser says hi"]);
  });

});

describe("[GOOGLE-bulkimport-drop-gt] — the preview checks the contract too (twin of the execute route's PRICING_RULE check)", () => {
  it("no pricing_rule, or an older one (a tab opened before the update) ⇒ 409 PREVIEW_OUTDATED; the file is not even parsed", async () => {
    for (const rule of [null, "file-currency-only/v1"]) {
      parseIapTemplate.mockClear();
      const form = new FormData();
      form.append("file", new File(["x"], "items.xlsx"));
      form.append("pricingSource", "google_default");
      if (rule) form.append("pricing_rule", rule);
      const res = await POST(new Request("http://localhost/api/x", { method: "POST", body: form }), ctx);
      expect(res.status, String(rule)).toBe(409);
      expect(await res.json()).toEqual({
        error: "The tool was updated since this page was opened. Nothing was read. Reload this page, then upload the file again.",
        code: "PREVIEW_OUTDATED",
      });
      expect(parseIapTemplate).not.toHaveBeenCalled();
    }
    // The current rule passes.
    expect((await POST(previewReq(), ctx)).status).toBe(200);
    expect(PRICING_RULE).toBe("file-currency-only/v2");
  });
});
