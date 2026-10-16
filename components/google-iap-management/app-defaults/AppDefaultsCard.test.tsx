// @vitest-environment jsdom

/**
 * D9 [arc-google-missing-purchase-options] — the app page shows WHERE the
 * currency / language came from, and lets a Manager confirm a tool-guessed
 * value in ONE click (no retyping) or set a new one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import { AppDefaultsCard } from "./AppDefaultsCard";
import type { AppDefaultsState } from "@/lib/google-iap-management/app-defaults";

const GUESSED_USD_EN: AppDefaultsState = {
  currency: { value: "USD", source: "guessed" },
  language: { value: "en-US", source: "guessed" },
};

function installFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => routerRefresh.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("AppDefaultsCard — provenance is visible", () => {
  it("guessed values: shown with their value, flagged unconfirmed, with a one-click Confirm", () => {
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={GUESSED_USD_EN} readError={null} canEdit />,
    );
    const cur = screen.getByTestId("app-default-currency");
    expect(cur).toHaveAttribute("data-status", "unconfirmed");
    expect(cur).toHaveTextContent("USD");
    expect(cur).toHaveTextContent(/Guessed by the tool — not confirmed/);
    expect(within(cur).getByRole("button", { name: "Confirm USD" })).toBeEnabled();
  });

  it("empty value: 'Not set', no Confirm (nothing to confirm), a Set button", () => {
    render(
      <AppDefaultsCard
        appId="app-1"
        packageName="com.x"
        initialDefaults={{ ...GUESSED_USD_EN, language: { value: null, source: null } }}
        readError={null}
        canEdit
      />,
    );
    const lang = screen.getByTestId("app-default-language");
    expect(lang).toHaveAttribute("data-status", "unset");
    expect(within(lang).queryByRole("button", { name: /Confirm/ })).toBeNull();
    expect(within(lang).getByRole("button", { name: /Set/ })).toBeEnabled();
  });

  it("non-admin: values and provenance visible, no action buttons", () => {
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={GUESSED_USD_EN} readError={null} canEdit={false} />,
    );
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.getByText(/Only an admin can declare/)).toBeInTheDocument();
  });

  it("read error is shown as such — not as 'not set'", () => {
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={null} readError="column missing" canEdit />,
    );
    const card = screen.getByTestId("app-defaults-card");
    expect(card).toHaveTextContent(/Could not read/);
    expect(card).toHaveTextContent("column missing");
    expect(screen.queryByText("Not set")).toBeNull();
    // C2.1 — the defaults are not a bulk-import condition; the card must not say so.
    expect(card).toHaveTextContent("This does not decide whether bulk import runs.");
    expect(card).not.toHaveTextContent(/stays blocked|until they .*declared/i);
  });
});

describe("AppDefaultsCard — confirm / set", () => {
  it("Confirm POSTs the CURRENT value for THAT field, then shows Declared and refreshes the page", async () => {
    const fetchMock = installFetch({
      ok: true,
      json: async () => ({
        ok: true,
        defaults: { ...GUESSED_USD_EN, currency: { value: "USD", source: "declared" } },
      }),
    });
    render(
      <AppDefaultsCard appId="app-1" packageName="com.vnggames.ballisticherotwid" initialDefaults={GUESSED_USD_EN} readError={null} canEdit />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm USD" }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/google-iap-management/apps/com.vnggames.ballisticherotwid/defaults");
    // …with the row and value the card SHOWED, so a stale page is refused.
    expect(JSON.parse(init.body as string)).toEqual({
      field: "currency",
      value: "USD",
      appId: "app-1",
      expected: { value: "USD", source: "guessed" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("app-default-currency")).toHaveAttribute("data-status", "declared"),
    );
    // The OTHER field is untouched — the language still waits for the Manager.
    expect(screen.getByTestId("app-default-language")).toHaveAttribute("data-status", "unconfirmed");
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("a refused save shows the server's error and keeps the previous state", async () => {
    installFetch({ ok: false, status: 403, json: async () => ({ error: "Admin role required." }) });
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={GUESSED_USD_EN} readError={null} canEdit />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm USD" }));
    });
    await waitFor(() => expect(screen.getByText("Admin role required.")).toBeInTheDocument());
    expect(screen.getByTestId("app-default-currency")).toHaveAttribute("data-status", "unconfirmed");
  });

  it("Edit → choose another value → 'Save as declared' POSTs the chosen value", async () => {
    const fetchMock = installFetch({
      ok: true,
      json: async () => ({
        ok: true,
        defaults: { ...GUESSED_USD_EN, language: { value: "zh-TW", source: "declared" } },
      }),
    });
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={GUESSED_USD_EN} readError={null} canEdit />,
    );
    const lang = screen.getByTestId("app-default-language");
    fireEvent.click(within(lang).getByRole("button", { name: /Edit/ }));
    fireEvent.change(within(lang).getByRole("combobox"), { target: { value: "zh-TW" } });
    await act(async () => {
      fireEvent.click(within(lang).getByRole("button", { name: "Save as declared" }));
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      field: "language",
      value: "zh-TW",
      appId: "app-1",
      expected: { value: "en-US", source: "guessed" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("app-default-language")).toHaveAttribute("data-status", "declared"),
    );
  });

  it("saved but the server could not re-read ⇒ says SAVED (not 'failed'), asks for a reload (P5)", async () => {
    installFetch({
      ok: true,
      json: async () => ({ ok: true, defaults: null, reread_error: "timeout" }),
    });
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={GUESSED_USD_EN} readError={null} canEdit />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm USD" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("app-defaults-notice")).toHaveTextContent(/Saved as declared/),
    );
    expect(screen.queryByText(/Save failed/)).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("value changed since the page loaded (409) ⇒ the server's reload message, state kept", async () => {
    installFetch({
      ok: false,
      status: 409,
      json: async () => ({
        code: "DEFAULT_CHANGED",
        error: "This app's currency changed since the page loaded. It is now TWD (declared). Reload the page and try again. Nothing was written.",
      }),
    });
    render(
      <AppDefaultsCard appId="app-1" packageName="com.x" initialDefaults={GUESSED_USD_EN} readError={null} canEdit />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm USD" }));
    });
    await waitFor(() => expect(screen.getByText(/It is now TWD \(declared\)/)).toBeInTheDocument());
    expect(screen.getByTestId("app-default-currency")).toHaveAttribute("data-status", "unconfirmed");
  });
});
