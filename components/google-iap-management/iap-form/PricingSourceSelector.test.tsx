// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
    // A2 — a disabled card must say WHY. A greyed control with no reason is
    // the original complaint in a new shape.
    expect(screen.getByText(/No default template uploaded/)).toBeInTheDocument();
    expect(screen.getByText(/No template for this app/)).toBeInTheDocument();
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

  it("re-picks by PRIORITY when the active source turns out to be unavailable (merged snap-back)", async () => {
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

/**
 * Part A — loading state + priority default.
 *
 * The bug being fixed: on mount the selector pre-selected Google
 * Conversion, because the other two need an async availability check.
 * Managers read that as "the templates don't work", or proceeded on a
 * source they never chose. Same class as the other "UI states an answer
 * before it knows one" defects: the fix is to render "unknown" as unknown.
 */
describe("PricingSourceSelector — availability loading + priority default", () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function availability(over: Partial<Record<string, unknown>> = {}) {
    return {
      ok: true,
      json: async () => ({
        defaultExists: false,
        appExists: false,
        defaultTiers: [],
        appTiers: [],
        ...over,
      }),
    };
  }

  function renderSel(onChange = vi.fn(), value: "google_default" | "default_template" | "app_template" | null = null) {
    render(
      <PricingSourceSelector
        value={value}
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
        hideTierPicker
      />,
    );
    return onChange;
  }

  it("A1: before the check resolves, ALL THREE are disabled and NOTHING is selected", async () => {
    // A promise that never settles — the mount state, held still.
    fetchMock.mockReturnValue(new Promise(() => {}));
    const onChange = renderSel();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    radios.forEach((r) => expect(r).toBeDisabled());
    radios.forEach((r) => expect(r).not.toBeChecked());
    // And it says so, rather than showing a definite-looking blank state.
    expect(
      screen.getByText(/Checking which pricing templates are available/),
    ).toBeInTheDocument();
    // Critically: no source has been asserted to the parent yet.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("A3: auto-selects the APP template when one exists (highest priority)", async () => {
    fetchMock.mockResolvedValue(availability({ defaultExists: true, appExists: true }));
    const onChange = renderSel();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("app_template"));
  });

  it("A3: falls to the DEFAULT template when no app template exists", async () => {
    fetchMock.mockResolvedValue(availability({ defaultExists: true, appExists: false }));
    const onChange = renderSel();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("default_template"));
  });

  it("A3: falls to Google Conversion only when neither template exists", async () => {
    fetchMock.mockResolvedValue(availability());
    const onChange = renderSel();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("google_default"));
  });

  it("A3: the auto-selection is VISIBLY selected, not silently applied", async () => {
    fetchMock.mockResolvedValue(availability({ defaultExists: true }));
    // Parent echoes the choice back, as a controlled component does.
    const onChange = vi.fn();
    const { rerender } = render(
      <PricingSourceSelector
        value={null}
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
        hideTierPicker
      />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("default_template"));
    rerender(
      <PricingSourceSelector
        value="default_template"
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
        hideTierPicker
      />,
    );
    expect(screen.getByRole("radio", { name: /Default Template/ })).toBeChecked();
  });

  it("A6: no jumping selection — a valid choice is not re-driven on re-render", async () => {
    fetchMock.mockResolvedValue(availability({ defaultExists: true, appExists: true }));
    const onChange = vi.fn();
    const { rerender } = render(
      <PricingSourceSelector
        value="default_template"
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
        hideTierPicker
      />,
    );
    await waitFor(() => expect(screen.getByRole("radio", { name: /App-specific Template/ })).toBeEnabled());
    // The user's explicit Default Template pick is valid, so priority must
    // NOT override it back to app_template.
    rerender(
      <PricingSourceSelector
        value="default_template"
        onChange={onChange}
        appId="app-123"
        tierValue=""
        onTierChange={() => undefined}
        hideTierPicker
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("A4: when the check FAILS, Google Conversion stays usable and the error is shown with a retry", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    const onChange = renderSel();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't check pricing templates/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Not stranded: the no-template source is selectable and selected.
    expect(screen.getByRole("radio", { name: /Google Conversion/ })).toBeEnabled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("google_default"));
    // Templates stay disabled — we genuinely don't know whether they exist.
    expect(screen.getByRole("radio", { name: /Default Template/ })).toBeDisabled();
  });

  it("A4: Retry re-runs the check and enables what it finds", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "boom" }) })
      .mockResolvedValue(availability({ defaultExists: true }));
    renderSel();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Default Template/ })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a network throw is treated as an error state, not as 'no templates exist'", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderSel();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/offline/)).toBeInTheDocument();
  });
});
