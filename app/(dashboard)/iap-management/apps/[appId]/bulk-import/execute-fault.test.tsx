// @vitest-environment jsdom

/**
 * [BULK-IMPORT-no-result-recovery] chunk 1 — every exit from `handleExecute`
 * must leave a signal the Manager can still read five minutes later.
 *
 * ⚠ THE INCIDENT, IN NUMBERS. 2026-09-21, Apple bulk import, three batches:
 *
 *     155fc261  13:32:56   84 rows   wall 04:33   status COMPLETE
 *     f8a8d73e  13:44:33   88 rows   wall 05:53   status COMPLETE
 *     85f86454  13:52:21   88 rows   wall 04:56   status COMPLETE
 *
 * All three finished server-side — `accounted = total_rows`, hub-tracking's
 * `finally` observed in the Railway logs. The Manager saw step 4 come back
 * three times and re-ran the import twice, because nothing on screen said the
 * first pass had already landed.
 *
 * Three exits produced that, and one of them produced NOTHING AT ALL:
 *
 *   1. `await res.json()` ran BEFORE `if (!res.ok)`, so a gateway page threw
 *      `SyntaxError` before the status was read. Signal: a toast reading
 *      `Unexpected token '<'`, which then timed out.
 *   2. `if ("succeeded" in data)` had NO `else`. A 2xx body in any other
 *      shape fell through to `finally`: no toast, no log, no state change.
 *   3. `catch` raised a toast — and sonner is mounted without a `duration`
 *      override (app/(dashboard)/iap-management/layout.tsx:27), so for a
 *      five-minute request the signal expires unread.
 *
 * ⚠ THE ASSERTIONS ARE ABOUT PERSISTENCE, NOT ABOUT WORDING. Each case checks
 * that the panel is in the DOM, that it names the real event rather than the
 * parser's complaint, that it says the work may already be on Apple, and that
 * Execute is barred until that is acknowledged. A toast passing any of those
 * would be the regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { IapItemsParseResult } from "@/lib/iap-management/parsers/iap-items";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";

const routerPush = vi.hoisted(() => vi.fn());
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning },
}));

const parseIapItemsXlsx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/parsers/iap-items", () => ({ parseIapItemsXlsx }));

const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xlsx-template")>();
  return { ...actual, downloadXlsxTemplate };
});

import { BulkImportWizard } from "./BulkImportWizard";

const START_URL = "/api/iap-management/hub-tracking/start";
const CANCEL_URL = "/api/iap-management/hub-tracking/cancel";
const TERRITORIES_URL = "/api/iap-management/territories";
const EXECUTE_URL_FRAGMENT = "/bulk-import/execute";
const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

const MINIMAL_PARSE_RESULT: IapItemsParseResult = {
  items: [
    {
      row_index: 1,
      product_id: "com.vng.test.item",
      reference_name: "Test Item",
      type: "CONSUMABLE",
      type_source: "DEFAULT",
      price_usd: 0,
      base_price: 0,
      base_currency: "USD",
      localizations: [],
      warnings: [],
    },
  ],
  skipped_locales: [],
  locale_pair_count: 0,
  warnings: [],
  sample_rows_skipped: [],
};

const EMPTY_TIERS: Record<PricingSourceKind, UsdTierEntry[]> = {
  APPLE: [],
  DEFAULT_TEMPLATE: [],
  APP_TEMPLATE: [],
};

/**
 * ⚠ A RAW-BODY STUB, BECAUSE THE BODY IS THE POINT.
 *
 * `handleExecute` reads `res.text()` and parses it itself, so a stub that
 * only answers `json()` cannot express the exact failure case #1 describes —
 * a body that is not JSON. P44: a probe on the wrong seam reports a harness
 * bug in a product bug's clothing, which is how the first draft of this file
 * "found" a renderer defect that did not exist.
 */
function rawResponse(raw: string, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

type ExecuteStub = () => unknown;

function installFetchMock(executeResponse: ExecuteStub) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(TERRITORIES_URL)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ territoryIds: CATALOGUE }),
        text: async () => JSON.stringify({ territoryIds: CATALOGUE }),
      });
    }
    if (url.includes(START_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ run_id: "run-1" }) });
    }
    if (url.includes(CANCEL_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes(EXECUTE_URL_FRAGMENT)) {
      const r = executeResponse();
      return r instanceof Promise ? r : Promise.resolve(r);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function driveToExecute(executeResponse: ExecuteStub) {
  const fetchMock = installFetchMock(executeResponse);
  const { container } = render(
    <BulkImportWizard
      appId="999"
      appName="Test App"
      existingProductIds={[]}
      usdTiersBySource={EMPTY_TIERS}
    />,
  );

  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("dropzone file input not found");
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(["x"], "items.xlsx")] } });
    await Promise.resolve();
  });

  // Excel → Screenshots → Preview → Territories.
  for (let i = 0; i < 3; i++) {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  }
  await waitFor(() =>
    expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
  );

  const execute = await screen.findByRole("button", { name: /Execute|Run again/ });
  await act(async () => {
    fireEvent.click(execute);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return fetchMock;
}

function panel() {
  return screen.getByTestId("execute-fault");
}

beforeEach(() => {
  routerPush.mockReset();
  routerRefresh.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  toastWarning.mockReset();
  parseIapItemsXlsx.mockReset();
  parseIapItemsXlsx.mockResolvedValue(MINIMAL_PARSE_RESULT);
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── case 2: the exit with no signal at all ─────────────────────────────────

describe("2xx body that is not an import summary — THE SILENT PATH", () => {
  const BODY = JSON.stringify({ ok: true, note: "not a summary" });

  it("⚠ raises a persistent panel where there used to be nothing", async () => {
    // `if ("succeeded" in data)` had no `else`. This body reached `finally`
    // and the wizard sat back down on step 4 as if the click never happened.
    await driveToExecute(() => rawResponse(BODY));
    expect(panel()).toBeInTheDocument();
    expect(panel()).toHaveAttribute("data-fault-kind", "unexpected-shape");
  });

  it("⚠ says the work may already be on Apple — the sentence that stops a blind re-run", async () => {
    await driveToExecute(() => rawResponse(BODY));
    expect(panel()).toHaveTextContent(/may have finished on the server/i);
    expect(panel()).toHaveTextContent(/Check there before running this import again/i);
  });

  it("⚠ bars Execute until acknowledged, and the label says it is a re-run", async () => {
    await driveToExecute(() => rawResponse(BODY));
    const button = screen.getByRole("button", { name: /Run again/ });
    expect(button).toBeDisabled();

    fireEvent.click(screen.getByTestId("execute-fault-ack"));
    expect(screen.getByRole("button", { name: /Run again/ })).not.toBeDisabled();
  });

  it("recovers batch_id from a non-summary payload when one is present", async () => {
    await driveToExecute(() =>
      rawResponse(JSON.stringify({ batch_id: "85f86454-dead-beef", partial: 20 })),
    );
    expect(screen.getByTestId("execute-fault-batch-id")).toHaveTextContent(
      "85f86454-dead-beef",
    );
  });

  it("does not advance to the result screen", async () => {
    await driveToExecute(() => rawResponse(BODY));
    expect(screen.queryByText(/Import complete/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument();
  });
});

// ─── case 1: a gateway page, parsed before the status was read ──────────────

describe("non-JSON body — the 502/504 gateway page", () => {
  const HTML = "<html><head><title>504 Gateway Time-out</title></head><body>nginx</body></html>";

  it("⚠ names the STATUS and the fact it is not JSON, not the parser's complaint", async () => {
    await driveToExecute(() => rawResponse(HTML, { ok: false, status: 504 }));
    expect(panel()).toHaveAttribute("data-fault-kind", "unreadable-body");
    expect(panel()).toHaveTextContent(/HTTP 504/);
    expect(panel()).toHaveTextContent(/not JSON/i);
    // The old signal, verbatim. Its return is the regression.
    expect(panel()).not.toHaveTextContent(/Unexpected token/i);
  });

  it("shows the body excerpt, so the proxy identifies itself", async () => {
    await driveToExecute(() => rawResponse(HTML, { ok: false, status: 504 }));
    expect(panel()).toHaveTextContent(/504 Gateway Time-out/);
  });

  it("⚠ still bars the re-run — a timed-out proxy says nothing about the batch", async () => {
    // The server has no AbortSignal and no maxDuration: the proxy giving up
    // does not stop the import. This is the case where re-running blind is
    // most expensive and most tempting.
    await driveToExecute(() => rawResponse(HTML, { ok: false, status: 504 }));
    expect(screen.getByRole("button", { name: /Run again/ })).toBeDisabled();
  });
});

// ─── case 3: fetch itself rejected ──────────────────────────────────────────

describe("transport failure — fetch rejects", () => {
  it("⚠ persists instead of a self-dismissing toast", async () => {
    await driveToExecute(() => Promise.reject(new Error("Failed to fetch")));
    expect(panel()).toHaveAttribute("data-fault-kind", "transport");
    expect(panel()).toHaveTextContent(/Failed to fetch/);
    expect(panel()).toHaveTextContent(/may have finished on the server/i);
  });
});

// ─── the success path is untouched ──────────────────────────────────────────

describe("a real summary still reaches the result screen", () => {
  it("advances to step 5 and raises no fault panel", async () => {
    await driveToExecute(() =>
      rawResponse(
        JSON.stringify({
          batch_id: "batch-1",
          total: 1,
          succeeded: 1,
          failed: 0,
          skipped: 0,
          results: [
            { product_id: "com.vng.test.item", status: "SUCCESS", disposition: "CREATE" },
          ],
        }),
      ),
    );
    expect(screen.queryByTestId("execute-fault")).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalled();
    expect(routerRefresh).toHaveBeenCalled();
  });
});
