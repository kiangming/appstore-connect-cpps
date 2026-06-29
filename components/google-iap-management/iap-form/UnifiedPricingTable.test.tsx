// @vitest-environment jsdom

/**
 * UnifiedPricingTable — the merged edit + live-compare surface.
 * Covers: live column renders read-only from the fetch; divergence flagged;
 * editing a tool override calls the existing index handler; inherit/live-only
 * row promotes via onAddOverrideForRegion; live column has no inputs (excluded
 * from edits/save); collapse hides matched rows but keeps them in the set;
 * sync posts + refreshes; live-fetch failure degrades gracefully.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { UnifiedPricingTable } from "./UnifiedPricingTable";
import type { RegionOverrideRow } from "@/lib/google-iap-management/form-state";

const overrides: RegionOverrideRow[] = [
  { region: "US", currency: "USD", priceDecimal: "0.99" },
  { region: "VN", currency: "VND", priceDecimal: "23000" },
];

function mockFetch(impl: (url: string, init?: RequestInit) => unknown, ok = true, status = 200) {
  global.fetch = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(impl(url, init)) }),
  ) as unknown as typeof fetch;
}

type TableProps = Parameters<typeof UnifiedPricingTable>[0];

function renderTable(extra: Partial<TableProps> = {}) {
  const onUpdateOverride = vi.fn();
  const onRemoveOverride = vi.fn();
  const onAddOverrideForRegion = vi.fn();
  render(
    <UnifiedPricingTable
      packageName="com.x"
      sku="coins"
      regionOverrides={overrides}
      baseCurrency="USD"
      basePriceDecimal="0.99"
      fieldErrors={{}}
      onUpdateOverride={onUpdateOverride}
      onRemoveOverride={onRemoveOverride}
      onAddOverrideForRegion={onAddOverrideForRegion}
      {...extra}
    />,
  );
  return { onUpdateOverride, onRemoveOverride, onAddOverrideForRegion };
}

beforeEach(() => refresh.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("UnifiedPricingTable", () => {
  it("renders live read-only column and flags divergence (diff + tool-only + live-only)", async () => {
    mockFetch((url) =>
      url.endsWith("/live-prices")
        ? {
            ok: true,
            prices: [
              { region_code: "US", currency: "USD", price_micros: "1990000" }, // diff vs 0.99
              { region_code: "MY", currency: "MYR", price_micros: "12900000" }, // live-only
            ],
          }
        : { ok: true, prices: [] },
    );
    renderTable();
    await waitFor(() => expect(screen.getByText("USD 1.99")).toBeTruthy()); // live value
    expect(screen.getByText(/3 divergent/)).toBeTruthy();
    expect(screen.getByText("Differs")).toBeTruthy(); // US
    expect(screen.getByText("In tool, not on Google")).toBeTruthy(); // VN
    expect(screen.getByText("On Google, not in tool")).toBeTruthy(); // MY
  });

  it("live column has NO inputs — only explicit overrides are editable (excluded from save)", async () => {
    mockFetch((url) =>
      url.endsWith("/live-prices")
        ? { ok: true, prices: [
            { region_code: "US", currency: "USD", price_micros: "990000" },
            { region_code: "MY", currency: "MYR", price_micros: "12900000" }, // inherit row, no input
          ] }
        : { ok: true, prices: [] },
    );
    renderTable();
    await waitFor(() => expect(screen.getByText("MYR 12.90")).toBeTruthy());
    // exactly two editable inputs (US, VN overrides); MY inherit + all live = no input
    expect(screen.getAllByRole("textbox").length).toBe(2);
  });

  it("editing a tool override calls the existing index handler", async () => {
    mockFetch((url) =>
      url.endsWith("/live-prices")
        ? { ok: true, prices: [{ region_code: "US", currency: "USD", price_micros: "990000" }] }
        : { ok: true, prices: [] },
    );
    const { onUpdateOverride } = renderTable();
    const usInput = await screen.findByLabelText("Tool price for US");
    fireEvent.change(usInput, { target: { value: "1.49" } });
    expect(onUpdateOverride).toHaveBeenCalledWith(0, { priceDecimal: "1.49" });
  });

  it("inherit/live-only row promotes to an explicit override via onAddOverrideForRegion", async () => {
    mockFetch((url) =>
      url.endsWith("/live-prices")
        ? { ok: true, prices: [{ region_code: "MY", currency: "MYR", price_micros: "12900000" }] }
        : { ok: true, prices: [] },
    );
    const { onAddOverrideForRegion } = renderTable();
    await waitFor(() => expect(screen.getByText(/inherits base/)).toBeTruthy());
    fireEvent.click(screen.getByText("override"));
    expect(onAddOverrideForRegion).toHaveBeenCalledWith("MY", "MYR");
  });

  it("collapses matched auto-equalized rows but keeps them in the set (expandable)", async () => {
    mockFetch((url) =>
      url.endsWith("/live-prices")
        ? { ok: true, prices: [
            { region_code: "US", currency: "USD", price_micros: "990000" }, // matches override → visible (explicit)
            { region_code: "VN", currency: "VND", price_micros: "23000000000" }, // matches override → visible (explicit)
            { region_code: "PR", currency: "USD", price_micros: "990000" }, // auto-eq inherit → collapsed
            { region_code: "GU", currency: "USD", price_micros: "990000" }, // auto-eq inherit → collapsed
          ] }
        : { ok: true, prices: [] },
    );
    renderTable();
    await waitFor(() => expect(screen.getByText(/In sync/)).toBeTruthy());
    // PR/GU collapsed by default
    expect(screen.queryByText(/\(PR\)/)).toBeNull();
    const toggle = screen.getByText(/Show 2 auto-equalized/);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/\(PR\)/)).toBeTruthy());
    expect(screen.getByText(/\(GU\)/)).toBeTruthy();
  });

  it("Sync from Google posts to sync-prices and refreshes", async () => {
    mockFetch((url, init) => {
      if (url.endsWith("/live-prices")) {
        return { ok: true, prices: [{ region_code: "US", currency: "USD", price_micros: "1990000" }] };
      }
      if (url.endsWith("/sync-prices") && init?.method === "POST") {
        return { ok: true, sku: "coins", prices: [{ region_code: "US", currency: "USD", price_micros: "1990000" }] };
      }
      return { ok: true, prices: [] };
    });
    renderTable();
    await waitFor(() => expect(screen.getByText(/divergent/)).toBeTruthy());
    fireEvent.click(screen.getByText("Sync from Google"));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const posts = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).endsWith("/sync-prices"),
    );
    expect(posts.length).toBe(1);
  });

  it("degrades gracefully when live fetch fails — overrides still render + retry", async () => {
    mockFetch(() => ({ error: "Google rate limited" }), false, 502);
    renderTable();
    await waitFor(() => expect(screen.getByText(/Couldn't load live prices/)).toBeTruthy());
    expect(screen.getByText("Retry")).toBeTruthy();
    // editable tool overrides still present (page not broken)
    expect(screen.getByLabelText("Tool price for US")).toBeTruthy();
    expect(screen.getByLabelText("Tool price for VN")).toBeTruthy();
  });
});
