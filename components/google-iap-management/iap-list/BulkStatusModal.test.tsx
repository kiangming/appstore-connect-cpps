// @vitest-environment jsdom

/**
 * Hub-tracking wiring tests for BulkStatusModal (5th integration,
 * docs/google-iap-management/design-bulk-status-hub-tracking.md). Mirrors
 * the mocking/timing patterns in
 * components/google-iap-management/bulk-import/BulkImportWizard.test.tsx,
 * but the lifecycle differs on purpose (see the design doc §G): START
 * fires at the button click itself, not at an earlier upload→preview
 * step, and Deactivate's reconfirm-Cancel returns to the SAME still-open
 * modal (not a full navigate-away) — so re-clicking Deactivate must start
 * a genuinely NEW run (R3), and Activate's own race-cap deviates from
 * Bulk Import's ce169a8 fix by best-effort CANCELLING a late-arriving
 * orphaned run instead of dropping it silently (R4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

import { BulkStatusModal } from "./BulkStatusModal";
import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";

const START_URL = "/api/google-iap-management/hub-tracking/start";
const CANCEL_URL = "/api/google-iap-management/hub-tracking/cancel";
const ACTIVATE_URL_FRAGMENT = "/iaps/bulk-activate";
const DEACTIVATE_URL_FRAGMENT = "/iaps/bulk-deactivate";

function iap(sku: string, status: "active" | "inactive"): IapWithDefaultLocale {
  return {
    id: sku,
    app_id: "app-1",
    sku,
    purchase_type: "managed",
    status,
    default_currency: "USD",
    default_price_micros: "990000",
    last_synced_at: null,
    deleted_on_google_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    default_title: sku,
  };
}

function successWriteResponse(overrides: Partial<{ succeeded: number; failed: number; total: number }> = {}) {
  const total = overrides.total ?? 1;
  const succeeded = overrides.succeeded ?? total;
  const failed = overrides.failed ?? 0;
  return {
    ok: true,
    json: async () => ({
      action: "deactivate",
      total,
      succeeded,
      failed,
      results: [],
      overall: failed === 0 ? "SUCCESS" : succeeded === 0 ? "FAILURE" : "PARTIAL",
      summary: `${succeeded}/${total} succeeded`,
      batches: 1,
    }),
  };
}

interface FetchScenario {
  runId: string | null;
  writeResponse?: () => { ok: boolean; json: () => Promise<unknown> };
}

function installFetchMock(scenario: FetchScenario) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes(START_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ run_id: scenario.runId }) });
    }
    if (url.includes(CANCEL_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes(ACTIVATE_URL_FRAGMENT) || url.includes(DEACTIVATE_URL_FRAGMENT)) {
      return Promise.resolve((scenario.writeResponse ?? successWriteResponse)());
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderModal(mode: "activate" | "deactivate", overrides: { onClose?: () => void; onComplete?: () => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onComplete = overrides.onComplete ?? vi.fn();
  const iaps =
    mode === "deactivate" ? [iap("sku.a", "active")] : [iap("sku.a", "inactive")];
  const utils = render(
    <BulkStatusModal
      open
      mode={mode}
      packageName="com.example.app"
      iaps={iaps}
      onClose={onClose}
      onComplete={onComplete}
    />,
  );
  return { ...utils, onClose, onComplete };
}

function selectFirstItem() {
  const checkbox = screen.getByLabelText(/Select sku\.a/);
  fireEvent.click(checkbox);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BulkStatusModal — Hub tracking", () => {
  it("Deactivate click fires START before the reconfirm dialog appears", async () => {
    const fetchMock = installFetchMock({ runId: "run-1" });
    renderModal("deactivate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true);
    const startCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(START_URL))!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      feature: "google-iap-bulk-deactivate",
    });
    // Reconfirm dialog is showing.
    expect(screen.getByText("Confirm bulk deactivate")).toBeInTheDocument();
  });

  it("Activate has no reconfirm dialog — submit fires in the same click, tagged with its own feature", async () => {
    const fetchMock = installFetchMock({ runId: "run-2" });
    renderModal("activate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /OK \(1 selected\)/ }));
    await flush();

    const startCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(START_URL))!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      feature: "google-iap-bulk-activate",
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(ACTIVATE_URL_FRAGMENT))).toBe(
        true,
      ),
    );
  });

  it("reconfirm-Cancel CANCELs the just-started run and returns to selection (modal stays open)", async () => {
    const fetchMock = installFetchMock({ runId: "run-3" });
    renderModal("deactivate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();
    expect(screen.getByText("Confirm bulk deactivate")).toBeInTheDocument();

    // Two "Cancel" buttons exist while the reconfirm dialog is open (the
    // outer modal's footer Cancel + the dialog's own) — the dialog's is
    // the second in DOM order.
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
    await flush();

    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(cancelCall).toBeTruthy();
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-3",
      feature: "google-iap-bulk-deactivate",
    });
    // Modal is still open, back on the selection screen (not closed).
    expect(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ })).toBeInTheDocument();
  });

  it("R3 multi-start: re-clicking Deactivate after a reconfirm-Cancel starts a genuinely NEW run", async () => {
    const fetchMock = vi.fn();
    let callCount = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(START_URL)) {
        callCount += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({ run_id: callCount === 1 ? "run-first" : "run-second" }),
        });
      }
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(DEACTIVATE_URL_FRAGMENT)) return Promise.resolve(successWriteResponse());
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderModal("deactivate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]); // declines run-first (dialog's Cancel)
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ })); // starts run-second
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(DEACTIVATE_URL_FRAGMENT))).toBe(
        true,
      ),
    );
    const writeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(DEACTIVATE_URL_FRAGMENT))!;
    const writeBody = JSON.parse((writeCall[1] as RequestInit).body as string);
    // The SECOND run is threaded into the write — the first was cancelled, not reused.
    expect(writeBody.hub_run_id).toBe("run-second");

    const cancelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes(CANCEL_URL));
    expect(cancelCalls).toHaveLength(1);
    expect(JSON.parse((cancelCalls[0][1] as RequestInit).body as string)).toEqual({
      run_id: "run-first",
      feature: "google-iap-bulk-deactivate",
    });
  });

  it("R2: closing the modal (backdrop) BEFORE the write commits CANCELs — not the write-committed path", async () => {
    const fetchMock = installFetchMock({ runId: "run-4" });
    const onClose = vi.fn();
    renderModal("deactivate", { onClose });

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();

    // Close via the footer "Cancel" button (outer modal, not the reconfirm's).
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    await flush();

    expect(onClose).toHaveBeenCalledTimes(1);
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(cancelCall).toBeTruthy();
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-4",
      feature: "google-iap-bulk-deactivate",
    });
  });

  it("R2: once the write commits (confirmed), no cancel is EVER sent again, even if the modal is closed afterward", async () => {
    const fetchMock = installFetchMock({ runId: "run-5" });
    const onClose = vi.fn();
    renderModal("deactivate", { onClose });

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(DEACTIVATE_URL_FRAGMENT))).toBe(
        true,
      ),
    );

    // Close after results are shown — two "Close" buttons match (the X's
    // aria-label + the footer text button); either is fine here since both
    // route through handleClose.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[1]);
    window.dispatchEvent(new Event("beforeunload"));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
  });

  it("beforeunload before the write commits sends CANCELLED via sendBeacon", async () => {
    installFetchMock({ runId: "run-6" });
    renderModal("deactivate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();

    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).toHaveBeenCalledTimes(1);
    const [, blob] = (window.navigator.sendBeacon as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = await (blob as Blob).text();
    expect(JSON.parse(text)).toEqual({ run_id: "run-6", feature: "google-iap-bulk-deactivate" });
  });

  it("all-success closes the modal's terminal state as SUCCESS (server-side finalize is out of scope for this client test)", async () => {
    installFetchMock({ runId: "run-7", writeResponse: () => successWriteResponse({ total: 1, succeeded: 1, failed: 0 }) });
    renderModal("deactivate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Deactivate \(1 selected\)/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();

    await waitFor(() => expect(screen.getByText(/succeeded/)).toBeInTheDocument());
  });

  it("R4: Activate's race-cap expiring proceeds untracked (hub_run_id null), then best-effort CANCELs the late-arriving run instead of leaving it orphaned", async () => {
    let resolveStart!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const startPromise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(START_URL)) return startPromise; // hangs past the 1s cap
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(ACTIVATE_URL_FRAGMENT)) return Promise.resolve(successWriteResponse());
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderModal("activate");

    selectFirstItem();
    const clickedAt = Date.now();
    fireEvent.click(screen.getByRole("button", { name: /OK \(1 selected\)/ })); // no reconfirm — submit's cap starts now

    await waitFor(
      () => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(ACTIVATE_URL_FRAGMENT))).toBe(true),
      { timeout: 2000 },
    );
    const elapsedMs = Date.now() - clickedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(2000);

    const writeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(ACTIVATE_URL_FRAGMENT))!;
    const writeBody = JSON.parse((writeCall[1] as RequestInit).body as string);
    expect(writeBody.hub_run_id).toBeNull(); // cap won — untracked, never a wrong status.

    // The slow /start call finally resolves, long after the write already committed untracked.
    await act(async () => {
      resolveStart({ ok: true, json: async () => ({ run_id: "run-late-activate" }) });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL));
      expect(cancelCall).toBeTruthy();
    });
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-late-activate",
      feature: "google-iap-bulk-activate",
    });
  }, 8000);

  it("Activate never shows a reconfirm dialog and can only reach SUCCESS/PARTIAL/FAILED, never a CANCEL affordance", async () => {
    installFetchMock({ runId: "run-8" });
    renderModal("activate");

    selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /OK \(1 selected\)/ }));
    await flush();

    expect(screen.queryByText(/Confirm bulk deactivate/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/succeeded/)).toBeInTheDocument());
  });
});
