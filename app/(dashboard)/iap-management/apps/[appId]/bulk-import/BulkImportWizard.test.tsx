// @vitest-environment jsdom

/**
 * Regression suite for the Hub-tracking "spurious CANCELLED" bug: a
 * SUCCESSFUL bulk import was being recorded as CANCELLED on the Hub
 * instead of SUCCESS.
 *
 * Root cause: the cancel-on-exit guards (beforeunload + the explicit
 * "IAPs · appName" exit link) used `step < 4 && !executing`. `executing`
 * is TRANSIENT — it flips back to `false` in handleExecute's `finally`
 * regardless of outcome (success, failure, or a client-side hiccup
 * reading the response). Once the execute request settled for ANY
 * reason, `executing` went back to false while `step` could still be < 4
 * (any non-2xx response never advances past step 3) — so a SUBSEQUENT
 * exit/tab-close fired a spurious CANCELLED, overwriting whatever real
 * terminal status (including SUCCESS) the execute route's own `finally`
 * had already recorded server-side.
 *
 * Fix: a PERMANENT `executeStartedRef` flag, set true the instant
 * handleExecute is invoked and never reset. Once true, the client never
 * sends cancel for that run again — the server owns the terminal status
 * from that point on, regardless of what happens client-side afterward.
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

import { BulkImportWizard } from "./BulkImportWizard";

const START_URL = "/api/iap-management/hub-tracking/start";
const CANCEL_URL = "/api/iap-management/hub-tracking/cancel";
const EXECUTE_URL_FRAGMENT = "/bulk-import/execute";

const MINIMAL_PARSE_RESULT: IapItemsParseResult = {
  items: [
    {
      row_index: 1,
      product_id: "com.vng.test.item",
      reference_name: "Test Item",
      type: "CONSUMABLE",
      type_source: "DEFAULT",
      price_usd: 0, // resolveTierByUsdPrice(0, ...) => "FREE", no tier list needed
      base_price: 0,
      base_currency: "USD",
      localizations: [],
      warnings: [],
    },
  ],
  skipped_locales: [],
  locale_pair_count: 0,
  warnings: [],
};

const EMPTY_TIERS: Record<PricingSourceKind, UsdTierEntry[]> = {
  APPLE: [],
  DEFAULT_TEMPLATE: [],
  APP_TEMPLATE: [],
};

function successExecuteResponse() {
  return {
    ok: true,
    json: async () => ({
      batch_id: "batch-1",
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      results: [{ product_id: "com.vng.test.item", status: "SUCCESS", disposition: "CREATE" }],
    }),
  };
}

function failureExecuteResponse() {
  return {
    ok: false,
    status: 502,
    json: async () => ({ error: "Apple sync failed" }),
  };
}

interface FetchScenario {
  runId: string | null;
  executeResponse: () => { ok: boolean; status?: number; json: () => Promise<unknown> };
}

function installFetchMock(scenario: FetchScenario) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes(START_URL)) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ run_id: scenario.runId }),
      });
    }
    if (url.includes(CANCEL_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes(EXECUTE_URL_FRAGMENT)) {
      return Promise.resolve(scenario.executeResponse());
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderWizard() {
  return render(
    <BulkImportWizard
      appId="999"
      appName="Test App"
      existingProductIds={[]}
      usdTiersBySource={EMPTY_TIERS}
    />,
  );
}

async function dropExcelFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("dropzone file input not found");
  const file = new File(["x"], "items.xlsx");
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await Promise.resolve();
  });
}

async function goToStep2AndAdoptRun(container: HTMLElement, fetchMock: ReturnType<typeof vi.fn>, runId: string) {
  await dropExcelFile(container);
  await waitFor(() => expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true),
  );
  // Flush the start fetch's .then chain so hubRunId adoption commits.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  void runId;
}

async function goToStep3() {
  await waitFor(() => expect(screen.getByRole("button", { name: /Next/ })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Execute/ })).toBeInTheDocument());
}

async function clickExecuteAndSettle() {
  const executeButton = await screen.findByRole("button", { name: /Execute/ });
  await act(async () => {
    fireEvent.click(executeButton);
    // Let the execute fetch + response handling fully resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
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

describe("BulkImportWizard — Hub tracking cancel-on-exit guard", () => {
  it("genuine abandonment BEFORE executing (exit at step 2) still sends CANCELLED", async () => {
    const fetchMock = installFetchMock({ runId: "run-abandon", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToStep2AndAdoptRun(container, fetchMock, "run-abandon");

    fireEvent.click(screen.getByRole("button", { name: /^IAPs ·/ }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(true),
    );
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-abandon",
    });
    expect(routerPush).toHaveBeenCalledWith("/iap-management/apps/999");
  });

  it("genuine abandonment BEFORE executing via beforeunload still sends CANCELLED", async () => {
    const fetchMock = installFetchMock({ runId: "run-beacon", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToStep2AndAdoptRun(container, fetchMock, "run-beacon");

    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).toHaveBeenCalledTimes(1);
    const [, blob] = (window.navigator.sendBeacon as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = await (blob as Blob).text();
    expect(JSON.parse(text)).toEqual({ run_id: "run-beacon" });
  });

  it("a SUCCESSFUL import does NOT send a spurious cancel on subsequent exit (the reported bug)", async () => {
    const fetchMock = installFetchMock({ runId: "run-success", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToStep2AndAdoptRun(container, fetchMock, "run-success");
    await goToStep3();
    await clickExecuteAndSettle();

    expect(toastSuccess).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^IAPs ·/ }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
    expect(routerPush).toHaveBeenCalledWith("/iap-management/apps/999");
  });

  it("a SUCCESSFUL import does NOT send a spurious cancel via beforeunload either", async () => {
    const fetchMock = installFetchMock({ runId: "run-success-2", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToStep2AndAdoptRun(container, fetchMock, "run-success-2");
    await goToStep3();
    await clickExecuteAndSettle();

    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it("a FAILED execute response (non-2xx) does NOT send a spurious cancel on subsequent exit", async () => {
    // This is the exact regression the fix closes: the OLD guard
    // (`step < 4 && !executing`) would have fired here, since a failed
    // response never advances `step` past 3 and `executing` resets to
    // false in `finally` — even though the server's own `finally` had
    // already closed the run as FAILED.
    const fetchMock = installFetchMock({ runId: "run-failed", executeResponse: failureExecuteResponse });
    const { container } = renderWizard();

    await goToStep2AndAdoptRun(container, fetchMock, "run-failed");
    await goToStep3();
    await clickExecuteAndSettle();

    expect(toastError).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^IAPs ·/ }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
  });

  it("no double-close: exactly one cancel call for a genuine pre-execution abandonment, none once executed", async () => {
    const fetchMock = installFetchMock({ runId: "run-once", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToStep2AndAdoptRun(container, fetchMock, "run-once");
    await goToStep3();
    await clickExecuteAndSettle();

    fireEvent.click(screen.getByRole("button", { name: /^IAPs ·/ }));
    window.dispatchEvent(new Event("beforeunload"));

    const cancelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes(CANCEL_URL));
    expect(cancelCalls).toHaveLength(0);
  });

  it("a start response that resolves AFTER execute already began is not adopted, and is cancelled instead", async () => {
    let resolveStart!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const startPromise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(START_URL)) return startPromise;
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(EXECUTE_URL_FRAGMENT)) return Promise.resolve(successExecuteResponse());
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderWizard();
    await dropExcelFile(container);
    fireEvent.click(screen.getByRole("button", { name: /Next/ })); // step 1→2, start fetch in flight
    await goToStep3();
    await clickExecuteAndSettle(); // execute already ran with hub_run_id="" (never adopted)

    // NOW the slow start response finally arrives, racing in after execute.
    await act(async () => {
      resolveStart({ ok: true, json: async () => ({ run_id: "run-race-loser" }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(true),
    );
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-race-loser",
    });

    // And the race-lost run must NOT have been adopted into state — a
    // subsequent exit sends no FURTHER cancel for it.
    fireEvent.click(screen.getByRole("button", { name: /^IAPs ·/ }));
    const cancelCallsAfterExit = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes(CANCEL_URL),
    );
    expect(cancelCallsAfterExit).toHaveLength(1);
  });
});
