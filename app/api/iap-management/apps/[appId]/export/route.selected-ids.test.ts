/**
 * `selectedIds` — the second scope, and the honesty mechanism that replaces
 * enumeration.
 *
 * ⚠ THE LOAD-BEARING TEST IS "a dead id appears in the failure sheet". Export
 * with a selection cannot lean on `listAllInAppPurchases`' all-or-nothing
 * contract, so completeness has to be guaranteed the other way: every id the
 * operator sent is ATTEMPTED, and every id is ACCOUNTED FOR in the file.
 * Validating ids against Apple's list first would look safer and is the trap —
 * an id dropped by an intersection produces a file short by one row with
 * nothing anywhere saying why.
 *
 * That test runs the REAL `fetchExportSources`, the REAL workbook builder and
 * the REAL xlsx writer, then reads the workbook back and looks in the sheet.
 * Mocking the fetch would have proved only that the route passes ids along,
 * not that a 404 survives the whole chain into something a human can see.
 *
 * ⚠ The chain it depends on was traced before this was written, and nothing
 * swallows the 404:
 *   getIapDetailFromApple (iap-detail.ts:46-52) — no catch
 *   → getInAppPurchase (client.ts:138-147)      — no catch
 *   → iapFetch (fetch.ts:37-44)                 — no catch
 *   → appleFetch (apple-fetch.ts:243-259)       — throws AppleApiError(404)
 *   → withRetry (apple-fetch.ts:113-114)        — rethrows non-429 at once
 *   → runStoppablePool (stoppable-pool.ts:130)  — shouldStop false, latch up
 *   → onError → classifyAppleError              — APPLE_ERROR
 *   → buildFailureRows (xlsx-export.ts:308-316) — status FAILED
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/iap-management/auth")>(
      "@/lib/iap-management/auth",
    );
  return { ...actual, requireIapSession };
});

const getActiveAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));

const listAllInAppPurchases = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/client", () => ({ listAllInAppPurchases }));

// ⚠ Only the two Apple LEAVES are faked. `fetchExportSources`, the plan
// builder, the workbook builder and XLSX.write all run for real — that is the
// point of this file.
const getIapDetailFromApple = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/iap-detail", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/iap-management/queries/iap-detail")
  >("@/lib/iap-management/queries/iap-detail");
  return { ...actual, getIapDetailFromApple };
});

const getPriceScheduleForIap = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/price-schedules", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/iap-management/apple/price-schedules")
  >("@/lib/iap-management/apple/price-schedules");
  return { ...actual, getPriceScheduleForIap };
});

import { POST } from "./route";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import { NoPriceScheduleError } from "@/lib/iap-management/apple/price-schedules";

const CTX = { params: { appId: "APP1" } };

function req(body: unknown): Request {
  return new Request("http://localhost/api/iap-management/apps/APP1/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function appleIap(id: string) {
  return {
    type: "inAppPurchases",
    id,
    attributes: {
      productId: `com.example.${id}`,
      name: `Item ${id}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "APPROVED",
    },
  };
}

function detailFor(id: string) {
  return {
    iap: appleIap(id),
    localizations: [],
    screenshot: null,
  };
}

/** Read the generated workbook back out of the response body. */
async function workbookFrom(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  return XLSX.read(buf, { type: "buffer" });
}

function sheetText(wb: XLSX.WorkBook, name: string): string {
  const ws = wb.Sheets[name];
  if (!ws) return "";
  return JSON.stringify(XLSX.utils.sheet_to_json(ws, { header: 1 }));
}

beforeEach(() => {
  requireIapSession
    .mockReset()
    .mockResolvedValue({ user: { email: "a@b.com", role: "member" } });
  getActiveAccount.mockReset().mockResolvedValue({
    id: "acct",
    name: "Acct",
    keyId: "k",
    issuerId: "i",
    privateKey: "pk",
  });
  listAllInAppPurchases.mockReset().mockResolvedValue({
    data: [appleIap("all1"), appleIap("all2"), appleIap("all3")],
  });
  getIapDetailFromApple
    .mockReset()
    .mockImplementation(async (_c: unknown, id: string) => detailFor(id));
  // "Apple has no schedule" — a real answer, not a failure. Keeps these tests
  // about the item set rather than about prices.
  //
  // ⚠ A FRESH instance per call, via mockImplementation rather than
  // mockRejectedValue: a single shared rejected Error is the known vitest
  // trap on any path that can retry (KB — IAP.o.10a).
  getPriceScheduleForIap
    .mockReset()
    .mockImplementation(async (_c: unknown, id: string) => {
      throw new NoPriceScheduleError(
        id,
        new AppleApiError(404, "GET", `/v1/inAppPurchases/${id}/iapPriceSchedule`, "not found"),
      );
    });
});

// ─── the three semantics of the field ──────────────────────────────────────

describe("selectedIds semantics", () => {
  it("ABSENT ⇒ export all — the enumeration path is untouched", async () => {
    const res = await POST(req({ territories: null }), CTX);

    expect(res.status).toBe(200);
    expect(listAllInAppPurchases).toHaveBeenCalledTimes(1);
    expect(res.headers.get("X-Export-Item-Count")).toBe("3");
  });

  it("null ⇒ export all, exactly like absent", async () => {
    const res = await POST(req({ selectedIds: null }), CTX);

    expect(res.status).toBe(200);
    expect(listAllInAppPurchases).toHaveBeenCalledTimes(1);
    expect(res.headers.get("X-Export-Item-Count")).toBe("3");
  });

  it("[] ⇒ 400, NOT a silent export-all", async () => {
    // ⚠ Widening an empty selection to the whole app would bill ~3N Apple
    // requests nobody asked for. Only ABSENCE means "no selection was made".
    const res = await POST(req({ selectedIds: [] }), CTX);

    expect(res.status).toBe(400);
    expect(listAllInAppPurchases).not.toHaveBeenCalled();
    expect(getIapDetailFromApple).not.toHaveBeenCalled();
  });

  it("non-empty ⇒ exactly those items, and NO enumeration at all", async () => {
    const res = await POST(req({ selectedIds: ["s1", "s2"] }), CTX);

    expect(res.status).toBe(200);
    // ⚠ Not even to validate — see the route header.
    expect(listAllInAppPurchases).not.toHaveBeenCalled();
    expect(
      getIapDetailFromApple.mock.calls.map((c) => c[1]).sort(),
    ).toEqual(["s1", "s2"]);
    expect(res.headers.get("X-Export-Item-Count")).toBe("2");
  });

  it("dedupes — a repeated id is one item, one read, one row", async () => {
    const res = await POST(
      req({ selectedIds: ["s1", "s2", "s1", "s1"] }),
      CTX,
    );

    expect(getIapDetailFromApple).toHaveBeenCalledTimes(2);
    expect(res.headers.get("X-Export-Item-Count")).toBe("2");
  });
});

// ─── 🎯 the pin ────────────────────────────────────────────────────────────

describe("an id Apple does not have", () => {
  it("🎯 lands in the failure sheet — it is NEVER filtered away", async () => {
    getIapDetailFromApple.mockImplementation(
      async (_c: unknown, id: string) => {
        if (id === "ghost") {
          throw new AppleApiError(
            404,
            "GET",
            `/v2/inAppPurchases/${id}`,
            '{"errors":[{"status":"404","code":"NOT_FOUND"}]}',
          );
        }
        return detailFor(id);
      },
    );

    const res = await POST(req({ selectedIds: ["s1", "ghost", "s2"] }), CTX);
    expect(res.status).toBe(200);

    // ⚠ It was ATTEMPTED. A route that pre-filtered unknown ids would never
    // have called Apple for it.
    expect(getIapDetailFromApple.mock.calls.map((c) => c[1])).toContain("ghost");

    // ⚠ And it is VISIBLE in the artifact, by id, marked FAILED.
    const wb = await workbookFrom(res);
    expect(wb.SheetNames).toContain("Export Failures");
    const failures = sheetText(wb, "Export Failures");
    expect(failures).toContain("ghost");
    expect(failures).toContain("FAILED");
    expect(failures).toContain("Apple refused");

    // The two live items still exported.
    expect(res.headers.get("X-Export-Item-Count")).toBe("2");
    expect(res.headers.get("X-Export-Failed-Count")).toBe("1");
  });

  it("does not stop the run — one dead id says nothing about the next", async () => {
    // ⚠ Rule 2 of the stop latch: only an exhausted rate-limit budget predicts
    // the next call fails too. A 404 must stay fail-soft.
    getIapDetailFromApple.mockImplementation(
      async (_c: unknown, id: string) => {
        if (id === "ghost")
          throw new AppleApiError(404, "GET", "/v2/x", "not found");
        return detailFor(id);
      },
    );

    const res = await POST(
      req({ selectedIds: ["ghost", "s1", "s2", "s3"] }),
      CTX,
    );

    expect(res.headers.get("X-Export-Item-Count")).toBe("3");
    expect(res.headers.get("X-Export-Not-Attempted-Count")).toBe("0");
    expect(res.headers.has("X-Export-Stopped")).toBe(false);
  });

  it("every selected id is accounted for — exported, or named as failed", async () => {
    getIapDetailFromApple.mockImplementation(
      async (_c: unknown, id: string) => {
        if (id.startsWith("ghost"))
          throw new AppleApiError(404, "GET", "/v2/x", "not found");
        return detailFor(id);
      },
    );

    const ids = ["s1", "ghost1", "s2", "ghost2", "s3"];
    const res = await POST(req({ selectedIds: ids }), CTX);

    const exported = Number(res.headers.get("X-Export-Item-Count"));
    const failed = Number(res.headers.get("X-Export-Failed-Count"));
    const notAttempted = Number(
      res.headers.get("X-Export-Not-Attempted-Count"),
    );

    // Nothing vanishes between the request and the file.
    expect(exported + failed + notAttempted).toBe(ids.length);

    const failures = sheetText(await workbookFrom(res), "Export Failures");
    expect(failures).toContain("ghost1");
    expect(failures).toContain("ghost2");
  });
});

// ─── what the selection does NOT change ────────────────────────────────────

describe("the selection changes the item set and nothing else", () => {
  it("territories still filter columns independently of selectedIds", async () => {
    const res = await POST(
      req({ selectedIds: ["s1"], territories: ["US"] }),
      CTX,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Item-Count")).toBe("1");
  });

  it("no size cap is invented — the stop latch remains the budget mechanism", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `s${i}`);
    const res = await POST(req({ selectedIds: ids }), CTX);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Item-Count")).toBe("400");
  });
});
