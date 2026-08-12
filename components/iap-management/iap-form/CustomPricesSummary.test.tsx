// @vitest-environment jsdom
/**
 * Pricing-section custom-prices block.
 *
 * Two design requirements that are easy to regress into a bare count:
 *   §F  custom is NEVER opaque — the count always ships with actual values
 *   §D  staleness is visible here as well as in the dialog and the badge
 * Plus the three disabled reasons, each of which exists because the SERVER would
 * otherwise drop the Manager's work silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomPricesSummary } from "./CustomPricesSummary";
import type { CustomPriceBaseline } from "@/lib/iap-management/custom-prices/model";

const BASELINE: CustomPriceBaseline = {
  tier_id: "TIER_10",
  pricing_source: "APP_TEMPLATE",
  base_territory: "USA",
};

const SIX = [
  { territory_code: "BRA", customer_price: 24.9, currency_code: "BRL" },
  { territory_code: "IND", customer_price: 899, currency_code: "INR" },
  { territory_code: "JPN", customer_price: 1200, currency_code: "JPY" },
  { territory_code: "KAZ", customer_price: 4490, currency_code: "KZT" },
  { territory_code: "MYS", customer_price: 34.9, currency_code: "MYR" },
  { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
];

function renderSummary(props?: Partial<Parameters<typeof CustomPricesSummary>[0]>) {
  const onOpen = vi.fn();
  const onClearAll = vi.fn();
  const onKeepReviewed = vi.fn();
  render(
    <CustomPricesSummary
      entries={[]}
      currentBaseline={BASELINE}
      storedBaseline={null}
      donorAvailable
      persistedDraft
      onOpen={onOpen}
      onClearAll={onClearAll}
      onKeepReviewed={onKeepReviewed}
      {...props}
    />,
  );
  return { onOpen, onClearAll, onKeepReviewed };
}

beforeEach(() => vi.clearAllMocks());

describe("zero state", () => {
  it("says plainly that template/auto pricing applies", () => {
    renderSummary();
    expect(
      screen.getByText(/No custom prices — Apple's template\/auto pricing applies/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set custom prices" })).toBeEnabled();
  });
});

describe("§F — custom is never opaque", () => {
  it("shows the count AND actual values, with an overflow hint", () => {
    renderSummary({ entries: SIX, storedBaseline: BASELINE });
    expect(screen.getByTestId("custom-prices-count-badge").textContent).toBe("6 custom");
    const values = screen.getByTestId("custom-prices-inline-values").textContent ?? "";
    // Four inline values, actual numbers — not just a count.
    expect(values).toContain("BRA 24.9 BRL");
    expect(values).toContain("IND 899 INR");
    expect(values).toContain("JPN 1200 JPY");
    expect(values).toContain("KAZ 4490 KZT");
    expect(values).toContain("+ 2 more");
  });

  it("re-opens the dialog to see the full set", () => {
    const { onOpen } = renderSummary({ entries: SIX, storedBaseline: BASELINE });
    fireEvent.click(screen.getByRole("button", { name: "Edit custom prices" }));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("§D — staleness surfaced here too", () => {
  it("renders the banner, names the drift, and offers both resolutions", () => {
    const { onClearAll, onKeepReviewed } = renderSummary({
      entries: SIX,
      currentBaseline: { ...BASELINE, tier_id: "TIER_15" },
      storedBaseline: BASELINE,
    });
    const banner = screen.getByTestId("custom-prices-form-stale-banner");
    expect(banner.textContent).toContain("price tier TIER_10 → TIER_15");
    expect(banner.textContent).toMatch(/Nothing has been deleted/);

    fireEvent.click(screen.getByRole("button", { name: /Keep them \(reviewed\)/ }));
    expect(onKeepReviewed).toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: /Clear all custom prices/ })[0],
    );
    expect(onClearAll).toHaveBeenCalled();
  });

  it("marks the count badge stale", () => {
    renderSummary({
      entries: SIX,
      currentBaseline: { ...BASELINE, tier_id: "TIER_15" },
      storedBaseline: BASELINE,
    });
    expect(screen.getByTestId("custom-prices-count-badge").textContent).toBe(
      "6 custom · stale",
    );
  });

  it("⚠ changing the base BACK removes the banner with no user action", () => {
    // The comparison-not-boolean property, at the UI layer.
    const { unmount } = render(
      <CustomPricesSummary
        entries={SIX}
        currentBaseline={{ ...BASELINE, tier_id: "TIER_15" }}
        storedBaseline={BASELINE}
        donorAvailable
        persistedDraft
        onOpen={vi.fn()}
        onClearAll={vi.fn()}
        onKeepReviewed={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("custom-prices-form-stale-banner"),
    ).toBeInTheDocument();
    unmount();

    render(
      <CustomPricesSummary
        entries={SIX}
        currentBaseline={BASELINE}
        storedBaseline={BASELINE}
        donorAvailable
        persistedDraft
        onOpen={vi.fn()}
        onClearAll={vi.fn()}
        onKeepReviewed={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId("custom-prices-form-stale-banner"),
    ).not.toBeInTheDocument();
  });

  it("no banner without customs — a stale fingerprint alone is nothing to review", () => {
    renderSummary({
      entries: [],
      currentBaseline: { ...BASELINE, tier_id: "TIER_15" },
      storedBaseline: BASELINE,
    });
    expect(
      screen.queryByTestId("custom-prices-form-stale-banner"),
    ).not.toBeInTheDocument();
  });
});

describe("disabled reasons — each exists because the server would drop the work silently", () => {
  it("CP-3: no tier ⇒ disabled, and says why", () => {
    renderSummary({ currentBaseline: null });
    expect(screen.getByRole("button", { name: "Set custom prices" })).toBeDisabled();
    expect(screen.getByTestId("custom-prices-disabled-reason").textContent).toMatch(
      /Pick a price tier first/,
    );
  });

  it("J-1: no donor ⇒ disabled with the real reason, not a bare grey button", () => {
    renderSummary({ donorAvailable: false });
    expect(screen.getByRole("button", { name: "Set custom prices" })).toBeDisabled();
    expect(screen.getByTestId("custom-prices-disabled-reason").textContent).toMatch(
      /create this IAP first/i,
    );
  });

  it("unsaved draft ⇒ disabled, pointing at Save as Draft", () => {
    renderSummary({ persistedDraft: false });
    expect(screen.getByRole("button", { name: "Set custom prices" })).toBeDisabled();
    expect(screen.getByTestId("custom-prices-disabled-reason").textContent).toMatch(
      /Save as draft first/i,
    );
  });

  it("tier absence outranks the other reasons (it is the one the server enforces)", () => {
    renderSummary({ currentBaseline: null, donorAvailable: false });
    expect(screen.getByTestId("custom-prices-disabled-reason").textContent).toMatch(
      /Pick a price tier first/,
    );
  });
});

describe("§C — the second clear-all exit", () => {
  it("is reachable without opening the dialog", () => {
    const { onClearAll } = renderSummary({ entries: SIX, storedBaseline: BASELINE });
    fireEvent.click(
      screen.getByRole("button", { name: "Clear all custom prices" }),
    );
    expect(onClearAll).toHaveBeenCalled();
  });

  it("is absent when there is nothing to clear", () => {
    renderSummary({ entries: [] });
    expect(
      screen.queryByRole("button", { name: "Clear all custom prices" }),
    ).not.toBeInTheDocument();
  });
});
