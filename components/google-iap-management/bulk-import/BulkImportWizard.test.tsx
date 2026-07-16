// @vitest-environment jsdom

/**
 * Hub-tracking regression suite for the Google bulk-import wizard,
 * mirroring app/(dashboard)/iap-management/apps/[appId]/bulk-import/
 * BulkImportWizard.test.tsx (Apple) — proves the SAME permanent-ref guard
 * is applied here from day one, since Google's wizard previously had no
 * cancel-on-exit affordance at all (the pre-fix Apple shape). Also covers
 * the drag-drop bug fix (Part B): dropping a file must be handled by the
 * app, never fall through to the browser's default navigation/download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const routerPush = vi.hoisted(() => vi.fn());
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

import { BulkImportWizard } from "./BulkImportWizard";

const START_URL = "/api/google-iap-management/hub-tracking/start";
const CANCEL_URL = "/api/google-iap-management/hub-tracking/cancel";
const PREVIEW_URL_FRAGMENT = "/bulk-import/preview";
const EXECUTE_URL_FRAGMENT = "/bulk-import/execute";
const AVAILABILITY_URL_FRAGMENT = "/pricing-templates/availability";

function previewResponse() {
  return {
    ok: true,
    json: async () => ({
      rows: [
        {
          rowNumber: 1,
          sku: "sku1",
          baseCurrency: "USD",
          basePriceDecimal: "0.99",
          regionOverrides: [],
          listings: [],
          exists: false,
          tierCandidates: [],
          defaultTierSelection: null,
          tierMatchedBy: "none",
        },
      ],
      warnings: [],
    }),
  };
}

function successExecuteResponse() {
  return {
    ok: true,
    json: async () => ({
      rowsTotal: 1,
      rowsCreated: 1,
      rowsOverwritten: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      rowsRefused: 0,
      refusedRows: [],
      durationMs: 42,
    }),
  };
}

function failureExecuteResponse() {
  return { ok: false, status: 502, json: async () => ({ error: "Google API sync failed" }) };
}

interface FetchScenario {
  runId: string | null;
  executeResponse: () => { ok: boolean; status?: number; json: () => Promise<unknown> };
}

function installFetchMock(scenario: FetchScenario) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes(AVAILABILITY_URL_FRAGMENT)) {
      return Promise.resolve({ ok: false, json: async () => ({}) });
    }
    if (url.includes(START_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ run_id: scenario.runId }) });
    }
    if (url.includes(CANCEL_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes(PREVIEW_URL_FRAGMENT)) {
      return Promise.resolve(previewResponse());
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
      packageName="com.example.app"
      appId="app-uuid-1"
      appDisplayName="Test App"
      appDefaultCurrency="USD"
      appDefaultLanguage="en-US"
    />,
  );
}

async function goToUploadStep() {
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  await waitFor(() => expect(screen.getByText(/Upload Excel file/)).toBeInTheDocument());
}

function selectFile(container: HTMLElement, name = "items.xlsx") {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  const file = new File(["x"], name);
  fireEvent.change(input, { target: { files: [file] } });
}

async function goToPreviewAndAdoptRun(container: HTMLElement, fetchMock: ReturnType<typeof vi.fn>) {
  await goToUploadStep();
  selectFile(container);
  await waitFor(() => expect(screen.getByRole("button", { name: /Preview/ })).not.toBeDisabled());

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  await waitFor(() =>
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true),
  );
  // Flush the start fetch's .then chain so hubRunId adoption commits.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeInTheDocument());
}

async function clickExecuteAndSettle() {
  const executeButton = await screen.findByRole("button", { name: /Push to Google Play/ });
  await act(async () => {
    fireEvent.click(executeButton);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  routerPush.mockReset();
  routerRefresh.mockReset();
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BulkImportWizard (Google) — Hub tracking cancel-on-exit guard", () => {
  it("genuine abandonment BEFORE executing (exit at upload/preview step) still sends CANCELLED", async () => {
    const fetchMock = installFetchMock({ runId: "run-abandon", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "Back to Test App" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(true),
    );
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-abandon",
    });
    expect(routerPush).toHaveBeenCalledWith("/google-iap-management/apps/com.example.app");
  });

  it("genuine abandonment BEFORE executing via beforeunload still sends CANCELLED", async () => {
    const fetchMock = installFetchMock({ runId: "run-beacon", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);

    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).toHaveBeenCalledTimes(1);
    const [, blob] = (window.navigator.sendBeacon as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = await (blob as Blob).text();
    expect(JSON.parse(text)).toEqual({ run_id: "run-beacon" });
  });

  it("a SUCCESSFUL import does NOT send a spurious cancel on subsequent exit", async () => {
    const fetchMock = installFetchMock({ runId: "run-success", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();

    fireEvent.click(screen.getByRole("button", { name: "Back to Test App" }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
    expect(routerPush).toHaveBeenCalledWith("/google-iap-management/apps/com.example.app");
  });

  it("a SUCCESSFUL import does NOT send a spurious cancel via beforeunload either", async () => {
    const fetchMock = installFetchMock({ runId: "run-success-2", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();

    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it("a FAILED execute response (non-2xx, step reverts to preview) does NOT send a spurious cancel", async () => {
    // This is the exact regression the permanent-ref guard closes: a
    // failed response reverts step to "preview" (never reaches "done")
    // and `executing` resets to false in `finally` — a transient guard
    // would have re-opened here even though the server's own `finally`
    // already closed the run as FAILED.
    const fetchMock = installFetchMock({ runId: "run-failed", executeResponse: failureExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();

    fireEvent.click(screen.getByRole("button", { name: "Back to Test App" }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
  });

  it("no double-close: zero cancel calls once executed, regardless of exit + beforeunload both firing", async () => {
    const fetchMock = installFetchMock({ runId: "run-once", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();

    fireEvent.click(screen.getByRole("button", { name: "Back to Test App" }));
    window.dispatchEvent(new Event("beforeunload"));

    const cancelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes(CANCEL_URL));
    expect(cancelCalls).toHaveLength(0);
  });

  it("start resolving DURING the ≤1s capped await window is threaded into execute — SUCCESS with the real id, not SKIP", async () => {
    // Reported-bug regression: a fast click reaching Execute before
    // /hub-tracking/start resolves must still get the real run_id, as
    // long as start settles within the 1s cap.
    let resolveStart!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const startPromise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(AVAILABILITY_URL_FRAGMENT)) return Promise.resolve({ ok: false, json: async () => ({}) });
      if (url.includes(START_URL)) return startPromise;
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(PREVIEW_URL_FRAGMENT)) return Promise.resolve(previewResponse());
      if (url.includes(EXECUTE_URL_FRAGMENT)) return Promise.resolve(successExecuteResponse());
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderWizard();
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /Preview/ })).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Preview/ })); // start fetch now in flight
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeInTheDocument());

    const executeButton = await screen.findByRole("button", { name: /Push to Google Play/ });
    fireEvent.click(executeButton); // handleExecute begins its capped await (start still pending)

    // Resolve start QUICKLY — well within the 1s cap (real elapsed time
    // here is milliseconds, nowhere near the 1000ms ceiling).
    await new Promise((resolve) => setTimeout(resolve, 20));
    await act(async () => {
      resolveStart({ ok: true, json: async () => ({ run_id: "run-in-time" }) });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT))).toBe(true),
    );
    const executeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT))!;
    const executeBody = JSON.parse((executeCall[1] as RequestInit).body as string);
    expect(executeBody.hub_run_id).toBe("run-in-time");
  });

  it(
    "Part 1 fix: a start response resolving AFTER the 1s cap elapsed is dropped SILENTLY — never cancelled (the exact reported bug)",
    async () => {
      // This is the precise mechanism from the production logs: start
      // hasn't resolved by the time Execute is clicked, the 1s cap in
      // handleExecute elapses first (execute proceeds with hub_run_id:
      // null — a MISSED track), and only afterward does the slow start
      // response finally arrive. It must NOT send CANCELLED — that run
      // is real and was actively executing/succeeding.
      let resolveStart!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
      const startPromise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
        resolveStart = resolve;
      });
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(AVAILABILITY_URL_FRAGMENT)) return Promise.resolve({ ok: false, json: async () => ({}) });
        if (url.includes(START_URL)) return startPromise; // hangs until resolveStart() below
        if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
        if (url.includes(PREVIEW_URL_FRAGMENT)) return Promise.resolve(previewResponse());
        if (url.includes(EXECUTE_URL_FRAGMENT)) return Promise.resolve(successExecuteResponse());
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      const { container } = renderWizard();
      await goToUploadStep();
      selectFile(container);
      await waitFor(() => expect(screen.getByRole("button", { name: /Preview/ })).not.toBeDisabled());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Preview/ })); // start fetch now in flight (hangs)
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeInTheDocument());

      const executeButton = await screen.findByRole("button", { name: /Push to Google Play/ });
      const clickedAt = Date.now();
      fireEvent.click(executeButton); // handleExecute's 1s cap starts now

      // The execute fetch must fire once the cap elapses — proving the
      // import is NOT blocked waiting on the hung start call — and the
      // cap must be the ~1s ceiling, not the full 3s Hub timeout.
      await waitFor(
        () => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT))).toBe(true),
        { timeout: 2000 },
      );
      const elapsedMs = Date.now() - clickedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(950); // the cap genuinely waited ~1s...
      expect(elapsedMs).toBeLessThan(2000); // ...but nowhere near the 3s Hub timeout, and bounded.

      const executeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT))!;
      const executeBody = JSON.parse((executeCall[1] as RequestInit).body as string);
      expect(executeBody.hub_run_id).toBeNull(); // cap won — a MISSED track, not a wrong one.

      // NOW the slow start response finally arrives, long after execute
      // already proceeded without it.
      await act(async () => {
        resolveStart({ ok: true, json: async () => ({ run_id: "run-late-arrival" }) });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Must be dropped silently — no cancel call, ever.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cancelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes(CANCEL_URL));
      expect(cancelCalls).toHaveLength(0);
    },
    8000,
  );

  it("'Import another' resets the tracking state machine for a fresh cycle", async () => {
    const fetchMock = installFetchMock({ runId: "run-first", executeResponse: successExecuteResponse });
    const { container } = renderWizard();

    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();

    fireEvent.click(screen.getByRole("button", { name: /Import another/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Continue/ })).toBeInTheDocument());

    // A fresh cycle: go through upload→preview again, adopting a NEW run.
    installFetchMockRunId(fetchMock, "run-second");
    await goToPreviewAndAdoptRun(container, fetchMock);

    // Genuine abandonment on THIS (second, not-yet-executed) run must still
    // cancel — proving executeStartedRef was reset, not left permanently
    // true from the first import.
    fireEvent.click(screen.getByRole("button", { name: "Back to Test App" }));
    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL));
      expect(cancelCall).toBeTruthy();
      expect(JSON.parse((cancelCall![1] as RequestInit).body as string)).toEqual({
        run_id: "run-second",
      });
    });
  });
});

/** Swaps the run_id the installed fetch mock's /hub-tracking/start branch
 *  resolves with, for the "Import another" second-cycle test. */
function installFetchMockRunId(fetchMock: ReturnType<typeof vi.fn>, runId: string) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(AVAILABILITY_URL_FRAGMENT)) return Promise.resolve({ ok: false, json: async () => ({}) });
    if (url.includes(START_URL)) return Promise.resolve({ ok: true, json: async () => ({ run_id: runId }) });
    if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    if (url.includes(PREVIEW_URL_FRAGMENT)) return Promise.resolve(previewResponse());
    if (url.includes(EXECUTE_URL_FRAGMENT)) return Promise.resolve(successExecuteResponse());
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe("BulkImportWizard (Google) — drag-drop bug fix (Part B)", () => {
  beforeEach(() => {
    installFetchMock({ runId: null, executeResponse: successExecuteResponse });
  });

  it("dropping a file on the dropzone prevents the browser's default handling and imports the file", async () => {
    const { container } = renderWizard();
    await goToUploadStep();

    const dropzone = container.querySelector('label[for="bulk-upload-file"]') as HTMLElement;
    expect(dropzone).toBeTruthy();

    let capturedEvent: Event | null = null;
    dropzone.addEventListener("drop", (e) => {
      capturedEvent = e;
    });

    const file = new File(["x"], "dropped.xlsx");
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    // The actual bug: previously there was no onDrop handler at all, so
    // the browser's default action (navigate to / download the file)
    // fired instead of the app handling it — defaultPrevented would be
    // false and the file would never reach app state.
    expect(capturedEvent).not.toBeNull();
    expect((capturedEvent as unknown as Event).defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByText("dropped.xlsx")).toBeInTheDocument());
  });

  it("dragover also prevents default (required for drop to fire at all in a real browser)", async () => {
    const { container } = renderWizard();
    await goToUploadStep();

    const dropzone = container.querySelector('label[for="bulk-upload-file"]') as HTMLElement;
    let capturedEvent: Event | null = null;
    dropzone.addEventListener("dragover", (e) => {
      capturedEvent = e;
    });

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });

    expect(capturedEvent).not.toBeNull();
    expect((capturedEvent as unknown as Event).defaultPrevented).toBe(true);
  });
});
