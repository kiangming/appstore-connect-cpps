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
import {
  buildExecuteRequestBody,
  buildExecuteRows,
  previewRowsFromResponse,
  seedTierSelections,
} from "./execute-payload";
import { PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";

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

  it("C2.1a: Refresh answered 200 with an EMPTY list over a populated mirror ⇒ shows the server's reason, stays blocked", async () => {
    installMirrorFetch({
      refresh: () => ({
        ok: true,
        json: async () => ({
          ok: true, synced: 0, failed: 0, total: 0,
          mirror_complete: false, mirror_synced_at: null,
          mirror_not_complete_reason: "EMPTY_LIST_WITH_MIRROR_ITEMS",
          mirror_warning:
            "Google returned an EMPTY IAP list while the tool holds 16 item(s) for this app — not counted as a complete refresh (the last-complete-refresh time was not updated). If this app has never been refreshed completely, bulk import stays blocked; otherwise it keeps using the list from its last complete refresh.",
        }),
      }),
    });
    renderWizard({ iapsLastSyncedAt: null });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Refresh IAP list/ }));
    });
    const banner = await screen.findByTestId("mirror-sync-banner");
    await waitFor(() => expect(banner).toHaveTextContent(/EMPTY IAP list while the tool holds 16 item\(s\)/));
    // Not the failed-rows sentence — that would send the Manager hunting for failures.
    expect(banner).not.toHaveTextContent(/could not be cached/);
    expect(banner).toHaveAttribute("data-state", "never");
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("C2.1a: same EMPTY-list answer on an app refreshed completely BEFORE ⇒ banner stays 'synced', Preview stays open, text tells both cases", async () => {
    installMirrorFetch({
      refresh: () => ({
        ok: true,
        json: async () => ({
          ok: true, synced: 0, failed: 0, total: 0,
          mirror_complete: false, mirror_synced_at: null,
          mirror_not_complete_reason: "EMPTY_LIST_WITH_MIRROR_ITEMS",
          mirror_warning:
            "Google returned an EMPTY IAP list while the tool holds 16 item(s) for this app — not counted as a complete refresh (the last-complete-refresh time was not updated). If this app has never been refreshed completely, bulk import stays blocked; otherwise it keeps using the list from its last complete refresh.",
        }),
      }),
    });
    const { container } = renderWizard(); // stamped at 2026-10-16T03:25:10Z
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Refresh IAP list/ }));
    });
    const banner = await screen.findByTestId("mirror-sync-banner");
    await waitFor(() => expect(banner).toHaveTextContent(/not counted as a complete refresh/));
    expect(banner).toHaveAttribute("data-state", "synced");
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
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

  it.each([["refreshed"]])(
    "IAP list %s ⇒ Preview ENABLED — no currency/language banner, no block (the wizard takes no app currency at all)",
    async () => {
      installBasicFetch();
      const { container } = renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z" });
      expect(screen.queryByTestId("app-defaults-banner")).toBeNull();
      await goToUploadStep();
      selectFile(container);
      await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    },
  );

  // Every sentence is MEASURED behaviour of the pricing code at this commit
  // (H4.2: the app's currency takes no part in pricing). Pinned verbatim so
  // the wording cannot change silently. ⚠ A text pin CANNOT detect a pricing
  // change — the route-level T1 (bulk-import/file-currency-invariance.test.ts)
  // does; each H4 step that changes pricing updates this note in the same commit.
  const NOTE =
    "Prices come only from the file. The file needs exactly one Price (XXX) column (e.g. Price (USD)), in a " +
    "currency Google Play bills in, and prices are read in that currency only — the app's currency is not used. " +
    "A price header without its currency (Price / Default Price / Base Price) or a second price column refuses the " +
    "file; a row whose price or GT price cannot be sent exactly as written (more decimals than its currency " +
    'allows, 0, or a "." / "," in a currency without decimals) is not imported.' +
    "With a pricing template, a row takes the tier named after its SKU, else the tier whose price in the file's " +
    "currency equals the file's price; countries the tier does not list, and rows with no matching tier, are " +
    "converted by Google from the file's price. With Google Conversion every country is converted from the " +
    "file's price." +
    "GT Price + GT Currency (both, or neither) override their one country, except when a tier matches the row — " +
    "the tier's prices replace the GT, and a country the tier does not list is then converted by Google — or the " +
    "row has custom prices (they replace it). Custom prices overlay the file's price, which stays the conversion " +
    "base." +
    "If Google's conversion fails (usually temporary — run the row again later) or returns no US price, a row " +
    "whose price is not in USD is refused. A USD row is still sent.";

  it("note text — verbatim, ONE text: nothing in it depends on the app's currency", () => {
    installBasicFetch();
    renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z" });
    const note = screen.getByTestId("pricing-currency-note");
    expect(note.textContent).toBe(NOTE);
    expect(note).not.toHaveAttribute("data-app-currency");
    expect(note.textContent).not.toMatch(/warning:|before importing|must (set|declare)|interpreted in the app|Google enforces/i);
  });

  it.each([["refreshed"]])(
    "IAP list %s ⇒ clicking Preview sends the preview — no confirm(), no client-side block, no upload error",
    async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const fetchMock = installBasicFetch(() => ({
        ok: true,
        json: async () => ({ rows: [], warnings: [], counts: { total: 0, existing: 0, new: 0 } }),
      }));
      const { container } = renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z" });
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

  it("H4.3: a row whose tier lookup FAILED says so — never 'Auto-converted by Google' — and its GT is 'unknown'; a plain no-tier row with a GT says 'will be sent'", async () => {
    const row = (rowNumber: number, sku: string, tierMatchedBy: string) => ({
      rowNumber, sku, baseCurrency: "USD", basePriceDecimal: "0.99",
      regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "26000" }], listings: [],
      exists: false, tierCandidates: [], defaultTierSelection: null, tierMatchedBy,
    });
    installBasicFetch(() => ({
      ok: true,
      json: async () => ({
        rows: [row(1, "sku.failed", "lookup_failed"), row(2, "sku.sent", "none")],
        warnings: [],
        counts: { total: 2, existing: 0, new: 2 },
      }),
    }));
    const { container } = renderWizard({ iapsLastSyncedAt: "2026-10-16T03:25:10.000Z" });
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    });
    await waitFor(() => expect(screen.getByTestId("tier-lookup-failed")).toBeInTheDocument());
    expect(screen.getAllByText("Auto-converted by Google")).toHaveLength(1);
    // Google Conversion (availability failed ⇒ google_default): no template
    // runs, so a GT is sent whatever the tier flag says (gtPlanOf follows the
    // source first). The template-source labels are pinned in
    // BulkImportWizard.custom-prices.test.tsx.
    expect(screen.getAllByTestId("gt-status").map((e) => e.getAttribute("data-state"))).toEqual(["sent", "sent"]);
    expect(screen.getAllByTestId("gt-status")[1]).toHaveTextContent("GT VN 26000 VND · will be sent");
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

/**
 * H4.0 — the execute request the wizard REALLY sends (captured fetch body) is
 * exactly the shared builder's output for the same preview response. The
 * route-level pricing test (bulk-import/file-currency-invariance.test.ts)
 * drives the execute route with that builder, so any post-processing added
 * here — e.g. stamping the app currency into baseCurrency (the old Hotfix 4
 * shape), or an extra envelope field — would silently make that test stop
 * describing production. This test is what catches it.
 */
describe("BulkImportWizard (Google) — execute body = the shared builder's output (H4.0)", () => {
  it("captured execute body deep-equals buildExecuteRequestBody(...) for the same preview rows", async () => {
    const previewRows = [
      {
        rowNumber: 2,
        sku: "sku.a",
        baseCurrency: "USD",
        basePriceDecimal: "0.99",
        regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "26000" }],
        listings: [],
        exists: false,
        tierCandidates: [
          { identifier: "Tier 1", templateId: "tpl", regionCount: 3, vnCurrency: "VND", vnPriceMicros: "25000000000", vnPriceDecimal: "25000" },
        ],
        defaultTierSelection: null,
        tierMatchedBy: "currency_price",
      },
      {
        rowNumber: 3,
        sku: "sku.b",
        baseCurrency: "TWD",
        basePriceDecimal: "30",
        regionOverrides: [],
        listings: [],
        exists: false,
        tierCandidates: [],
        defaultTierSelection: null,
        tierMatchedBy: "none",
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(AVAILABILITY_URL_FRAGMENT)) return Promise.resolve({ ok: false, json: async () => ({}) });
      if (url.includes(START_URL)) return Promise.resolve({ ok: true, json: async () => ({ run_id: "run-guard" }) });
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(PREVIEW_URL_FRAGMENT)) {
        return Promise.resolve({ ok: true, json: async () => ({ rows: previewRows, warnings: [], priceHeader: "Price (USD)" }) });
      }
      if (url.includes(EXECUTE_URL_FRAGMENT)) return Promise.resolve(successExecuteResponse());
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT))).toBe(true),
    );
    const executeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT))!;
    const executeBody = JSON.parse((executeCall[1] as RequestInit).body as string);

    const rows = previewRowsFromResponse(previewRows as Parameters<typeof previewRowsFromResponse>[0]);
    const expected = buildExecuteRequestBody({
      pricingSource: "google_default",
      sourceFilename: "items.xlsx",
      hubRunId: "run-guard",
      rows: buildExecuteRows(rows, {
        tierSelections: seedTierSelections(rows),
        customPrices: {},
        activeCustomSkus: new Set(),
      }),
      droppedRows: [],
      priceHeader: "Price (USD)",
    });
    expect(executeBody).toEqual(JSON.parse(JSON.stringify(expected)));
    // The builder really was exercised on both branches it encodes.
    expect(executeBody.rows[0].chosenTierIdentifier).toBe("Tier 1");
    // H4.3 — the pricing rule the route checks; no priceHeaderSource any more.
    expect(executeBody.pricing_rule).toBe(PRICING_RULE);
    expect(executeBody.rows[1]).not.toHaveProperty("priceHeaderSource");
    expect(executeBody.droppedRows).toEqual([]);
  });
});

/**
 * H4.3 (Manager 2026-10-18) — rows of the file the tool will not import are
 * shown IN the preview table with their reason; Push sends the rest only
 * after a confirmation naming every row left out; the Done report lists them.
 * No row disappears silently.
 */
describe("BulkImportWizard (Google) — refused rows in the table, push the rest after confirming (H4.3)", () => {
  const REFUSED = { rowNumber: 3, sku: "sku.bad", reason: 'GT Price "26000.5" VND — VND only accepts whole numbers.' };

  function installPushFetch(opts: {
    rows?: unknown[];
    refusedRows?: unknown[];
    executeJson?: () => unknown;
  }) {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(AVAILABILITY_URL_FRAGMENT)) return Promise.resolve({ ok: false, json: async () => ({}) });
      if (url.includes(START_URL)) return Promise.resolve({ ok: true, json: async () => ({ run_id: "run-h43" }) });
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(PREVIEW_URL_FRAGMENT)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            rows: opts.rows ?? (await previewResponse().json()).rows,
            refusedRows: opts.refusedRows ?? [REFUSED],
            warnings: [`Row 3 (SKU "sku.bad"): ${REFUSED.reason} Row not imported.`, "another warning"],
          }),
        });
      }
      if (url.includes(EXECUTE_URL_FRAGMENT)) {
        return Promise.resolve({
          ok: true,
          json: async () => (opts.executeJson ? opts.executeJson() : await successExecuteResponse().json()),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const executeCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => String(c[0]).includes(EXECUTE_URL_FRAGMENT));
  const cancelCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => String(c[0]).includes(CANCEL_URL));

  it("the refused row is IN the table with its reason and a 'Not imported' badge; the parser's duplicate warning is not repeated; Push is ENABLED", async () => {
    const fetchMock = installPushFetch({});
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    const tr = await screen.findByTestId("preview-refused-row");
    expect(tr).toHaveAttribute("data-row-number", "3");
    expect(tr).toHaveTextContent("sku.bad");
    expect(tr).toHaveTextContent(REFUSED.reason);
    expect(tr).toHaveTextContent("Not imported");
    expect(screen.getByTestId("file-refused-rows")).toHaveAttribute("data-state", "push-the-rest");
    // The row's own parser warning is filtered (it is in the table); others stay.
    expect(screen.getByText(/Parse warnings \(1\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeEnabled();
  });

  it("Push ⇒ the confirmation names every row left out and NOTHING is sent; 'Go back' closes it — still nothing sent, the Hub run NOT cancelled", async () => {
    const fetchMock = installPushFetch({});
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    const dialog = await screen.findByTestId("push-confirm");
    expect(screen.getByTestId("push-confirm-dropped")).toHaveTextContent("1 row(s) of the file will NOT be imported");
    expect(dialog).toHaveTextContent(`Row 3 (sku.bad): ${REFUSED.reason}`);
    expect(screen.getByTestId("push-confirm-sent")).toHaveTextContent("1 row(s) will be sent to Google Play");
    expect(executeCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getByTestId("push-confirm-cancel"));
    expect(screen.queryByTestId("push-confirm")).toBeNull();
    expect(executeCalls(fetchMock)).toHaveLength(0);
    expect(cancelCalls(fetchMock)).toHaveLength(0);
  });

  it("Push ⇒ confirm ⇒ exactly ONE execute, carrying the dropped rows and the preview's Hub run", async () => {
    const fetchMock = installPushFetch({});
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    await screen.findByTestId("push-confirm");
    await act(async () => {
      fireEvent.click(screen.getByTestId("push-confirm-ok"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(executeCalls(fetchMock)).toHaveLength(1));
    const body = JSON.parse((executeCalls(fetchMock)[0][1] as RequestInit).body as string);
    expect(body.droppedRows).toEqual([REFUSED]);
    expect(body.hub_run_id).toBe("run-h43");
    expect(body.rows.map((r: { sku: string }) => r.sku)).toEqual(["sku1"]);
  });

  it("no refused row ⇒ Push goes straight to execute, no confirmation", async () => {
    const fetchMock = installPushFetch({ refusedRows: [] });
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    await waitFor(() => expect(executeCalls(fetchMock)).toHaveLength(1));
    expect(screen.queryByTestId("push-confirm")).toBeNull();
  });

  it("EVERY row refused ⇒ nothing to push: Push disabled, the summary says so", async () => {
    installPushFetch({ rows: [] });
    const { container } = renderWizard();
    await goToUploadStep();
    selectFile(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    });
    expect(await screen.findByTestId("file-refused-rows")).toHaveAttribute("data-state", "nothing-to-push");
    expect(screen.getByTestId("preview-refused-row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeDisabled();
  });

  it("Done lists EVERY row not imported, by group, uncapped; the heading says 'finished — N not imported'; the five tiles sum to the rows in the file", async () => {
    const leftOut = Array.from({ length: 25 }, (_, i) => ({
      sku: `sku.left${i}`,
      rowNumber: 10 + i,
      kind: "refused_in_file",
      reason: `Row ${10 + i} (sku.left${i}): "Price (USD)" is empty — fill in the price. Not imported — refused in the file, left out when you pushed.`,
    }));
    const fetchMock = installPushFetch({
      executeJson: () => ({
        rowsTotal: 47,
        rowsCreated: 1,
        rowsOverwritten: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        rowsRefused: 46,
        droppedRows: 25,
        refusedRows: [
          ...leftOut,
          ...Array.from({ length: 21 }, (_, i) => ({
            sku: `sku.tier${i}`,
            rowNumber: 40 + i,
            kind: "tier_price_invalid",
            reason: `Row ${40 + i} (sku.tier${i}): pricing-template tier "t" holds a price that cannot be sent — TW TWD: x. Row not sent.`,
          })),
        ],
        durationMs: 5,
      }),
    });
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    await act(async () => {
      fireEvent.click(await screen.findByTestId("push-confirm-ok"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const heading = await screen.findByTestId("done-heading");
    expect(heading).toHaveAttribute("data-state", "partial");
    expect(heading).toHaveTextContent("Bulk import finished — 46 row(s) not imported (46 not sent)");
    const list = screen.getByTestId("done-refused-rows");
    // EVERY row by name — both groups past 20 (the old cap was 20).
    expect(list.querySelectorAll('li[data-kind="refused_in_file"]')).toHaveLength(25);
    expect(list.querySelectorAll('li[data-kind="tier_price_invalid"]')).toHaveLength(21);
    for (const n of [10, 34, 40, 60]) expect(list).toHaveTextContent(`Row ${n} (`);
    expect(list).toHaveTextContent("25 row(s) left out — refused in the file, not sent:");
    expect(list).toHaveTextContent("21 row(s) refused at push — not sent to Google:");
    // The reason already starts "Row N (sku):" — not doubled.
    expect(list.textContent).not.toMatch(/Row 40 \(sku\.tier0\): Row 40/);
    const tiles = [...screen.getByTestId("done-tiles").children].map((t) => Number(t.textContent?.match(/\d+/)?.[0]));
    const [created, overwritten, skipped, failed, notSent] = tiles;
    expect(created + overwritten + skipped + failed + notSent).toBe(47);
  });

  it("25 refused rows ⇒ ALL 25 in the table and ALL 25 named in the confirmation (no cap)", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ rowNumber: 10 + i, sku: `sku.r${i}`, reason: `reason ${i}.` }));
    const fetchMock = installPushFetch({ refusedRows: many });
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    expect(screen.getAllByTestId("preview-refused-row").map((e) => e.getAttribute("data-row-number"))).toEqual(
      many.map((r) => String(r.rowNumber)),
    );
    await clickExecuteAndSettle();
    const dialog = await screen.findByTestId("push-confirm");
    for (const r of many) expect(dialog).toHaveTextContent(`Row ${r.rowNumber} (${r.sku}): ${r.reason}`);
  });

  it("the confirmation closes when the wizard leaves the preview — a NEW preview never shows a stale one, and its OK never bypasses the Push gate", async () => {
    let previewCall = 0;
    const fetchMock = installPushFetch({});
    // Second preview: an EXISTING row with no decision yet ⇒ Push gate closed.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(AVAILABILITY_URL_FRAGMENT)) return Promise.resolve({ ok: false, json: async () => ({}) });
      if (url.includes(START_URL)) return Promise.resolve({ ok: true, json: async () => ({ run_id: "run-h43" }) });
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(PREVIEW_URL_FRAGMENT)) {
        previewCall += 1;
        const base = { rowNumber: 1, sku: "sku1", baseCurrency: "USD", basePriceDecimal: "0.99", regionOverrides: [], listings: [], tierCandidates: [], defaultTierSelection: null, tierMatchedBy: "none" };
        return Promise.resolve({
          ok: true,
          json: async () => ({ rows: [{ ...base, exists: previewCall > 1 }], refusedRows: [REFUSED], warnings: [] }),
        });
      }
      if (url.includes(EXECUTE_URL_FRAGMENT)) return Promise.resolve(successExecuteResponse());
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    await screen.findByTestId("push-confirm");
    // Leave the preview with the page's Back (not the dialog's button).
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    await waitFor(() => expect(screen.queryByTestId("push-confirm")).toBeNull());
    selectFile(container, "second.xlsx");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeDisabled());
    expect(screen.queryByTestId("push-confirm")).toBeNull();
    expect(executeCalls(fetchMock)).toHaveLength(0);
  });

  it("a clean batch keeps the green 'Bulk import complete'", async () => {
    const fetchMock = installPushFetch({ refusedRows: [] });
    const { container } = renderWizard();
    await goToPreviewAndAdoptRun(container, fetchMock);
    await clickExecuteAndSettle();
    const heading = await screen.findByTestId("done-heading");
    expect(heading).toHaveAttribute("data-state", "complete");
    expect(heading).toHaveTextContent("Bulk import complete");
    expect(screen.queryByTestId("done-refused-rows")).toBeNull();
  });
});
