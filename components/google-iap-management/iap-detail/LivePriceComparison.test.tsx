// @vitest-environment jsdom

/**
 * LivePriceComparison — live-vs-stored panel behavior.
 * Covers: live column renders from the fetch; divergence rows flagged when
 * live ≠ tool; territory mismatch handled both directions; live-fetch failure
 * degrades gracefully (tool column still renders + retry); per-item sync
 * replaces prices and the columns reconcile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { LivePriceComparison } from "./LivePriceComparison";
import type { RegionPrice } from "@/lib/google-iap-management/price-comparison";

const toolPrices: RegionPrice[] = [
  { region_code: "US", currency: "USD", price_micros: "990000" },
  { region_code: "VN", currency: "VND", price_micros: "23000000000" }, // tool-only
];

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  global.fetch = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(impl(url, init)),
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  refresh.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("LivePriceComparison", () => {
  it("renders the live column from the fetch and flags divergence (diff + tool-only + live-only)", async () => {
    mockFetch((url) => {
      if (url.endsWith("/live-prices")) {
        return {
          ok: true,
          prices: [
            { region_code: "US", currency: "USD", price_micros: "1990000" }, // diff (tool 0.99)
            { region_code: "MY", currency: "MYR", price_micros: "12900000" }, // live-only
          ],
        };
      }
      return { ok: true, prices: [] };
    });

    render(<LivePriceComparison packageName="com.x" sku="coins" toolPrices={toolPrices} />);

    // live column loads
    await waitFor(() => expect(screen.getByText("USD 1.99")).toBeTruthy());
    // tool value still shown
    expect(screen.getByText("USD 0.99")).toBeTruthy();
    // divergence summary badge
    expect(screen.getByText(/3 divergent/)).toBeTruthy();
    // both-direction territory mismatch labels present
    expect(screen.getByText("In tool, not on Google")).toBeTruthy(); // VN
    expect(screen.getByText("On Google, not in tool")).toBeTruthy(); // MY
    expect(screen.getByText("Differs")).toBeTruthy(); // US
  });

  it("shows 'In sync' and no divergence when live equals tool", async () => {
    mockFetch((url) => {
      if (url.endsWith("/live-prices")) {
        return { ok: true, prices: toolPrices };
      }
      return { ok: true, prices: [] };
    });
    render(<LivePriceComparison packageName="com.x" sku="coins" toolPrices={toolPrices} />);
    await waitFor(() => expect(screen.getByText(/In sync/)).toBeTruthy());
    expect(screen.queryByText(/divergent/)).toBeNull();
    expect(screen.getAllByText("Match").length).toBe(2);
  });

  it("degrades gracefully when the live fetch fails: tool column still renders + retry", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: "Google rate limited" }),
      }),
    ) as unknown as typeof fetch;

    render(<LivePriceComparison packageName="com.x" sku="coins" toolPrices={toolPrices} />);

    // error surfaced in the live column, page not broken
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load live prices/)).toBeTruthy(),
    );
    expect(screen.getByText(/Google rate limited/)).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
    // tool column still rendered from props
    expect(screen.getByText("USD 0.99")).toBeTruthy();
    expect(screen.getByText("VND 23000.00")).toBeTruthy();
  });

  it("per-item sync replaces prices and the columns reconcile", async () => {
    // live initially diverges from tool (US differs, VN tool-only)
    mockFetch((url, init) => {
      if (url.endsWith("/live-prices")) {
        return {
          ok: true,
          prices: [{ region_code: "US", currency: "USD", price_micros: "1990000" }],
        };
      }
      if (url.endsWith("/sync-prices") && init?.method === "POST") {
        // server replaced DB with live; returns the synced (live) prices
        return {
          ok: true,
          sku: "coins",
          prices: [{ region_code: "US", currency: "USD", price_micros: "1990000" }],
        };
      }
      return { ok: true, prices: [] };
    });

    render(<LivePriceComparison packageName="com.x" sku="coins" toolPrices={toolPrices} />);
    await waitFor(() => expect(screen.getByText(/divergent/)).toBeTruthy());

    // open the light confirm, then confirm
    fireEvent.click(screen.getByText("Sync from Google"));
    expect(screen.getByText(/Replace the tool's stored prices/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));

    // after sync: router.refresh called (server re-renders tool column);
    // live state set to the synced prices.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const postCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).endsWith("/sync-prices"),
    );
    expect(postCalls.length).toBe(1);
  });

  it("retry re-fetches live after a failure", async () => {
    let calls = 0;
    global.fetch = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ error: "transient" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ ok: true, prices: toolPrices }),
      });
    }) as unknown as typeof fetch;

    render(<LivePriceComparison packageName="com.x" sku="coins" toolPrices={toolPrices} />);
    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText(/In sync/)).toBeTruthy());
  });
});
