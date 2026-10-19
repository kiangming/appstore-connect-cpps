/**
 * H4.3 (Manager 2026-10-19) — the single-item form applies the SAME price
 * rules as the bulk file and the custom-prices dialog (statedPriceError,
 * file-price.ts): "26.000" in a currency without decimals is refused as a
 * possible thousands separator, and a 0 price is refused.
 *
 * The trap these tests pin: the form's OWN seed must not trip the rule. A
 * cached VND price used to be seeded as "26000.00" (microsToDecimal(m, 2)),
 * which the new rule would refuse — every edit of a VND-default item,
 * even a title-only one, would have been blocked.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";

import { IapForm } from "./IapForm";
import { iapDetailToInitial } from "@/lib/google-iap-management/form-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** An item whose cached default currency is VND (no US region). */
function vndDetail() {
  return {
    iap: {
      sku: "gem_pack_vn",
      purchase_type: "managed",
      status: "active",
      default_currency: "VND",
      default_price_micros: "26000000000",
    },
    listings: [{ locale: "en-US", title: "VN Gem Pack", description: "d" }],
    prices: [
      { region_code: "VN", currency: "VND", price_micros: "26000000000" },
      { region_code: "JP", currency: "JPY", price_micros: "160000000" },
    ],
  };
}

const APP_DEFAULTS = { currency: "VND", language: "en-US" };
const props = { packageName: "com.example.app", appId: "app-uuid-1", appDefaults: APP_DEFAULTS };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes("pricing-templates/availability")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ defaultExists: false, appExists: false, defaultTiers: [], appTiers: [] }),
      });
    }
    if (u.includes("live-prices")) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, prices: vndDetail().prices }) });
    }
    if (u.includes("regions/catalog")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ regions: [{ regionCode: "VN", currency: "VND", convertedDecimal: "27000" }], regionsVersion: "2026/01" }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("H4.3 — the single-item form: (a) thousands separator and (b) zero, without tripping on its own seed", () => {
  it("seed: a whole VND / JPY amount is seeded with no dot ('26000', '160'); TWD 6.30 keeps its decimals", () => {
    const initial = iapDetailToInitial(vndDetail(), APP_DEFAULTS);
    expect(initial.basePriceDecimal).toBe("26000");
    expect(initial.regionOverrides.map((r) => [r.region, r.priceDecimal])).toEqual([
      ["VN", "26000"],
      ["JP", "160"],
    ]);
    const tw = iapDetailToInitial(
      { ...vndDetail(), prices: [{ region_code: "TW", currency: "TWD", price_micros: "6300000" }] },
      APP_DEFAULTS,
    );
    expect(tw.regionOverrides[0].priceDecimal).toBe("6.30");
  });

  it("a title-only edit of a VND-default item reaches Review — the seeded base is not refused", async () => {
    const user = userEvent.setup();
    const initial = iapDetailToInitial(vndDetail(), APP_DEFAULTS);
    render(<IapForm {...props} mode={{ kind: "edit", initial }} />);
    await screen.findByText(/Per-country pricing/i);
    const title = screen.getByPlaceholderText("Small Gem Pack");
    await user.clear(title);
    await user.type(title, "Renamed");
    await user.click(screen.getByRole("button", { name: /review changes/i }));
    expect(screen.queryByText(/please fix the errors above/i)).toBeNull();
    expect(screen.queryByText(/thousands separator/i)).toBeNull();
    expect(screen.getByText(/confirm to push these updates/i)).toBeInTheDocument();
  });

  it("typed base '26.000' VND is refused as a possible thousands separator, and the catalogue is NOT recomputed from it", async () => {
    const user = userEvent.setup();
    const initial = iapDetailToInitial(vndDetail(), APP_DEFAULTS);
    render(<IapForm {...props} mode={{ kind: "edit", initial }} />);
    await screen.findByText(/Per-country pricing/i);
    const base = screen.getByPlaceholderText("23000");
    await user.clear(base);
    await user.type(base, "26.000");
    // Past the re-derive debounce: no conversion was requested for 26 VND.
    await new Promise((r) => setTimeout(r, 700));
    const catalogFor26 = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes("regions/catalog") && String(c[0]).includes("basePriceMicros=26000000&"),
    );
    expect(catalogFor26).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /review changes/i }));
    await waitFor(() => expect(screen.getByText(/it may be a thousands separator \(26\.000 = 26 thousand\?\)/)).toBeInTheDocument());
    expect(screen.queryByText(/confirm to push these updates/i)).toBeNull();
  });

  it("a region price typed as 0 blocks Review with the zero reason", async () => {
    const user = userEvent.setup();
    const initial = iapDetailToInitial(vndDetail(), APP_DEFAULTS);
    render(<IapForm {...props} mode={{ kind: "edit", initial }} />);
    await screen.findByText(/Per-country pricing/i);
    const jp = await screen.findByLabelText("Tool price for JP");
    await user.clear(jp);
    await user.type(jp, "0");
    await user.click(screen.getByRole("button", { name: /review changes/i }));
    await waitFor(() => expect(screen.getAllByText(/the price is 0 — a 0 price is not accepted/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/confirm to push these updates/i)).toBeNull();
  });
});
