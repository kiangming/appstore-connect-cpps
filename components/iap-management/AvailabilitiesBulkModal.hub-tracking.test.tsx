// @vitest-environment jsdom

/**
 * Hub-tracking wiring tests for AvailabilitiesBulkModal (6th+7th
 * integration, docs/iap-management/design-iap-availability-hub-tracking.md).
 * Mirrors the mocking/timing patterns in
 * components/google-iap-management/iap-list/BulkStatusModal.test.tsx, but
 * this component has an extra initial step neither Google's modal nor
 * Bulk Import has: an on-open per-IAP availability fetch (Hotfix 25) that
 * must resolve before the eligible list (and thus the primary button)
 * renders — every test waits for that first.
 *
 * Kept in a separate file from AvailabilitiesBulkModal.test.tsx (which
 * only covers the pure `filterEligible` helper) since this file renders
 * the full component and needs its own fetch/queue setup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

import { __resetQueueForTests } from "@/lib/iap-management/client-fetch-queue";
import { AvailabilitiesBulkModal, type BulkMode } from "./AvailabilitiesBulkModal";
import type { InAppPurchase } from "@/types/iap-management/apple";
import type { AvailabilityForIap } from "@/lib/iap-management/apple/availabilities";

const START_URL = "/api/iap-management/hub-tracking/start";
const CANCEL_URL = "/api/iap-management/hub-tracking/cancel";
const BULK_URL = "/api/iap-management/iaps/bulk-availability";
const AVAIL_ONE_FRAGMENT = "/availability";

function iap(id: string, productId: string, name: string): InAppPurchase {
  return {
    id,
    type: "inAppPurchases",
    attributes: {
      productId,
      name,
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_FOR_SALE",
      familySharable: false,
    },
  } as unknown as InAppPurchase;
}

const availableState: AvailabilityForIap = {
  availableInNewTerritories: true,
  territoryCount: 175,
  territoryIds: [],
};

const iaps = [iap("iap-1", "com.x.a", "Item A")];
const appleToInternal = { "iap-1": "uuid-1" };

function successWriteResponse(
  overrides: Partial<{ succeeded: number; failed: number; total: number }> = {},
) {
  const total = overrides.total ?? 1;
  const succeeded = overrides.succeeded ?? total;
  const failed = overrides.failed ?? 0;
  return {
    ok: true,
    json: async () => ({
      action: "set-all",
      total,
      succeeded,
      failed,
      results: [{ iapId: "uuid-1", apple_iap_id: "iap-1", ok: failed === 0 }],
      overall: failed === 0 ? "SUCCESS" : succeeded === 0 ? "FAILURE" : "PARTIAL",
      summary: `${succeeded}/${total} succeeded`,
    }),
  };
}

interface FetchScenario {
  runId: string | null;
  /** "removed" makes the fixture eligible for set-all; "available" for remove. */
  availabilityState: AvailabilityForIap | null;
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
    if (url.includes(BULK_URL)) {
      return Promise.resolve((scenario.writeResponse ?? successWriteResponse)());
    }
    if (url.includes(AVAIL_ONE_FRAGMENT)) {
      return Promise.resolve({ ok: true, json: async () => ({ state: scenario.availabilityState }) });
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderModal(
  mode: BulkMode,
  overrides: { onClose?: () => void; onComplete?: () => void } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onComplete = overrides.onComplete ?? vi.fn();
  const utils = render(
    <AvailabilitiesBulkModal
      open
      mode={mode}
      iaps={iaps}
      appleToInternal={appleToInternal}
      onClose={onClose}
      onComplete={onComplete}
    />,
  );
  return { ...utils, onClose, onComplete };
}

/** Waits for the on-open availability fetch to resolve and the row to
 *  render, then selects it. */
async function selectFirstItem() {
  const checkbox = await screen.findByLabelText(/Select com\.x\.a/);
  fireEvent.click(checkbox);
}

beforeEach(() => {
  __resetQueueForTests();
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AvailabilitiesBulkModal — Hub tracking", () => {
  it("Remove from Sales click fires START before the reconfirm dialog appears", async () => {
    const fetchMock = installFetchMock({ runId: "run-1", availabilityState: availableState });
    renderModal("remove");

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true),
    );

    const startCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(START_URL))!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      feature: "iap-remove-from-sales",
    });
    expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument();
  });

  it("Set Availabilities has no reconfirm dialog — submit fires in the same click, tagged with its own feature", async () => {
    const fetchMock = installFetchMock({ runId: "run-2", availabilityState: null });
    renderModal("set-all");

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /OK \(1 selected\)/ }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true),
    );
    const startCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(START_URL))!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      feature: "iap-set-availabilities",
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(BULK_URL))).toBe(true),
    );
  });

  it("reconfirm-Cancel CANCELs the just-started run and returns to selection (modal stays open)", async () => {
    const fetchMock = installFetchMock({ runId: "run-3", availabilityState: availableState });
    renderModal("remove");

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ }));
    await waitFor(() => expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument());

    // Two "Cancel" buttons exist while the reconfirm dialog is open (the
    // outer modal's footer Cancel + the dialog's own) — the dialog's is
    // the second in DOM order.
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(true),
    );
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-3",
      feature: "iap-remove-from-sales",
    });
    // Modal is still open, back on the selection screen (not closed).
    expect(screen.getByRole("button", { name: /Remove \(1 selected\)/ })).toBeInTheDocument();
  });

  it("R3 multi-start: re-clicking Remove from Sales after a reconfirm-Cancel starts a genuinely NEW run", async () => {
    let callCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(START_URL)) {
        callCount += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({ run_id: callCount === 1 ? "run-first" : "run-second" }),
        });
      }
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(BULK_URL)) return Promise.resolve(successWriteResponse());
      if (url.includes(AVAIL_ONE_FRAGMENT)) {
        return Promise.resolve({ ok: true, json: async () => ({ state: availableState }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderModal("remove");

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ }));
    await waitFor(() => expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]); // declines run-first

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ })); // starts run-second
    await waitFor(() => expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(BULK_URL))).toBe(true),
    );
    const writeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(BULK_URL))!;
    const writeBody = JSON.parse((writeCall[1] as RequestInit).body as string);
    // The SECOND run is threaded into the write — the first was cancelled, not reused.
    expect(writeBody.hub_run_id).toBe("run-second");

    const cancelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes(CANCEL_URL));
    expect(cancelCalls).toHaveLength(1);
    expect(JSON.parse((cancelCalls[0][1] as RequestInit).body as string)).toEqual({
      run_id: "run-first",
      feature: "iap-remove-from-sales",
    });
  });

  it("R2: closing the modal (footer Cancel) BEFORE the write commits CANCELs — not the write-committed path", async () => {
    const fetchMock = installFetchMock({ runId: "run-4", availabilityState: availableState });
    const onClose = vi.fn();
    renderModal("remove", { onClose });

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ }));
    await waitFor(() => expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument());

    // Close via the footer "Cancel" button (outer modal, not the reconfirm's).
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const cancelCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(CANCEL_URL))!;
    expect(cancelCall).toBeTruthy();
    expect(JSON.parse((cancelCall[1] as RequestInit).body as string)).toEqual({
      run_id: "run-4",
      feature: "iap-remove-from-sales",
    });
  });

  it("R2: once the write commits (confirmed), no cancel is EVER sent again, even if the modal is closed afterward", async () => {
    const fetchMock = installFetchMock({ runId: "run-5", availabilityState: availableState });
    const onClose = vi.fn();
    renderModal("remove", { onClose });

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ }));
    await waitFor(() => expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(BULK_URL))).toBe(true),
    );

    // Close after results are shown.
    await waitFor(() => screen.getAllByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    window.dispatchEvent(new Event("beforeunload"));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
  });

  it("beforeunload before the write commits sends CANCELLED via sendBeacon", async () => {
    installFetchMock({ runId: "run-6", availabilityState: availableState });
    renderModal("remove");

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /Remove \(1 selected\)/ }));
    await waitFor(() => expect(screen.getByText("Confirm Remove from Sales")).toBeInTheDocument());

    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    expect(window.navigator.sendBeacon).toHaveBeenCalledTimes(1);
    const [, blob] = (window.navigator.sendBeacon as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = await (blob as Blob).text();
    expect(JSON.parse(text)).toEqual({ run_id: "run-6", feature: "iap-remove-from-sales" });
  });

  it("R4: Set Availabilities' race-cap expiring proceeds untracked (hub_run_id null), then best-effort CANCELs the late-arriving run instead of leaving it orphaned", async () => {
    let resolveStart!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const startPromise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes(START_URL)) return startPromise; // hangs past the 1s cap
      if (url.includes(CANCEL_URL)) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.includes(BULK_URL)) return Promise.resolve(successWriteResponse());
      if (url.includes(AVAIL_ONE_FRAGMENT)) {
        return Promise.resolve({ ok: true, json: async () => ({ state: null }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderModal("set-all");

    await selectFirstItem();
    const clickedAt = Date.now();
    fireEvent.click(screen.getByRole("button", { name: /OK \(1 selected\)/ })); // no reconfirm — submit's cap starts now

    await waitFor(
      () => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(BULK_URL))).toBe(true),
      { timeout: 2000 },
    );
    const elapsedMs = Date.now() - clickedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(2000);

    const writeCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(BULK_URL))!;
    const writeBody = JSON.parse((writeCall[1] as RequestInit).body as string);
    expect(writeBody.hub_run_id).toBeNull(); // cap won — untracked, never a wrong status.

    // The slow /start call finally resolves, long after the write already committed untracked.
    await act(async () => {
      resolveStart({ ok: true, json: async () => ({ run_id: "run-late-set-all" }) });
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
      run_id: "run-late-set-all",
      feature: "iap-set-availabilities",
    });
  }, 8000);

  it("Set Availabilities never shows a reconfirm dialog and can only reach SUCCESS/PARTIAL/FAILED, never a CANCEL affordance", async () => {
    const fetchMock = installFetchMock({ runId: "run-8", availabilityState: null });
    renderModal("set-all");

    await selectFirstItem();
    fireEvent.click(screen.getByRole("button", { name: /OK \(1 selected\)/ }));

    expect(screen.queryByText("Confirm Remove from Sales")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(BULK_URL))).toBe(true),
    );
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
  });
});
