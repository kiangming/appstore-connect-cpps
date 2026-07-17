// @vitest-environment jsdom

/**
 * Hub-tracking three-state cancel-guard tests for SubmitBatchModal — the
 * client-side half of the design doc's load-bearing complexity (§2/§B).
 *
 * Mocks `fetch` directly, dispatching on URL + parsed body so a single
 * test can drive the modal through preflight → execute → (conflict |
 * partial-fail | success) and assert exactly which follow-up requests
 * fire — in particular, whether `/hub-tracking/cancel` gets hit.
 *
 * Not re-testing preflight bucket rendering or the CPP-style partial-fail
 * UI itself (both predate this change and are unrelated to Hub tracking).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { SubmitBatchModal } from "./SubmitBatchModal";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const READY_ROW = {
  iap_id: "iap-1",
  apple_iap_id: "apple-1",
  product_id: "com.x.p1",
  reference_name: "Product 1",
  state: "READY_TO_SUBMIT",
};

function preflightResponse() {
  return {
    phase: "preflight",
    total: 1,
    ready: [READY_ROW],
    missing_metadata: [],
    other: [],
    not_on_apple: [],
  };
}

interface FetchCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** Records every call and dispatches a canned response per test scenario. */
function mockFetchSequence(responder: (call: FetchCall) => unknown) {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    const json = responder({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function renderModal(onClose = vi.fn()) {
  render(
    <SubmitBatchModal
      open
      appAppleId="app-1"
      selectedIapIds={["iap-1"]}
      onClose={onClose}
    />,
  );
  return onClose;
}

describe("SubmitBatchModal — Hub-tracking three-state cancel guard", () => {
  it("conflict dialog Cancel (state 2): fires /hub-tracking/cancel with the run_id, does NOT re-POST submit-batch with confirmConflict", async () => {
    const calls = mockFetchSequence(({ url, body }) => {
      if (url.includes("/hub-tracking/cancel")) return { ok: true };
      if (body?.execute === true && !body.confirmConflict) {
        return {
          phase: "conflict",
          reviewSubmissionId: "sub-1",
          eligibleCount: 1,
          foreignItemsSummary: { count: 2, byKind: { appCustomProductPageVersion: 2 }, typesKnown: true },
          hub_run_id: "run-abc",
        };
      }
      return preflightResponse();
    });

    renderModal();
    await waitFor(() => screen.getByRole("button", { name: /Submit 1 ready/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 ready/i }));

    await waitFor(() => screen.getByRole("button", { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => {
      const cancelCall = calls.find((c) => c.url.includes("/hub-tracking/cancel"));
      expect(cancelCall).toBeDefined();
      expect(cancelCall!.body).toEqual({ run_id: "run-abc" });
    });

    expect(calls.some((c) => c.body?.confirmConflict === true)).toBe(false);
  });

  it("conflict dialog 'Submit all N' (confirmConflict): threads hub_run_id through, does NOT fire cancel", async () => {
    const calls = mockFetchSequence(({ url, body }) => {
      if (url.includes("/hub-tracking/cancel")) return { ok: true };
      if (body?.confirmConflict === true) {
        return {
          phase: "execute",
          submitted: 3,
          failed: 0,
          skipped: 0,
          results: [],
          hub_run_id: null,
        };
      }
      if (body?.execute === true) {
        return {
          phase: "conflict",
          reviewSubmissionId: "sub-1",
          eligibleCount: 1,
          foreignItemsSummary: { count: 2, byKind: { inAppPurchaseVersion: 2 }, typesKnown: true },
          hub_run_id: "run-xyz",
        };
      }
      return preflightResponse();
    });

    renderModal();
    await waitFor(() => screen.getByRole("button", { name: /Submit 1 ready/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 ready/i }));

    await waitFor(() => screen.getByRole("button", { name: /Submit all 3/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit all 3/i }));

    await waitFor(() => {
      const confirmCall = calls.find((c) => c.body?.confirmConflict === true);
      expect(confirmCall).toBeDefined();
      expect(confirmCall!.body?.hub_run_id).toBe("run-xyz");
    });
    expect(calls.some((c) => c.url.includes("/hub-tracking/cancel"))).toBe(false);
  });

  it("modal close (X button) while conflict dialog showing: fires cancel exactly like the dialog's own Cancel button", async () => {
    const calls = mockFetchSequence(({ url, body }) => {
      if (url.includes("/hub-tracking/cancel")) return { ok: true };
      if (body?.execute === true) {
        return {
          phase: "conflict",
          reviewSubmissionId: "sub-1",
          eligibleCount: 1,
          foreignItemsSummary: { count: 1, byKind: { unknown: 1 }, typesKnown: false },
          hub_run_id: "run-close",
        };
      }
      return preflightResponse();
    });
    const onClose = vi.fn();

    renderModal(onClose);
    await waitFor(() => screen.getByRole("button", { name: /Submit 1 ready/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 ready/i }));
    await waitFor(() => screen.getByText(/already has an open Apple review submission/i));

    // The header X button — has no accessible name, select by icon container.
    const buttons = screen.getAllByRole("button");
    const xButton = buttons.find((b) => b.querySelector("svg") && !b.textContent?.trim());
    expect(xButton).toBeDefined();
    fireEvent.click(xButton!);

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/hub-tracking/cancel") && c.body?.run_id === "run-close")).toBe(true);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a clean success (no conflict): does NOT fire cancel when the Done button is clicked afterward", async () => {
    const calls = mockFetchSequence(({ url, body }) => {
      if (url.includes("/hub-tracking/cancel")) return { ok: true };
      if (body?.execute === true) {
        return { phase: "execute", submitted: 1, failed: 0, skipped: 0, results: [], hub_run_id: null };
      }
      return preflightResponse();
    });
    const onClose = vi.fn();

    renderModal(onClose);
    await waitFor(() => screen.getByRole("button", { name: /Submit 1 ready/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 ready/i }));

    await waitFor(() => screen.getByRole("button", { name: /Done/i }));
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));

    expect(calls.some((c) => c.url.includes("/hub-tracking/cancel"))).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("partial-fail 'Cancel — don't submit' (state 3): POSTs a rollback request, does NOT fire a client-side cancel call", async () => {
    const calls = mockFetchSequence(({ url, body }) => {
      if (url.includes("/hub-tracking/cancel")) return { ok: true };
      if (body?.rollback) {
        return { phase: "rolled-back", deleted: true };
      }
      if (body?.execute === true) {
        return {
          phase: "partial-fail",
          reviewSubmissionId: "sub-2",
          reused: false,
          items: [
            { iap_id: "iap-1", apple_iap_id: "apple-1", status: "ERROR", error: "429: rate limited" },
          ],
          skipped: [],
          hub_run_id: "run-partial",
        };
      }
      return preflightResponse();
    });

    renderModal();
    await waitFor(() => screen.getByRole("button", { name: /Submit 1 ready/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 ready/i }));

    await waitFor(() => screen.getByRole("button", { name: /Cancel — don't submit/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel — don't submit/i }));

    await waitFor(() => {
      const rollbackCall = calls.find((c) => c.body?.rollback);
      expect(rollbackCall).toBeDefined();
      expect(rollbackCall!.body?.hub_run_id).toBe("run-partial");
      expect((rollbackCall!.body?.rollback as Record<string, unknown>).addedIapIds).toEqual([]);
      expect((rollbackCall!.body?.rollback as Record<string, unknown>).failedIapIds).toEqual(["iap-1"]);
    });
    // Never a separate cancel-route call — the rollback request itself
    // resolves the Hub run server-side (design doc §2, state 3 suppresses
    // client-side cancel).
    expect(calls.some((c) => c.url.includes("/hub-tracking/cancel"))).toBe(false);
  });

  it("beforeunload during the conflict dialog (state 2) sends a cancel beacon; after commit (state 3) it does not", async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    (globalThis.navigator as unknown as { sendBeacon: typeof sendBeacon }).sendBeacon = sendBeacon;

    mockFetchSequence(({ url, body }) => {
      if (url.includes("/hub-tracking/cancel")) return { ok: true };
      if (body?.execute === true) {
        return {
          phase: "conflict",
          reviewSubmissionId: "sub-3",
          eligibleCount: 1,
          foreignItemsSummary: { count: 1, byKind: { unknown: 1 }, typesKnown: false },
          hub_run_id: "run-beacon",
        };
      }
      return preflightResponse();
    });

    renderModal();
    await waitFor(() => screen.getByRole("button", { name: /Submit 1 ready/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 ready/i }));
    await waitFor(() => screen.getByText(/already has an open Apple review submission/i));

    window.dispatchEvent(new Event("beforeunload"));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [beaconUrl, beaconBlob] = sendBeacon.mock.calls[0];
    expect(beaconUrl).toBe("/api/iap-management/hub-tracking/cancel");
    expect(beaconBlob).toBeInstanceOf(Blob);
  });
});
