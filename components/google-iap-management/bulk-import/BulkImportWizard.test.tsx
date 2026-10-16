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
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";

const routerPush = vi.hoisted(() => vi.fn());
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

// Partial mock: keep the real consts (template-spec imports
// TEMPLATE_SAMPLE_PRODUCT_IDS at load), intercept only the download.
const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xlsx-template")>();
  return { ...actual, downloadXlsxTemplate };
});

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

function renderWizard(
  mirror: {
    iapsLastSyncedAt: string | null;
    iapsSyncReadError?: string | null;
    /** apps.default_currency as the page passes it (undefined ⇒ "USD"). */
    appCurrency?: string | null;
  } = {
    // D0 — default scenario: the IAP list HAS been refreshed.
    iapsLastSyncedAt: "2026-10-16T03:25:10.000Z",
  },
) {
  return render(
    <BulkImportWizard
      packageName="com.example.app"
      appId="app-uuid-1"
      appDisplayName="Test App"
      appDefaultCurrency={mirror.appCurrency === undefined ? "USD" : mirror.appCurrency}
      iapsLastSyncedAt={mirror.iapsLastSyncedAt}
      iapsSyncReadError={mirror.iapsSyncReadError ?? null}
    />,
  );
}

async function goToUploadStep() {
  // Part A: Continue is gated until the pricing-template availability check
  // resolves — the wizard must not advance on a source nobody chose. These
  // scenarios mock availability as a failed response, which lands in the
  // error state and enables Google Conversion (A4), so Continue becomes
  // usable; it just isn't usable SYNCHRONOUSLY any more.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled(),
  );
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

describe("BulkImportWizard (Google) — template download call site", () => {
  it("renders the shared Download template button in the wizard header at step 1 (moved out of step 2 per Manager UAT)", () => {
    renderWizard();
    // Step 1 is "Pricing source" — the button previously only appeared
    // at step 2 (Upload). Header placement makes it visible immediately.
    expect(
      screen.getByRole("button", { name: /download template/i }),
    ).toBeInTheDocument();
  });

  it("is wired to the GOOGLE spec (getSpec is a factory prop — a cross-wired spec would pass render tests)", async () => {
    downloadXlsxTemplate.mockClear();
    renderWizard();
    // Header trigger opens the locale picker; confirm with nothing ticked
    // (default zero-locale path) → CORE-ONLY Google template.
    fireEvent.click(
      screen.getByRole("button", { name: /^Download template$/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Download template \(/i }),
    );
    await waitFor(() => expect(downloadXlsxTemplate).toHaveBeenCalled());
    const spec = downloadXlsxTemplate.mock.calls[0][0];
    expect(spec.filename).toBe("google-iap-bulk-import-template-core.xlsx");
    expect(spec.headers.length).toBe(4);
    expect(spec.headers).toContain("Price (USD)");
    expect(spec.headers).not.toContain("Reference Name"); // Apple-only
  });
});

/** Preview response whose row already EXISTS on Google, with per-row
 *  listings controllable — drives the listing-loss warning. */
function existingRowPreviewResponse(listings: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      rows: [
        {
          rowNumber: 1,
          sku: "sku.exists",
          baseCurrency: "USD",
          basePriceDecimal: "0.99",
          regionOverrides: [],
          listings,
          exists: true,
          tierCandidates: [],
          defaultTierSelection: null,
          tierMatchedBy: "none",
        },
      ],
      warnings: [],
    }),
  };
}

function installPreviewFetchMock(listings: unknown[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(AVAILABILITY_URL_FRAGMENT)) {
      return Promise.resolve({ ok: false, json: async () => ({}) });
    }
    if (url.includes(START_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ run_id: null }) });
    }
    if (url.includes(CANCEL_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes(PREVIEW_URL_FRAGMENT)) {
      return Promise.resolve(existingRowPreviewResponse(listings));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LISTING_LOSS_RE = /existing store listings will be REPLACED/i;

describe("BulkImportWizard (Google) — listing-loss warning (risk I.1)", () => {
  /** Reach Preview with a single row that already exists on Google. */
  async function reachPreview(listings: unknown[]) {
    const fetchMock = installPreviewFetchMock(listings);
    const { container } = renderWizard();
    await goToUploadStep();
    selectFile(container);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Preview/ })).not.toBeDisabled(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByText(/Set all to Overwrite/)).toBeInTheDocument(),
    );
    return fetchMock;
  }

  it("does NOT fire while the existing row is still pending a decision", async () => {
    await reachPreview([]);
    expect(screen.queryByText(LISTING_LOSS_RE)).not.toBeInTheDocument();
  });

  it("FIRES once the row is set to Overwrite and carries no locale data — and names the SKU", async () => {
    await reachPreview([]);
    fireEvent.click(screen.getByRole("button", { name: /Set all to Overwrite/ }));
    await waitFor(() =>
      expect(screen.getByText(LISTING_LOSS_RE)).toBeInTheDocument(),
    );
    // The SKU is named INSIDE the warning banner (it also appears in the
    // preview table, hence the scoped assertion).
    expect(
      within(screen.getByRole("alert")).getByText("sku.exists"),
    ).toBeInTheDocument();
    // Warning, not a block: execute stays available.
    expect(
      screen.getByRole("button", { name: /Push to Google Play/ }),
    ).toBeInTheDocument();
  });

  it("does NOT fire for Overwrite rows that DO carry locale data", async () => {
    await reachPreview([{ locale: "vi", title: "Kim cương", description: "d" }]);
    fireEvent.click(screen.getByRole("button", { name: /Set all to Overwrite/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(LISTING_LOSS_RE)).not.toBeInTheDocument();
  });

  it("does NOT fire when the row is set to Skip (nothing is written)", async () => {
    await reachPreview([]);
    fireEvent.click(screen.getByRole("button", { name: /Set all to Skip/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText(LISTING_LOSS_RE)).not.toBeInTheDocument();
  });
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

/**
 * D0 + D3 [arc-google-missing-purchase-options] — the wizard must not let a
 * Preview run while the IAP mirror cannot say which SKUs exist, and must say
 * WHEN the list it relies on was read. Incident: never-refreshed mirror ⇒
 * 28/28 NEW ⇒ 28 CREATEs onto products that already existed on Google.
 */
describe("BulkImportWizard (Google) — D0/D3 IAP mirror sync gate", () => {
  const REFRESH_URL_FRAGMENT = "/iaps/refresh";

  function installMirrorFetch(opts: {
    refresh?: () => { ok: boolean; status?: number; json: () => Promise<unknown> };
    preview?: () => { ok: boolean; status?: number; json: () => Promise<unknown> };
  }) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(AVAILABILITY_URL_FRAGMENT)) {
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }
      if (url.includes(REFRESH_URL_FRAGMENT) && opts.refresh) return Promise.resolve(opts.refresh());
      if (url.includes(PREVIEW_URL_FRAGMENT) && opts.preview) return Promise.resolve(opts.preview());
      if (url.includes(START_URL)) {
        return Promise.resolve({ ok: true, json: async () => ({ run_id: null }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("never refreshed ⇒ amber banner, and Preview stays DISABLED even with a file selected", async () => {
    installMirrorFetch({});
    const { container } = renderWizard({ iapsLastSyncedAt: null });
    const banner = screen.getByTestId("mirror-sync-banner");
    expect(banner).toHaveAttribute("data-state", "never");
    expect(banner).toHaveTextContent(/no complete refresh from Google on record/);
    expect(within(banner).getByRole("button", { name: /Refresh IAP list/ })).toBeEnabled();

    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByText("items.xlsx")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Preview/ })).toBeDisabled();
  });

  it("sync state UNREADABLE ⇒ red banner naming the error, Preview disabled (not treated as never, not as synced)", async () => {
    installMirrorFetch({});
    const { container } = renderWizard({
      iapsLastSyncedAt: null,
      iapsSyncReadError: "column apps.iaps_last_synced_at does not exist",
    });
    const banner = screen.getByTestId("mirror-sync-banner");
    expect(banner).toHaveAttribute("data-state", "unreadable");
    expect(banner).toHaveTextContent(/does not exist/);
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByText("items.xlsx")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Preview/ })).toBeDisabled();
  });

  it("refreshed ⇒ neutral banner with the refresh time; Preview enabled once a file is chosen", async () => {
    installMirrorFetch({});
    const { container } = renderWizard();
    const banner = screen.getByTestId("mirror-sync-banner");
    expect(banner).toHaveAttribute("data-state", "synced");
    expect(banner).toHaveTextContent(/IAP list last refreshed completely from Google/);
    expect(banner.querySelector("time")).toHaveAttribute("dateTime", "2026-10-16T03:25:10.000Z");
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
  });

  it("in-wizard Refresh with a COMPLETE mirror unblocks Preview and refreshes the page data", async () => {
    installMirrorFetch({
      refresh: () => ({
        ok: true,
        json: async () => ({
          ok: true, synced: 28, failed: 0, total: 28,
          mirror_complete: true, mirror_synced_at: "2026-10-16T09:00:00.000Z",
        }),
      }),
    });
    const { container } = renderWizard({ iapsLastSyncedAt: null });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Refresh IAP list/ }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("mirror-sync-banner")).toHaveAttribute("data-state", "synced"),
    );
    expect(routerRefresh).toHaveBeenCalled();
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
  });

  it("Refresh that answered 200 but with failed items does NOT unblock (status must reflect the real outcome)", async () => {
    installMirrorFetch({
      refresh: () => ({
        ok: true,
        json: async () => ({
          ok: true, synced: 0, failed: 28, total: 28,
          mirror_complete: false, mirror_synced_at: null,
        }),
      }),
    });
    renderWizard({ iapsLastSyncedAt: null });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Refresh IAP list/ }));
    });
    const banner = await screen.findByTestId("mirror-sync-banner");
    await waitFor(() => expect(banner).toHaveTextContent(/28 item\(s\) that could not be cached/));
    expect(banner).toHaveAttribute("data-state", "never");
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("server says IAPS_NEVER_SYNCED (stale page) ⇒ the wizard re-blocks instead of trusting its page-load state", async () => {
    installMirrorFetch({
      preview: () => ({
        ok: false,
        status: 409,
        json: async () => ({
          code: "IAPS_NEVER_SYNCED",
          error: "The IAP list of com.example.app has never been refreshed from Google…",
        }),
      }),
    });
    const { container } = renderWizard();
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("mirror-sync-banner")).toHaveAttribute("data-state", "never"),
    );
    expect(screen.getByRole("button", { name: /^Preview/ })).toBeDisabled();
  });
});

/**
 * C2.1 [arc-google-missing-purchase-options] — the app's currency/language are
 * NOT import conditions (Manager 2026-10-16). The wizard only describes, in a
 * neutral note, how prices are read TODAY (H4.6) — measured behaviour, with the
 * app's currency still taking part until the H4 fix ships.
 */
describe("BulkImportWizard (Google) — C2.1 pricing note, no currency/language gate", () => {
  function installBasicFetch(
    preview?: () => { ok: boolean; status?: number; json: () => Promise<unknown> },
  ) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(AVAILABILITY_URL_FRAGMENT)) {
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }
      if (url.includes(PREVIEW_URL_FRAGMENT) && preview) return Promise.resolve(preview());
      if (url.includes(START_URL)) {
        return Promise.resolve({ ok: true, json: async () => ({ run_id: null }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it.each([["TWD"], [null]])(
    "app currency %s ⇒ Preview ENABLED once the IAP list is refreshed — no currency/language banner, no block",
    async (appCurrency) => {
      installBasicFetch();
      const { container } = renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z", appCurrency });
      expect(screen.queryByTestId("app-defaults-banner")).toBeNull();
      await goToUploadStep();
      selectFile(container);
      await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    },
  );

  // Every sentence is MEASURED behaviour of today's pricing code (H4 census,
  // adversarially verified, 2026-10-16). Pinned verbatim so that no wording —
  // and no pricing change (the H4 fix) — can land without editing this test.
  const LEAD =
    "How prices are read from the file. The first Price (XXX) column (e.g. Price (USD)) is used, in that currency; " +
    "a Price / Default Price / Base Price column is used only when there is none, and any other price column is " +
    "ignored without a warning. GT Price + GT Currency override their one country with Google Conversion; with a " +
    "pricing template the tier's price is used instead.";
  const withCurrency = (x: string, decimals: string) =>
    LEAD +
    `A Price column is read as this app's currency, ${x} (shown on the app page — it may still be a tool guess). ` +
    decimals +
    `When a row's price column names a currency other than ${x}: with a pricing template the row takes the tier ` +
    "whose price in that currency matches (none ⇒ refused; several ⇒ you pick), and countries the tier does not list " +
    `are converted by Google from the tier's ${x} price — a tier with no ${x} price refuses the row. With Google ` +
    "Conversion the row is refused unless you set custom prices for it; then a " +
    `${x} custom price, if you set one, becomes the conversion base.` +
    `Custom prices with a pricing template must include a ${x} price, and it becomes the conversion base.`;

  it.each([
    [
      "TWD",
      withCurrency(
        "TWD",
        "A value with more decimals than TWD allows is matched against the tiers' USD prices when a pricing " +
          "template is used (the tier's TWD price is sent; no match ⇒ refused), and refused with Google Conversion.",
      ),
    ],
    ["USD", withCurrency("USD", "A value with more decimals than USD allows is refused.")],
    [
      null,
      LEAD +
        "This app has no currency set (see the app page): a Price column is read as USD, and every row is priced " +
        "from the currency its own price column names." +
        "Custom prices with a pricing template are refused (they need an app currency).",
    ],
  ])("note text, app currency %s — verbatim", (appCurrency, expected) => {
    installBasicFetch();
    renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z", appCurrency });
    const note = screen.getByTestId("pricing-currency-note");
    expect(note.textContent).toBe(expected);
    expect(note.textContent).not.toMatch(/warning:|before importing|must (set|declare)|interpreted in the app|Google enforces/i);
  });

  it.each([["TWD"], [null]])(
    "app currency %s ⇒ clicking Preview sends the preview — no confirm(), no client-side block, no upload error",
    async (appCurrency) => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const fetchMock = installBasicFetch(() => ({
        ok: true,
        json: async () => ({ rows: [], warnings: [], counts: { total: 0, existing: 0, new: 0 }, appCurrency }),
      }));
      const { container } = renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z", appCurrency });
      await goToUploadStep();
      selectFile(container);
      await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
      });
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes(PREVIEW_URL_FRAGMENT))).toBe(true),
      );
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    },
  );

  it.each([
    ["IAPS_NEVER_SYNCED", 409, "never"],
    ["IMPORT_READINESS_READ_FAILED", 503, "unreadable"],
  ])(
    "EXECUTE refused with %s (twin path, same gate) ⇒ the mirror banner re-blocks too, not only the preview path",
    async (code, status, state) => {
      const fetchMock = installFetchMock({
        runId: "run-gate",
        executeResponse: () => ({
          ok: false,
          status,
          json: async () => ({ code, blockers: code === "IAPS_NEVER_SYNCED" ? [code] : undefined, error: `refused ${code}` }),
        }),
      });
      const { container } = renderWizard();
      await goToPreviewAndAdoptRun(container, fetchMock);
      await clickExecuteAndSettle();
      await waitFor(() =>
        expect(screen.getByTestId("mirror-sync-banner")).toHaveAttribute("data-state", state),
      );
    },
  );

  it("Tier column: a REFUSED row says 'Not sent — refused', a sent row 'Auto-converted by Google'; the note follows the server's currency", async () => {
    const row = (sku: string, resolution: unknown) => ({
      rowNumber: 1, sku, baseCurrency: "USD", basePriceDecimal: "0.99", regionOverrides: [], listings: [],
      exists: false, tierCandidates: [], defaultTierSelection: null, tierMatchedBy: "none", resolution,
    });
    installBasicFetch(() => ({
      ok: true,
      json: async () => ({
        rows: [
          row("sku.refused", { kind: "cross_currency_refused", anchorUsdMicros: "990000", reason: "App currency is TWD…", refusalKind: "google_default" }),
          { ...row("sku.sent", { kind: "same_currency" }), rowNumber: 2 },
        ],
        warnings: [],
        counts: { total: 2, existing: 0, new: 2 },
        appCurrency: "TWD",
      }),
    }));
    const { container } = renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z", appCurrency: "USD" });
    expect(screen.getByTestId("pricing-currency-note")).toHaveAttribute("data-app-currency", "USD");
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    });
    await waitFor(() => expect(screen.getByText("Not sent — refused")).toBeInTheDocument());
    expect(screen.getAllByText("Auto-converted by Google")).toHaveLength(1);
    // The note now describes the currency the server priced THIS preview with.
    expect(screen.getByTestId("pricing-currency-note")).toHaveAttribute("data-app-currency", "TWD");
  });

  it("server says IMPORT_READINESS_READ_FAILED ⇒ the mirror banner turns 'unreadable' and Preview re-blocks", async () => {
    installBasicFetch(() => ({
      ok: false,
      status: 503,
      json: async () => ({
        code: "IMPORT_READINESS_READ_FAILED",
        error: "Could not read whether this app's IAP list has been refreshed (timeout).",
      }),
    }));
    const { container } = renderWizard();
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("mirror-sync-banner")).toHaveAttribute("data-state", "unreadable"),
    );
    expect(screen.getByRole("button", { name: /^Preview/ })).toBeDisabled();
  });
});
