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
      expect(radios[0]).toBeEnabled(); // google_default
      expect(radios[1]).toBeDisabled(); // default_template
      expect(radios[2]).toBeDisabled(); // app_template
    });
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
      const defaultRadio = screen.getAllByRole("radio")[1];
      expect(defaultRadio).toBeEnabled();
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
