// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";

import { PricingSourceSelector } from "./PricingSourceSelector";

describe("PricingSourceSelector", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("disables template radios when no templates exist", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        defaultExists: false,
        appExists: false,
        defaultTiers: [],
        appTiers: [],
      }),
    });
    const onChange = vi.fn();
    render(
      <PricingSourceSelector
        value="google_default"
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
      />,
    );
    await waitFor(() => {
      const radios = screen.getAllByRole("radio");
      expect(radios).toHaveLength(3);
      // Queried by accessible name, NOT by index. The Phase-1 reorder
      // (templates first, Google Conversion last) broke the previous
      // radios[0]/[1]/[2] assertions; name-based queries assert the
      // behaviour that actually matters (which source is selectable) and
      // survive any future reordering.
      expect(screen.getByRole("radio", { name: /Google Conversion/ })).toBeEnabled();
      expect(screen.getByRole("radio", { name: /Default Template/ })).toBeDisabled();
      expect(screen.getByRole("radio", { name: /App-specific Template/ })).toBeDisabled();
    });
  });

  it("renders the three sources in Phase-1 order: Default Template, App-specific Template, Google Conversion", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        defaultExists: true,
        appExists: true,
        defaultTiers: ["Tier 1"],
        appTiers: ["Tier A"],
      }),
    });
    render(
      <PricingSourceSelector
        value="google_default"
        onChange={vi.fn()}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
      />,
    );
    // Render order IS the Manager-specified contract here, so it gets one
    // explicit assertion rather than being implied by every other test.
    await waitFor(() => {
      const titles = screen
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label") ?? r.closest("label")?.textContent ?? "");
      expect(titles[0]).toMatch(/Default Template/);
      expect(titles[1]).toMatch(/App-specific Template/);
      expect(titles[2]).toMatch(/Google Conversion/);
    });
    // The persisted values are unchanged by the relabel — the old label
    // "Google default" must be gone from the UI entirely.
    expect(screen.queryByText("Google default")).not.toBeInTheDocument();
  });

  it("enables Default Template radio when global template exists, shows tier picker on selection", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        defaultExists: true,
        appExists: false,
        defaultTiers: ["Tier 1", "Tier 2"],
        appTiers: [],
      }),
    });
    const onChange = vi.fn();
    const onTierChange = vi.fn();
    const { rerender } = render(
      <PricingSourceSelector
        value="google_default"
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={onTierChange}
      />,
    );
    const user = userEvent.setup();
    await waitFor(() => {
      // Name-based, not index-based — see the reorder note above.
      expect(
        screen.getByRole("radio", { name: /Default Template/ }),
      ).toBeEnabled();
    });

    // Switch the value via parent (controlled component pattern)
    rerender(
      <PricingSourceSelector
        value="default_template"
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={onTierChange}
      />,
    );

    // Tier picker should render now.
    const select = await screen.findByRole("combobox");
    expect(select).toBeInTheDocument();
    // The dropdown has the two tiers + placeholder.
    expect(screen.getByText("Tier 1")).toBeInTheDocument();
    expect(screen.getByText("Tier 2")).toBeInTheDocument();

    await user.selectOptions(select, "Tier 2");
    expect(onTierChange).toHaveBeenCalledWith("Tier 2");
  });

  it("snaps back to google_default when active source becomes unavailable", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        defaultExists: false,
        appExists: false,
        defaultTiers: [],
        appTiers: [],
      }),
    });
    const onChange = vi.fn();
    render(
      <PricingSourceSelector
        value="default_template"
        onChange={onChange}
        appId="app-123"
        tierValue="Tier 1"
        onTierChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("google_default");
    });
  });
});
