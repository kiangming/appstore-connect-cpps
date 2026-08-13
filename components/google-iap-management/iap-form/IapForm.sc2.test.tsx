/**
 * SC2 — the Edit form half, proven against a real render.
 *
 * Two defects are pinned here:
 *
 * 1. WRITE-BACKWARDS. `initial` is a live prop, but the form seeds state from
 *    it once and the page renders <IapForm> with no key, so a
 *    `router.refresh()` ("Sync from Google", UnifiedPricingTable.tsx:129-131)
 *    hands new `initial` to a surviving instance. The diff then compared fresh
 *    server truth against stale client state, INVERTED, and the review modal
 *    proposed writing pre-sync prices back over Google's current ones.
 *
 * 2. DIRTY TRACKING. A row the Manager pinned must survive a base-price
 *    re-derive; a row they never touched must be recomputed.
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

function detail(usdMicros: string, vndMicros: string) {
  return {
    iap: {
      sku: "gem_pack_small",
      purchase_type: "managed",
      status: "active",
      default_currency: "USD",
      default_price_micros: usdMicros,
    },
    listings: [
      { locale: "en-US", title: "Small Gem Pack", description: "200 gems." },
    ],
    prices: [
      { region_code: "US", currency: "USD", price_micros: usdMicros },
      { region_code: "VN", currency: "VND", price_micros: vndMicros },
    ],
  };
}

const APP_DEFAULTS = { currency: "USD", language: "en-US" };
const props = {
  packageName: "com.example.app",
  appId: "app-uuid-1",
  appDefaults: APP_DEFAULTS,
};

/** Catalogue Google returns when reconverting a new base price. */
let catalogRegions: Array<{
  regionCode: string;
  currency: string;
  convertedDecimal: string;
}> = [];
let livePrices: Array<{ region_code: string; currency: string; price_micros: string }> =
  [];

const fetchMock = vi.fn();

beforeEach(() => {
  catalogRegions = [
    { regionCode: "US", currency: "USD", convertedDecimal: "2.990000" },
    { regionCode: "VN", currency: "VND", convertedDecimal: "74000.000000" },
  ];
  livePrices = detail("1990000", "49000000000").prices;
  fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes("pricing-templates/availability")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          defaultExists: false,
          appExists: false,
          defaultTiers: [],
          appTiers: [],
        }),
      });
    }
    if (u.includes("live-prices")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, prices: livePrices }),
      });
    }
    if (u.includes("regions/catalog")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ regions: catalogRegions, regionsVersion: "2026/01" }),
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

async function toolPriceInput(region: string) {
  return screen.findByLabelText(`Tool price for ${region}`);
}

describe("SC2 — re-seed kills the write-backwards diff", () => {
  it("a pure Sync from Google leaves NOTHING to submit", async () => {
    const user = userEvent.setup();
    const before = iapDetailToInitial(detail("1990000", "49000000000"), APP_DEFAULTS);
    const after = iapDetailToInitial(detail("2990000", "74000000000"), APP_DEFAULTS);

    const { rerender } = render(
      <IapForm {...props} mode={{ kind: "edit", initial: before }} />,
    );
    await screen.findByText(/Per-country pricing/i);

    // What router.refresh() does after a sync: new `initial`, same instance.
    livePrices = detail("2990000", "74000000000").prices;
    rerender(<IapForm {...props} mode={{ kind: "edit", initial: after }} />);

    await user.click(screen.getByRole("button", { name: /review changes/i }));

    // The modal must NOT open, and certainly must not propose reverting
    // Google to 1.99.
    expect(screen.queryByText(/confirm to push these updates/i)).toBeNull();
    expect(screen.getByText(/no changes to submit/i)).toBeInTheDocument();
  });

  it("re-seed adopts the new server values rather than keeping the stale ones", async () => {
    const before = iapDetailToInitial(detail("1990000", "49000000000"), APP_DEFAULTS);
    const after = iapDetailToInitial(detail("2990000", "74000000000"), APP_DEFAULTS);

    const { rerender } = render(
      <IapForm {...props} mode={{ kind: "edit", initial: before }} />,
    );
    await screen.findByText(/Per-country pricing/i);
    expect(await toolPriceInput("US")).toHaveValue("1.99");

    rerender(<IapForm {...props} mode={{ kind: "edit", initial: after }} />);

    await waitFor(async () =>
      expect(await toolPriceInput("US")).toHaveValue("2.99"),
    );
  });
});

describe("SC2 — dirty tracking through a base-price re-derive", () => {
  it("a row the Manager pinned survives; a row they never touched is recomputed", async () => {
    const user = userEvent.setup();
    const initial = iapDetailToInitial(
      detail("1990000", "49000000000"),
      APP_DEFAULTS,
    );
    render(<IapForm {...props} mode={{ kind: "edit", initial }} />);
    await screen.findByText(/Per-country pricing/i);

    // Manager pins VN by hand.
    const vn = await toolPriceInput("VN");
    await user.clear(vn);
    await user.type(vn, "12345");
    expect(vn).toHaveValue("12345");

    // …then changes the base price, which re-derives everything unpinned.
    const basePrice = screen.getByPlaceholderText("1.99");
    await user.clear(basePrice);
    await user.type(basePrice, "2.99");

    await waitFor(
      async () => expect(await toolPriceInput("US")).toHaveValue("2.990000"),
      { timeout: 4000 },
    );
    // The pinned row is untouched by the re-derive.
    expect(await toolPriceInput("VN")).toHaveValue("12345");
  });

  it("the re-derive applies Google's decimals verbatim — no rounding", async () => {
    const user = userEvent.setup();
    catalogRegions = [
      { regionCode: "US", currency: "USD", convertedDecimal: "2.990000" },
      { regionCode: "VN", currency: "VND", convertedDecimal: "74123.456789" },
    ];
    const initial = iapDetailToInitial(
      detail("1990000", "49000000000"),
      APP_DEFAULTS,
    );
    render(<IapForm {...props} mode={{ kind: "edit", initial }} />);
    await screen.findByText(/Per-country pricing/i);

    const basePrice = screen.getByPlaceholderText("1.99");
    await user.clear(basePrice);
    await user.type(basePrice, "2.99");

    await waitFor(
      async () => expect(await toolPriceInput("VN")).toHaveValue("74123.456789"),
      { timeout: 4000 },
    );
  });
});

describe("SC2 — dirty-scoped blocking (option B)", () => {
  it("a Google-authored invalid row warns but does NOT block submit", async () => {
    const user = userEvent.setup();
    // TW = TWD 6.30, exactly as production holds it. The tool's currency table
    // calls TWD whole-number-only, so before SC2 this row blocked every edit.
    const raw = detail("1990000", "49000000000");
    raw.prices.push({ region_code: "TW", currency: "TWD", price_micros: "6300000" });
    livePrices = raw.prices;
    const initial = iapDetailToInitial(raw, APP_DEFAULTS);

    render(<IapForm {...props} mode={{ kind: "edit", initial }} />);
    await screen.findByText(/Per-country pricing/i);

    // Warned, and the value is displayed EXACTLY as Google has it.
    expect(await toolPriceInput("TW")).toHaveValue("6.30");
    expect(
      screen.getByText(/Left exactly as Google has it/i),
    ).toBeInTheDocument();

    // Edit something unrelated and submit: the untouched TW row must not block.
    const title = screen.getByPlaceholderText("Small Gem Pack");
    await user.clear(title);
    await user.type(title, "Renamed Pack");
    await user.click(screen.getByRole("button", { name: /review changes/i }));

    expect(screen.queryByText(/please fix the errors above/i)).toBeNull();
    expect(
      screen.getByText(/confirm to push these updates/i),
    ).toBeInTheDocument();
  });
});
