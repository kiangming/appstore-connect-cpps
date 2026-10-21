/**
 * Hub-tracking wiring tests for the Google bulk-import execute route —
 * mirrors app/api/iap-management/apps/[appId]/bulk-import/execute/route.test.ts
 * (Apple). NOT a test of the Google orchestrator itself (executeBulkImport
 * is mocked) — these prove the load-bearing guarantee: the try/finally
 * wrapper calls finalizeHubTracking exactly once on every exit path (each
 * early return + the success/failure of executeBulkImport), with the
 * correct run id + terminal status + reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));

const listAccounts = vi.hoisted(() => vi.fn());
const getEncryptedCredentials = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts,
  getEncryptedCredentials,
}));

const getAppByPackage = vi.hoisted(() => vi.fn());
const getIapsMirrorSyncedAt = vi.hoisted(() => vi.fn());
// Provided with GUESSED values so a re-introduced "currency must be declared"
// check would read realistic data and block (C2.1 tests go red for the right
// reason, not on a missing mock export).
const getAppDefaults = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage,
  getIapsMirrorSyncedAt,
  getAppDefaults,
}));

const SYNCED_AT = "2026-10-16T03:25:10.000Z";
const GUESSED_DEFAULTS = {
  currency: { value: "USD", source: "guessed" as const },
  language: { value: "en-US", source: "guessed" as const },
};

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

const jwtClientFromEncrypted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted }));

const executeBulkImport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/orchestration/bulk-import", () => ({ executeBulkImport }));

const finalizeHubTracking = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/hub-tracking/tracking", () => ({ finalizeHubTracking }));

import { POST } from "./route";
import { MAX_DROPPED_ROWS, PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";

const ctx = { params: { packageName: "com.example.app" } };

/** A body as the CURRENT wizard sends it (buildExecuteRequestBody stamps
 *  `pricing_rule`). Pass a body that already names `pricing_rule` — or
 *  `{ raw: true }` — to send it untouched. */
function jsonReq(body: unknown, opts: { raw?: boolean } = {}): Request {
  const withRule =
    !opts.raw && body && typeof body === "object" && !("pricing_rule" in (body as object))
      ? { pricing_rule: PRICING_RULE, ...(body as object) }
      : body;
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withRule),
  });
}

const validRow = {
  rowNumber: 1,
  sku: "sku1",
  baseCurrency: "USD",
  basePriceDecimal: "0.99",
  decision: "create",
};

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { email: "a@b.com" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  getEncryptedCredentials.mockReset().mockResolvedValue({ enc: "x" });
  getAppByPackage.mockReset().mockResolvedValue({ id: "app1", default_currency: "USD" });
  // D0 — default: refreshed completely. Currency/language merely guessed.
  getIapsMirrorSyncedAt.mockReset().mockResolvedValue(SYNCED_AT);
  getAppDefaults.mockReset().mockResolvedValue(GUESSED_DEFAULTS);
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  jwtClientFromEncrypted.mockReset().mockReturnValue({});
  executeBulkImport.mockReset();
  finalizeHubTracking.mockReset();
});

describe("Google bulk-import execute — Hub tracking closes on every exit exactly once", () => {
  it("401 unauthorized: closes FAILED; no run id available yet (body never parsed)", async () => {
    getServerSession.mockResolvedValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(401);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", "Unauthorized");
  });

  it("400 no Google Console account configured: closes FAILED", async () => {
    resolveActiveAccountId.mockReturnValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.stringContaining("Google Console"),
    );
  });

  it("404 app not cached: closes FAILED", async () => {
    getAppByPackage.mockResolvedValue(null);
    const res = await POST(jsonReq({}), ctx);
    expect(res.status).toBe(404);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      null,
      "FAILED",
      expect.stringContaining("not cached"),
    );
  });

  it("400 invalid JSON body: closes FAILED", async () => {
    const badReq = new Request("http://localhost/api/x", { method: "POST", body: "not json" });
    const res = await POST(badReq, ctx);
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", "Invalid JSON body.");
  });

  it("hub_run_id is parsed as soon as the JSON body is available — closed even on a later validation failure", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-abc", pricingSource: "bogus", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-abc",
      "FAILED",
      expect.stringContaining("pricingSource"),
    );
  });

  it("blank hub_run_id is treated as no run (null), not an empty-string run id", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "", pricingSource: "bogus", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(null, "FAILED", expect.any(String));
  });

  it("400 empty rows: closes FAILED", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-1", pricingSource: "google_default", rows: [] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-1", "FAILED", "rows is required.");
  });

  it("400 per-row validation failure (missing sku): closes FAILED", async () => {
    const res = await POST(
      jsonReq({ hub_run_id: "run-1", pricingSource: "google_default", rows: [{ rowNumber: 1 }] }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-1",
      "FAILED",
      expect.stringContaining("sku"),
    );
  });

  it("success (all created): closes SUCCESS", async () => {
    executeBulkImport.mockResolvedValue({
      rowsTotal: 2,
      rowsCreated: 2,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      rowsRefused: 0,
      refusedRows: [],
      durationMs: 10,
    });
    const res = await POST(
      jsonReq({
        hub_run_id: "run-2",
        pricingSource: "google_default",
        rows: [validRow, { ...validRow, rowNumber: 2, sku: "sku2" }],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-2", "SUCCESS", undefined);
  });

  it("mixed result (some created, some failed): closes PARTIAL", async () => {
    executeBulkImport.mockResolvedValue({
      rowsTotal: 4,
      rowsCreated: 2,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 2,
      rowsRefused: 0,
      refusedRows: [],
      durationMs: 10,
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-3", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-3", "PARTIAL", undefined);
  });

  it("H4.2 / P5: all rows refused because the FILE price could not be sent ⇒ closes FAILED, not SUCCESS", async () => {
    // Before H4.2 refusals were cross-currency "soft skips" closing SUCCESS.
    // A price the file states that never reached Google is not a success.
    executeBulkImport.mockResolvedValue({
      rowsTotal: 3,
      rowsCreated: 0,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      rowsRefused: 3,
      priceRefusedRows: 3,
      refusedRows: [{ sku: "sku1", rowNumber: 1, reason: "conversion failed", kind: "conversion_failed" }],
      durationMs: 10,
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-4", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-4", "FAILED", expect.any(String));
  });

  it("executeBulkImport throwing closes FAILED with the specific message + maps err.code to HTTP status", async () => {
    executeBulkImport.mockRejectedValue({ code: 502, message: "Google API sync failed" });
    const res = await POST(
      jsonReq({ hub_run_id: "run-5", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(502);
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-5", "FAILED", "Google API sync failed");
  });

  it("executeBulkImport throwing without a code defaults to 500", async () => {
    executeBulkImport.mockRejectedValue(new Error("boom"));
    const res = await POST(
      jsonReq({ hub_run_id: "run-6", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-6", "FAILED", "boom");
  });
});

describe("Google bulk-import execute — per-item custom prices (SC4)", () => {
  const templateRow = {
    ...validRow,
    customPrices: {
      entries: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
      baselineTier: "tier_999",
      editedAt: "2026-08-07T10:00:00.000Z",
    },
  };
  const okResult = {
    batchId: "b1",
    rowsTotal: 1,
    rowsCreated: 1,
    rowsOverwritten: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    rowsRefused: 0,
    refusedRows: [],
    customPricedRows: 1,
    customRefusedRows: 0,
    durationMs: 10,
  };

  it("forwards a valid custom set to the orchestrator", async () => {
    executeBulkImport.mockResolvedValue(okResult);
    const res = await POST(
      jsonReq({ hub_run_id: "run-c1", pricingSource: "default_template", rows: [templateRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPrices).toEqual({
      entries: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
      baselineTier: "tier_999",
      editedAt: "2026-08-07T10:00:00.000Z",
    });
  });

  it("INVERTED: a custom set under Google Conversion is FORWARDED, not 400d", async () => {
    // The 400 assumed the template clobber could reach that path. It
    // cannot — the template-resolution loop is gated on a template
    // source, so under Google Conversion the set is a sparse overlay on
    // the base price (what the retired GT-Price column did for one country).
    executeBulkImport.mockResolvedValue(okResult);
    const res = await POST(
      jsonReq({ hub_run_id: "run-c2", pricingSource: "google_default", rows: [templateRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPrices.entries).toEqual([
      { region: "VN", currency: "VND", priceDecimal: "199000" },
    ]);
  });

  it("H4.3 (Q9): the PRICE rules run in the orchestrator (one refusal path) — the route forwards a bad price untouched, it does not refuse or 400", async () => {
    // The orchestrator's custom pre-pass re-checks with statedPriceOf, the
    // dialog's own rule (bulk-import.custom-prices.test.ts pins the refusal).
    executeBulkImport.mockResolvedValue({ ...okResult, customPricedRows: 0, customRefusedRows: 1 });
    for (const [priceDecimal, currency, region] of [["199000.55", "VND", "VN"], ["26.000", "VND", "VN"], ["0", "JPY", "JP"]]) {
      const res = await POST(
        jsonReq({
          hub_run_id: "run-c3",
          pricingSource: "google_default",
          rows: [{ ...validRow, customPrices: { entries: [{ region, currency, priceDecimal }] } }],
        }),
        ctx,
      );
      expect(res.status).toBe(200);
      const arg = executeBulkImport.mock.calls.at(-1)![1];
      expect(arg.rows[0].customPriceRefusal ?? null).toBeNull();
      expect(arg.rows[0].customPrices.entries).toEqual([{ region, currency, priceDecimal }]);
    }
  });

  it("one malformed custom row does NOT 400 the batch — 99 good rows still proceed", async () => {
    executeBulkImport.mockResolvedValue({ ...okResult, rowsTotal: 2, customRefusedRows: 1 });
    const good = { ...templateRow, rowNumber: 2, sku: "good" };
    const bad = {
      ...validRow,
      rowNumber: 3,
      sku: "bad",
      customPrices: { entries: [{ region: "", currency: "VND", priceDecimal: "199000" }] },
    };
    const res = await POST(
      jsonReq({ hub_run_id: "run-c4", pricingSource: "default_template", rows: [good, bad] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPriceRefusal ?? null).toBeNull();
    expect(arg.rows[1].customPriceRefusal).toEqual({
      kind: "custom_invalid_price",
      // One period, not ".." (H4.3).
      reason: "Row 3 (bad): a custom price entry is missing its country, currency or amount. Row not sent.",
    });
  });

  it("H4.3: an EMPTY custom set refuses its ROW (in the orchestrator), not the whole batch", async () => {
    executeBulkImport.mockResolvedValue({ ...okResult, customPricedRows: 0, customRefusedRows: 1 });
    const res = await POST(
      jsonReq({
        hub_run_id: "run-c5",
        pricingSource: "default_template",
        rows: [{ ...validRow, customPrices: { entries: [] } }, { ...validRow, rowNumber: 2, sku: "sku2" }],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const arg = executeBulkImport.mock.calls.at(-1)![1];
    expect(arg.rows[0].customPrices.entries).toEqual([]);
    expect(arg.rows).toHaveLength(2);
  });

  it("P5/Q5: a refused CUSTOM row closes the Hub run FAILED, not SUCCESS", async () => {
    // Zero Google-side failures, one custom refusal. Pre-Q5 this closed
    // SUCCESS because refusals folded into "skipped" — reporting an
    // outcome that plainly did not happen.
    executeBulkImport.mockResolvedValue({
      ...okResult,
      rowsCreated: 0,
      rowsFailed: 0,
      rowsRefused: 1,
      customPricedRows: 0,
      customRefusedRows: 1,
      refusedRows: [
        { sku: "sku1", rowNumber: 1, reason: "custom price invalid", kind: "custom_invalid_price" },
      ],
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-c6", pricingSource: "default_template", rows: [templateRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-c6", "FAILED", expect.any(String));
  });

  it("H4.2 / P5: one row created + one FILE-PRICE refusal ⇒ closes PARTIAL (the refusal is not a soft skip)", async () => {
    executeBulkImport.mockResolvedValue({
      ...okResult,
      rowsTotal: 2,
      rowsCreated: 1,
      rowsFailed: 0,
      rowsRefused: 1,
      priceRefusedRows: 1,
      customPricedRows: 0,
      customRefusedRows: 0,
      refusedRows: [{ sku: "x", rowNumber: 9, reason: "file price invalid", kind: "file_price_invalid" }],
    });
    const res = await POST(
      jsonReq({ hub_run_id: "run-c7", pricingSource: "default_template", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-c7", "PARTIAL", undefined);
  });
});

describe("H4.3 — the execute route: pricing rule, dropped rows, every refusal counted", () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    batchId: "b1",
    rowsTotal: 1,
    rowsCreated: 1,
    rowsOverwritten: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    rowsRefused: 0,
    priceRefusedRows: 0,
    droppedRows: 0,
    customPricedRows: 0,
    customRefusedRows: 0,
    refusedRows: [],
    durationMs: 1,
    ...over,
  });

  it("a request WITHOUT the current pricing_rule (a tab previewed before H4) ⇒ 409 PREVIEW_OUTDATED, nothing executed, Hub closed FAILED", async () => {
    for (const body of [
      { hub_run_id: "run-o1", pricingSource: "google_default", rows: [validRow] },
      { hub_run_id: "run-o1", pricing_rule: "app-currency/v0", pricingSource: "google_default", rows: [validRow] },
      // What the pre-H4 wizard sent: priceHeaderSource "inferred" + the app's currency.
      { hub_run_id: "run-o1", pricingSource: "google_default", rows: [{ ...validRow, baseCurrency: "VND", basePriceDecimal: "26000", priceHeaderSource: "inferred" }] },
    ]) {
      finalizeHubTracking.mockClear();
      const res = await POST(jsonReq(body, { raw: true }), ctx);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("PREVIEW_OUTDATED");
      // "Reload": in the stale tab, uploading again would rebuild the same old body.
      expect(finalizeHubTracking).toHaveBeenCalledWith("run-o1", "FAILED", expect.stringMatching(/Reload this page, then upload the file and run Preview again/));
    }
    expect(executeBulkImport).not.toHaveBeenCalled();
  });

  it("droppedRows reach the orchestrator; one that is ALSO a sent row is counted once (as the sent row)", async () => {
    executeBulkImport.mockResolvedValue(ok());
    const res = await POST(
      jsonReq({
        hub_run_id: "run-d1",
        pricingSource: "google_default",
        rows: [validRow],
        droppedRows: [
          { rowNumber: 1, sku: "sku1", reason: "dup of the sent row" },
          { rowNumber: 5, sku: "sku5", reason: '"Price (USD)" is empty — fill in the price.' },
          { rowNumber: 5, sku: "sku5", reason: "a repeated entry" },
        ],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(executeBulkImport.mock.calls.at(-1)![1].droppedRows).toEqual([
      { rowNumber: 5, sku: "sku5", reason: '"Price (USD)" is empty — fill in the price.' },
    ]);
  });

  it("malformed droppedRows / regionOverrides / listings ⇒ a clean 400 (never an unhandled TypeError), Hub closed FAILED", async () => {
    for (const body of [
      { hub_run_id: "run-d2", pricingSource: "google_default", rows: [validRow], droppedRows: [{ rowNumber: "x" }] },
      { hub_run_id: "run-d2", pricingSource: "google_default", rows: [{ ...validRow, regionOverrides: [{ region: 1 }] }] },
      { hub_run_id: "run-d2", pricingSource: "google_default", rows: [{ ...validRow, listings: [{ locale: "en-US", title: 123 }] }] },
    ]) {
      finalizeHubTracking.mockClear();
      const res = await POST(jsonReq(body), ctx);
      expect(res.status).toBe(400);
      expect(finalizeHubTracking).toHaveBeenCalledWith("run-d2", "FAILED", expect.any(String));
    }
    expect(executeBulkImport).not.toHaveBeenCalled();
  });

  it("more dropped rows than one push allows ⇒ a 400 that says what to do (not 'malformed')", async () => {
    const droppedRows = Array.from({ length: MAX_DROPPED_ROWS + 1 }, (_, i) => ({ rowNumber: i + 10, sku: `s${i}`, reason: "r" }));
    const res = await POST(jsonReq({ hub_run_id: "run-d3", pricingSource: "google_default", rows: [validRow], droppedRows }), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot be imported — more than \d+ in one push\. Clean the file and run Preview again\./);
    expect(executeBulkImport).not.toHaveBeenCalled();
  });

  it.each([
    ["refused_in_file (a dropped row)", { rowsTotal: 2, rowsRefused: 1, droppedRows: 1 }],
    ["tier_price_invalid", { rowsTotal: 2, rowsRefused: 1, priceRefusedRows: 1 }],
  ])("P5: 1 created + 1 %s ⇒ PARTIAL — the Hub counts rowsRefused, so a refusal of ANY kind is a failure", async (_k, over) => {
    executeBulkImport.mockResolvedValue(ok(over));
    const res = await POST(jsonReq({ hub_run_id: "run-p", pricingSource: "google_default", rows: [validRow] }), ctx);
    expect(res.status).toBe(200);
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-p", "PARTIAL", undefined);
  });

  it("the route no longer reads or forwards priceHeaderSource", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/priceHeaderSource/);
  });
});

/**
 * D0 [arc-google-missing-purchase-options] — the WRITE twin of the preview
 * gate. Incident: a never-refreshed mirror ⇒ 28/28 "NEW" ⇒ 28 CREATEs onto
 * products that already existed. Execute must refuse a plan built from such a
 * mirror even when the client sends it (stale tab, direct POST).
 */
describe("Google bulk-import execute — D0 mirror gate", () => {
  it("IAP list never refreshed ⇒ 409 IAPS_NEVER_SYNCED, nothing executed, Hub run closed FAILED", async () => {
    getIapsMirrorSyncedAt.mockResolvedValue(null);
    const res = await POST(
      jsonReq({ hub_run_id: "run-d0", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("IAPS_NEVER_SYNCED");
    expect(body.error).toMatch(/no complete refresh from Google on record/);
    expect(executeBulkImport).not.toHaveBeenCalled();
    expect(finalizeHubTracking).toHaveBeenCalledTimes(1);
    expect(finalizeHubTracking).toHaveBeenCalledWith(
      "run-d0",
      "FAILED",
      expect.stringContaining("no complete refresh from Google on record"),
    );
  });

  it("sync state UNREADABLE ⇒ 503 IMPORT_READINESS_READ_FAILED — not treated as synced, not as never", async () => {
    getIapsMirrorSyncedAt.mockRejectedValue(new Error("column does not exist"));
    const res = await POST(
      jsonReq({ hub_run_id: "run-d0e", pricingSource: "google_default", rows: [validRow] }),
      ctx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("IMPORT_READINESS_READ_FAILED");
    expect(body.error).toMatch(/column does not exist/);
    expect(executeBulkImport).not.toHaveBeenCalled();
    expect(finalizeHubTracking).toHaveBeenCalledWith("run-d0e", "FAILED", expect.any(String));
  });

  it("the gate reads the sync state of THIS app row", async () => {
    executeBulkImport.mockResolvedValue({
      rowsTotal: 1, rowsCreated: 1, rowsOverwritten: 0, rowsSkipped: 0, rowsFailed: 0,
      rowsRefused: 0, refusedRows: [], customPricedRows: 0, customRefusedRows: 0, durationMs: 1,
    });
    await POST(jsonReq({ pricingSource: "google_default", rows: [validRow] }), ctx);
    expect(getIapsMirrorSyncedAt).toHaveBeenCalledWith("app1");
  });

  it.each([
    ["GUESSED", GUESSED_DEFAULTS],
    ["EMPTY", { currency: { value: null, source: null }, language: { value: null, source: null } }],
  ])("C2.1: currency/language %s ⇒ execute RUNS — they are not conditions; the gate never reads them", async (_l, defaults) => {
    getAppDefaults.mockResolvedValue(defaults);
    executeBulkImport.mockResolvedValue({
      rowsTotal: 1, rowsCreated: 1, rowsOverwritten: 0, rowsSkipped: 0, rowsFailed: 0,
      rowsRefused: 0, refusedRows: [], customPricedRows: 0, customRefusedRows: 0, durationMs: 1,
    });
    const res = await POST(jsonReq({ hub_run_id: "run-c21", pricingSource: "google_default", rows: [validRow] }), ctx);
    expect(res.status).toBe(200);
    expect(executeBulkImport).toHaveBeenCalledTimes(1);
    expect(getAppDefaults).not.toHaveBeenCalled();
  });

  it.each([["TWD"], [null]])(
    "H4.2: the orchestrator gets NO app currency, whatever the app row says (app currency %s) — execute runs",
    async (appCurrency) => {
      getAppByPackage.mockResolvedValue({ id: "app1", default_currency: appCurrency, default_language: null });
      executeBulkImport.mockResolvedValue({
        rowsTotal: 1, rowsCreated: 1, rowsOverwritten: 0, rowsSkipped: 0, rowsFailed: 0,
        rowsRefused: 0, refusedRows: [], customPricedRows: 0, customRefusedRows: 0, durationMs: 1,
      });
      const res = await POST(jsonReq({ pricingSource: "google_default", rows: [validRow] }), ctx);
      expect(res.status).toBe(200);
      const [, args] = executeBulkImport.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args).not.toHaveProperty("appDefaultCurrency");
      expect(JSON.stringify(args)).not.toMatch(/TWD/);
    },
  );
});

/**
 * Static posture guard (same genre as lib/iap-management/rbac-posture.test.ts).
 *
 * Phase 3 sends per-item custom prices as a full ~170-entry set per row,
 * which puts a 100-row batch at 0.96-1.07 MB — right on the 1 MB body
 * limit Next.js applies to SERVER ACTIONS (route handlers have none).
 * Converting this endpoint to a Server Action would silently start
 * rejecting custom-heavy batches at ~95 rows.
 *
 * The route's own docstring says so, but a docstring is not a guard: this
 * codebase has already had a documented-then-reintroduced bug (the
 * listInAppPurchases warning), which is why that function was deleted
 * rather than re-annotated. This makes the conversion go red instead.
 */
describe("bulk-import execute route — posture", () => {
  it("is a Route Handler, never a Server Action (1 MB body-limit boundary)", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).not.toMatch(/^\s*["']use server["']/m);
  });
});
