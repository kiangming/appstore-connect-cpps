/**
 * THE FIVE EXPORT HEADERS, AS A CONTRACT.
 *
 * ⚠ WHY THIS FILE EXISTS. Commit b171eeb settled what each header means and
 * wrote the reasoning into a comment (`route.ts:90-103`). A comment is not a
 * contract: before this file there was **no test for this route at all**, and
 * `grep X-Export` across the whole suite returned zero hits. The next change
 * to touch the route — chunk 2e gives it a `selectedIds` body — could have
 * redefined any of the five silently, and nothing would have gone red.
 *
 * ⚠ WHAT IS PINNED IS THE *DEFINITION*, NOT A NUMBER. Each test builds a
 * fixture where the header's correct value differs from every plausible wrong
 * one, so a test can only pass for the right reason:
 *
 *   Item-Count        = rows in the MAIN SHEET.       ≠ items requested.
 *   Failed-Count      = asked and REFUSED.            ≠ all failures.
 *   Partial-Count     = exported WITH prices missing. ≠ failed.
 *   Not-Attempted     = nothing was SENT.             ≠ failed.
 *   Stopped           = the pool's own latch.         ≠ "something failed".
 *
 * ⚠ THE ONE INVARIANT UNDER ALL FIVE (P5, the status principle): a stopped run
 * is NOT a failed run, and a partial row is NOT a missing row. Collapsing
 * either tells the operator to redo work that already landed.
 *
 * SEAM. Apple is mocked at `fetchExportSources` — the route's arithmetic is
 * what b171eeb settled, so that is what is exercised. Everything downstream of
 * it (`buildExportPlan`, `buildExportWorkbook`, XLSX.write) runs FOR REAL, so
 * `Item-Count` is read off the genuine plan builder rather than a stub that
 * could agree with a wrong route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  ExportSource,
  PriceReadFailure,
} from "@/lib/iap-management/xlsx-export";
import type { ExportFetchFailure } from "@/lib/iap-management/apple/export-fetch";

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

const fetchExportSources = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/apple/export-fetch", () => ({ fetchExportSources }));

import { POST } from "./route";

// ─── fixtures ──────────────────────────────────────────────────────────────

/** A source is a row that REACHED THE MAIN SHEET. `priceSchedule: null` is a
 *  legitimate complete row (an IAP Apple has no schedule for), which is why
 *  it is the default — a partial row is made by setting `priceReadFailure`,
 *  never by blanking the schedule. */
function source(id: string, over: Partial<ExportSource> = {}): ExportSource {
  return {
    appleIapId: `apple-${id}`,
    productId: `com.example.${id}`,
    skuName: `SKU ${id}`,
    status: "APPROVED",
    priceSchedule: {
      baseTerritory: "USA",
      basePrice: null,
      entries: [
        {
          priceId: `p-${id}`,
          startDate: null,
          endDate: null,
          territory: "USA",
          customerPrice: "0.99",
          currency: "USD",
        },
      ],
    },
    priceReadFailure: null,
    localizations: [],
    ...over,
  };
}

const PRICE_RATE_LIMITED: PriceReadFailure = {
  kind: "RATE_LIMITED",
  status: 429,
  message: "429: rate limited reading the price schedule",
};

function failure(
  id: string,
  kind: ExportFetchFailure["kind"],
): ExportFetchFailure {
  return {
    productId: `com.example.${id}`,
    appleIapId: `apple-${id}`,
    kind,
    error: `${kind} on ${id}`,
  };
}

function fetchResult(over: {
  sources?: ExportSource[];
  failures?: ExportFetchFailure[];
  stopped?: boolean;
}) {
  return {
    sources: over.sources ?? [],
    failures: over.failures ?? [],
    stopped: over.stopped ?? false,
  };
}

function req(body: unknown = {}): Request {
  return new Request("http://localhost/api/iap-management/apps/APP1/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CTX = { params: { appId: "APP1" } };

async function headersFor(result: ReturnType<typeof fetchResult>) {
  fetchExportSources.mockResolvedValue(result);
  const res = await POST(req(), CTX);
  expect(res.status).toBe(200);
  return res.headers;
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
  // The route enumerates before fetching; the enumeration itself is not what
  // this file pins, so it returns a set large enough to be distinguishable
  // from every count asserted below.
  listAllInAppPurchases.mockReset().mockResolvedValue({
    data: Array.from({ length: 9 }, (_, i) => ({
      id: `apple-e${i}`,
      attributes: { productId: `com.example.e${i}`, name: `E${i}` },
    })),
  });
  fetchExportSources.mockReset();
});

// ─── 1. Item-Count ─────────────────────────────────────────────────────────

describe("X-Export-Item-Count", () => {
  it("counts rows in the MAIN SHEET — not items requested, not items attempted", async () => {
    // 3 rows reached the sheet; 2 items did not; 9 were enumerated. Only one
    // of those three numbers is correct, and they are all different.
    const headers = await headersFor(
      fetchResult({
        sources: [source("a"), source("b"), source("c")],
        failures: [failure("d", "APPLE_ERROR"), failure("e", "NOT_ATTEMPTED")],
      }),
    );

    expect(headers.get("X-Export-Item-Count")).toBe("3");
  });

  it("INCLUDES a partial row — prices missing is still a row in the sheet", async () => {
    // The whole reason PARTIAL exists as its own count: the row IS exported.
    // Subtracting it here would tell the operator the item is absent when it
    // is in the file, one column short.
    const headers = await headersFor(
      fetchResult({
        sources: [
          source("a"),
          source("b", { priceReadFailure: PRICE_RATE_LIMITED }),
        ],
      }),
    );

    expect(headers.get("X-Export-Item-Count")).toBe("2");
    expect(headers.get("X-Export-Partial-Count")).toBe("1");
  });
});

// ─── 2. Failed-Count ───────────────────────────────────────────────────────

describe("X-Export-Failed-Count", () => {
  it("counts only ASKED-AND-REFUSED — NOT_ATTEMPTED is excluded", async () => {
    // b171eeb's load-bearing sentence: this header keeps its ORIGINAL meaning
    // (rows that are not in the main sheet AND were actually sent) so the
    // existing toast is not silently redefined. 3 failures, 1 of them never
    // sent ⇒ 2.
    const headers = await headersFor(
      fetchResult({
        sources: [source("a")],
        failures: [
          failure("b", "APPLE_ERROR"),
          failure("c", "RATE_LIMITED"),
          failure("d", "NOT_ATTEMPTED"),
        ],
      }),
    );

    expect(headers.get("X-Export-Failed-Count")).toBe("2");
    expect(headers.get("X-Export-Not-Attempted-Count")).toBe("1");
  });

  it("does NOT absorb partial rows — a degraded row is not a refused one", async () => {
    const headers = await headersFor(
      fetchResult({
        sources: [
          source("a", { priceReadFailure: PRICE_RATE_LIMITED }),
          source("b", { priceReadFailure: PRICE_RATE_LIMITED }),
        ],
        failures: [failure("c", "APPLE_ERROR")],
      }),
    );

    expect(headers.get("X-Export-Failed-Count")).toBe("1");
    expect(headers.get("X-Export-Partial-Count")).toBe("2");
  });
});

// ─── 3. Partial-Count ──────────────────────────────────────────────────────

describe("X-Export-Partial-Count", () => {
  it("counts sources carrying a priceReadFailure — of ANY kind, not just 429", async () => {
    // INCOMPLETE_PRICES is a SUCCESSFUL read that came back short. It is a
    // distinct kind precisely so it is not filed under a refusal, but it is
    // still a partial row and must be counted as one.
    const headers = await headersFor(
      fetchResult({
        sources: [
          source("a"),
          source("b", { priceReadFailure: PRICE_RATE_LIMITED }),
          source("c", {
            priceReadFailure: {
              kind: "INCOMPLETE_PRICES",
              incompleteReason: "PAGE_CAP",
              message: "collected 200 prices; more remained",
            },
          }),
        ],
      }),
    );

    expect(headers.get("X-Export-Partial-Count")).toBe("2");
    expect(headers.get("X-Export-Item-Count")).toBe("3");
    expect(headers.get("X-Export-Failed-Count")).toBe("0");
  });

  it("a row with no price schedule at all is COMPLETE, not partial", async () => {
    // `priceSchedule: null` means Apple has no schedule for this IAP — a real
    // answer. Only `priceReadFailure` means "we could not read it". Conflating
    // them is the G4b defect this count exists to keep dead.
    const headers = await headersFor(
      fetchResult({
        sources: [source("a", { priceSchedule: null, priceReadFailure: null })],
      }),
    );

    expect(headers.get("X-Export-Partial-Count")).toBe("0");
    expect(headers.get("X-Export-Item-Count")).toBe("1");
  });
});

// ─── 4. Not-Attempted-Count ────────────────────────────────────────────────

describe("X-Export-Not-Attempted-Count", () => {
  it("counts failures whose kind is NOT_ATTEMPTED — the only re-exportable bucket", async () => {
    const headers = await headersFor(
      fetchResult({
        sources: [source("a")],
        failures: [
          failure("b", "NOT_ATTEMPTED"),
          failure("c", "NOT_ATTEMPTED"),
          failure("d", "UNKNOWN"),
        ],
        stopped: true,
      }),
    );

    expect(headers.get("X-Export-Not-Attempted-Count")).toBe("2");
    expect(headers.get("X-Export-Failed-Count")).toBe("1");
  });

  it("is 0 on a clean run, and the header is still present", async () => {
    // Present-and-zero, never absent: a client reading `?? "0"` would not tell
    // the difference, but a client checking presence would.
    const headers = await headersFor(fetchResult({ sources: [source("a")] }));

    expect(headers.get("X-Export-Not-Attempted-Count")).toBe("0");
  });
});

// ─── 5. Stopped ────────────────────────────────────────────────────────────

describe("X-Export-Stopped", () => {
  it("is absent when the pool ran to completion", async () => {
    const headers = await headersFor(
      fetchResult({
        sources: [source("a")],
        failures: [failure("b", "APPLE_ERROR")],
        stopped: false,
      }),
    );

    // ⚠ A failure is NOT a stop. The header's absence is what says so.
    expect(headers.has("X-Export-Stopped")).toBe(false);
  });

  it("is 'rate_limit' when the pool's own latch tripped", async () => {
    const headers = await headersFor(
      fetchResult({
        sources: [source("a")],
        failures: [failure("b", "NOT_ATTEMPTED")],
        stopped: true,
      }),
    );

    expect(headers.get("X-Export-Stopped")).toBe("rate_limit");
  });

  it("reads the pool's latch, never re-derives it from the rows", async () => {
    // stopped=true with ZERO not-attempted rows: the latch tripped on the last
    // item, so there was no remainder. Deriving "stopped" from
    // `notAttempted > 0` would call this a clean run.
    const headers = await headersFor(
      fetchResult({
        sources: [source("a"), source("b")],
        failures: [failure("c", "RATE_LIMITED")],
        stopped: true,
      }),
    );

    expect(headers.get("X-Export-Stopped")).toBe("rate_limit");
    expect(headers.get("X-Export-Not-Attempted-Count")).toBe("0");
  });
});

// ─── 6. The stopped-run fixture — all five at once ─────────────────────────

describe("a stopped run reports all five headers coherently", () => {
  /**
   * ⚠ THE SHAPE THAT MOTIVATED THE SPLIT. Apple's budget ran out partway:
   *
   *   4 items exported     — 1 of them missing prices
   *   1 item refused       — asked, 429 survived retry
   *   3 items never sent   — the pool had already stopped
   *
   * Reported as one number this is "8 items, some problem". Reported as five
   * it says exactly which 3 are safe to re-export and which 1 needs a human.
   */
  const STOPPED_RUN = fetchResult({
    sources: [
      source("s1"),
      source("s2"),
      source("s3"),
      source("s4", { priceReadFailure: PRICE_RATE_LIMITED }),
    ],
    failures: [
      failure("f1", "RATE_LIMITED"),
      failure("n1", "NOT_ATTEMPTED"),
      failure("n2", "NOT_ATTEMPTED"),
      failure("n3", "NOT_ATTEMPTED"),
    ],
    stopped: true,
  });

  it("exported 4 (1 partial), refused 1, never sent 3, and says it stopped", async () => {
    const headers = await headersFor(STOPPED_RUN);

    expect(headers.get("X-Export-Item-Count")).toBe("4");
    expect(headers.get("X-Export-Partial-Count")).toBe("1");
    expect(headers.get("X-Export-Failed-Count")).toBe("1");
    expect(headers.get("X-Export-Not-Attempted-Count")).toBe("3");
    expect(headers.get("X-Export-Stopped")).toBe("rate_limit");
  });

  it("the four counts stay disjoint — no item is reported twice, none vanishes", async () => {
    const headers = await headersFor(STOPPED_RUN);

    const exported = Number(headers.get("X-Export-Item-Count"));
    const failed = Number(headers.get("X-Export-Failed-Count"));
    const notAttempted = Number(headers.get("X-Export-Not-Attempted-Count"));
    const partial = Number(headers.get("X-Export-Partial-Count"));

    // exported + failed + notAttempted accounts for every item the fetch saw.
    // `partial` is a PROPERTY OF exported rows, deliberately NOT a fourth
    // disjoint bucket — so it must not appear in this sum.
    expect(exported + failed + notAttempted).toBe(8);
    expect(partial).toBeLessThanOrEqual(exported);
  });

  it("still returns the workbook, not an error — a stopped run is a delivery", async () => {
    fetchExportSources.mockResolvedValue(STOPPED_RUN);
    const res = await POST(req(), CTX);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")).toContain(".xlsx");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
