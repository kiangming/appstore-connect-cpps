// @vitest-environment jsdom

/**
 * Tests for Hotfix 25 AvailabilityCell.
 *
 * Covers each of the 6 cell states + the click-to-retry path. Mocks
 * `fetch` directly so the test pins the contract between the cell and
 * the per-IAP API route shape (`{ state, error?, reason? }`).
 *
 * IntersectionObserver is stubbed to fire `isIntersecting: true`
 * immediately so the test doesn't need to manipulate scroll position.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { __resetQueueForTests } from "@/lib/iap-management/client-fetch-queue";
import { AvailabilityCell } from "./AvailabilityCell";

class ImmediateIntersectionObserver {
  private cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    // Fire on the next microtask so React commits before the callback runs.
    queueMicrotask(() => {
      this.cb(
        [
          {
            isIntersecting: true,
            target: el,
            intersectionRatio: 1,
            time: 0,
            boundingClientRect: {} as DOMRectReadOnly,
            intersectionRect: {} as DOMRectReadOnly,
            rootBounds: null,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    });
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const originalFetch = globalThis.fetch;
const originalObserver = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;

beforeEach(() => {
  __resetQueueForTests();
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    ImmediateIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    originalObserver;
});

function mockFetch(response: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  }) as unknown as typeof fetch;
}

describe("<AvailabilityCell />", () => {
  it("renders an inert em-dash when there is no internal UUID (no fetch attempt)", () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    render(<AvailabilityCell internalIapId={null} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches on intersection and renders 'Available' when Apple returns a populated state", async () => {
    mockFetch({
      state: {
        availableInNewTerritories: true,
        territoryCount: 175,
        territoryIds: [],
      },
    });
    render(<AvailabilityCell internalIapId="uuid-1" />);
    await waitFor(() => {
      expect(screen.getByText("Available")).toBeTruthy();
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/iap-management/iaps/uuid-1/availability",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("renders 'Remove from Sales' (red) when Apple returns state === null", async () => {
    mockFetch({ state: null });
    render(<AvailabilityCell internalIapId="uuid-2" />);
    await waitFor(() => {
      const el = screen.getByText("Remove from Sales");
      expect(el).toBeTruthy();
      expect(el.className).toMatch(/text-red-/);
    });
  });

  it("renders the rate-limited state as an amber retry button", async () => {
    mockFetch({ state: null, error: "rate_limited" });
    render(<AvailabilityCell internalIapId="uuid-3" />);
    await waitFor(() => {
      expect(screen.getByText("(rate limited)")).toBeTruthy();
    });
    const btn = screen.getByRole("button");
    expect(btn.className).toMatch(/text-amber-/);
    expect(btn.getAttribute("title")).toMatch(/rate limit/i);
  });

  it("renders the fetch-failed state when the API surfaces error=fetch_failed", async () => {
    mockFetch({ state: null, error: "fetch_failed", reason: "Apple 503" });
    render(<AvailabilityCell internalIapId="uuid-4" />);
    await waitFor(() => {
      expect(screen.getByText("(fetch failed)")).toBeTruthy();
    });
  });

  it("renders the fetch-failed state when the network promise rejects", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("net::ERR_FAILED")) as unknown as typeof fetch;
    render(<AvailabilityCell internalIapId="uuid-5" />);
    await waitFor(() => {
      expect(screen.getByText("(fetch failed)")).toBeTruthy();
    });
  });

  it("re-fires the fetch when Manager clicks the retry button on a rate-limited cell", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: null, error: "rate_limited" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          state: {
            availableInNewTerritories: true,
            territoryCount: 175,
            territoryIds: [],
          },
        }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<AvailabilityCell internalIapId="uuid-6" />);
    await waitFor(() => screen.getByText("(rate limited)"));

    fireEvent.click(screen.getByRole("button"));

    // Cell flips back to pending → IntersectionObserver fires → second fetch
    // resolves with Available.
    await waitFor(() => {
      expect(screen.getByText("Available")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
