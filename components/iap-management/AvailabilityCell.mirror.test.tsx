// @vitest-environment jsdom

/**
 * [EXPORT-availability-filter] C5 — the list column reads the mirror first.
 *
 * MUTATION (f): a cell with NO mirror record must still fetch. Mirror-first is
 * a shortcut for items already known, not a replacement for the lazy read —
 * dropping the fetch would mean an app nobody has swept shows an empty column
 * forever, with no way to fill it except a button most Managers would have no
 * reason to press.
 *
 * AND THE M3 BUG ITSELF: after Refresh from Apple or a Remove from Sales, the
 * column must update WITHOUT a hard reload. Before C5 it could not — the cell
 * never unmounts across `router.refresh()`, and the observer effect returns
 * early on any non-pending state, so a resolved cell was frozen for the life of
 * the page. A Manager who removed an item watched the column keep saying
 * "Available" and had every reason to think the removal had failed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { __resetQueueForTests } from "@/lib/iap-management/client-fetch-queue";
import type { AvailabilityMirrorRecord } from "@/lib/iap-management/apple/availability-as-of";
import { AvailabilityCell } from "./AvailabilityCell";

class ImmediateIntersectionObserver {
  private cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
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
const originalObserver = (
  globalThis as { IntersectionObserver?: typeof IntersectionObserver }
).IntersectionObserver;

const AVAILABLE = (syncedAt: string): AvailabilityMirrorRecord => ({
  state: "AVAILABLE",
  territoryCount: 175,
  syncedAt,
});
const REMOVED = (syncedAt: string): AvailabilityMirrorRecord => ({
  state: "REMOVED",
  territoryCount: 0,
  syncedAt,
});

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
  vi.restoreAllMocks();
});

// ─── MUTATION (f) — the lazy path survives ──────────────────────────────────

describe("⚠ MUTATION (f) — no mirror record still means a real fetch", () => {
  it("fetches when the mirror knows nothing about the item", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        state: { availableInNewTerritories: false, territoryCount: 175, territoryIds: [] },
        syncedAt: "2026-08-26T10:00:00Z",
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<AvailabilityCell internalIapId="uuid-1" mirror={null} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/iap-management/iaps/uuid-1/availability",
    );
    expect(await screen.findByText("Available")).toBeTruthy();
  });

  it("fetches when the mirror prop is omitted entirely", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ state: null, syncedAt: "2026-08-26T10:00:00Z" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<AvailabilityCell internalIapId="uuid-1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Remove from Sales")).toBeTruthy();
  });

  it("⚠ a failed fetch still renders the retry affordance, not a verdict", async () => {
    // Unchanged behaviour, re-pinned here because mirror-first added a new way
    // to reach the render: an error must never borrow the mirror's vocabulary.
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ state: null, error: "fetch_failed", reason: "500" }),
    }) as unknown as typeof fetch;

    render(<AvailabilityCell internalIapId="uuid-1" mirror={null} />);

    expect(await screen.findByText("(fetch failed)")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.queryByText("Remove from Sales")).toBeNull();
  });
});

// ─── Mirror-first — the ~1000-requests-per-scroll saving ────────────────────

describe("a known item renders from the mirror and asks Apple nothing", () => {
  it("renders Available with ZERO fetches", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <AvailabilityCell internalIapId="uuid-1" mirror={AVAILABLE("2026-08-26T10:00:00Z")} />,
    );

    expect(await screen.findByText("Available")).toBeTruthy();
    // Give the observer's microtask every chance to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders Removed with ZERO fetches", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <AvailabilityCell internalIapId="uuid-1" mirror={REMOVED("2026-08-26T10:00:00Z")} />,
    );

    expect(await screen.findByText("Remove from Sales")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a row with no internal UUID stays inert whatever the mirror says", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(
      <AvailabilityCell internalIapId={null} mirror={AVAILABLE("2026-08-26T10:00:00Z")} />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── THE M3 BUG — the column must move without a reload ─────────────────────

describe("⚠ THE M3 BUG — a newer mirror updates the cell with no reload", () => {
  it("Available → Removed when Remove from Sales writes a fresher verdict", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const { rerender } = render(
      <AvailabilityCell internalIapId="uuid-1" mirror={AVAILABLE("2026-08-26T10:00:00Z")} />,
    );
    expect(await screen.findByText("Available")).toBeTruthy();

    // The Remove from Sales write lands, `router.refresh()` re-renders the
    // server tree, and a fresher record arrives as a prop. Before C5 this
    // changed nothing on screen and only F5 fixed it.
    rerender(
      <AvailabilityCell internalIapId="uuid-1" mirror={REMOVED("2026-08-26T11:00:00Z")} />,
    );

    expect(await screen.findByText("Remove from Sales")).toBeTruthy();
    expect(screen.queryByText("Available")).toBeNull();
  });

  it("Removed → Available when a Refresh sweep finds it back on sale", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { rerender } = render(
      <AvailabilityCell internalIapId="uuid-1" mirror={REMOVED("2026-08-26T10:00:00Z")} />,
    );
    expect(await screen.findByText("Remove from Sales")).toBeTruthy();

    rerender(
      <AvailabilityCell internalIapId="uuid-1" mirror={AVAILABLE("2026-08-26T11:00:00Z")} />,
    );
    expect(await screen.findByText("Available")).toBeTruthy();
  });

  it("⚠ an OLDER mirror does NOT push the stale answer back on screen", async () => {
    // A server render racing a cell's own just-completed fetch must lose. The
    // naive "always adopt the prop" fix would reintroduce the stale verdict the
    // Manager just watched change.
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { rerender } = render(
      <AvailabilityCell internalIapId="uuid-1" mirror={REMOVED("2026-08-26T11:00:00Z")} />,
    );
    expect(await screen.findByText("Remove from Sales")).toBeTruthy();

    rerender(
      <AvailabilityCell internalIapId="uuid-1" mirror={AVAILABLE("2026-08-26T09:00:00Z")} />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Available")).toBeNull();
    expect(screen.getByText("Remove from Sales")).toBeTruthy();
  });

  it("a mirror arriving for a previously-unknown item settles it without a second fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ state: null, error: "rate_limited" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <AvailabilityCell internalIapId="uuid-1" mirror={null} />,
    );
    expect(await screen.findByText("(rate limited)")).toBeTruthy();

    // Refresh from Apple sweeps server-side and succeeds where the cell's own
    // read was throttled.
    rerender(
      <AvailabilityCell internalIapId="uuid-1" mirror={AVAILABLE("2026-08-26T11:00:00Z")} />,
    );
    expect(await screen.findByText("Available")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── onResolved — how the as-of line stays true mid-page ────────────────────

describe("onResolved reports only what Apple actually confirmed", () => {
  it("fires with the verdict and the mirror's own timestamp", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        state: { availableInNewTerritories: false, territoryCount: 42, territoryIds: [] },
        syncedAt: "2026-08-26T10:00:00Z",
      }),
    }) as unknown as typeof fetch;

    const onResolved = vi.fn();
    render(
      <AvailabilityCell internalIapId="uuid-1" mirror={null} onResolved={onResolved} />,
    );

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith({
      state: "AVAILABLE",
      territoryCount: 42,
      syncedAt: "2026-08-26T10:00:00Z",
    });
  });

  it("⚠ does NOT fire on a rate-limited read — nothing was learned", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ state: null, error: "rate_limited" }),
    }) as unknown as typeof fetch;

    const onResolved = vi.fn();
    render(
      <AvailabilityCell internalIapId="uuid-1" mirror={null} onResolved={onResolved} />,
    );

    expect(await screen.findByText("(rate limited)")).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("⚠ does NOT fire when the mirror write failed — no timestamp, no claim", async () => {
    // The route omits `syncedAt` when its own write did not land. Reporting a
    // verdict the page would then date with `Date.now()` would invent an
    // as-of the DB does not agree with.
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        state: { availableInNewTerritories: false, territoryCount: 175, territoryIds: [] },
      }),
    }) as unknown as typeof fetch;

    const onResolved = vi.fn();
    render(
      <AvailabilityCell internalIapId="uuid-1" mirror={null} onResolved={onResolved} />,
    );

    expect(await screen.findByText("Available")).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });
});
