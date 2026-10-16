// @vitest-environment jsdom

/**
 * D9 [arc-google-missing-purchase-options] — the single Create/Edit form's
 * currency/language banner. Not a gate (C3: the single form is not blocked);
 * it must only stop stating the two things C2 made false:
 *   • "Google enforces these per app" — Google v3 has no app-wide currency;
 *   • "Click Refresh from Google to capture them" — refresh no longer writes
 *     them, so for a new app that instruction is a dead end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { IapForm } from "./IapForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const APP_PAGE = "/google-iap-management/apps/com.vnggames.ballisticherotwid#app-defaults";

describe("IapForm — app currency/language banner (D9)", () => {
  it("values present ⇒ labelled pre-fill only, links to the app page, no 'Google enforces' claim", () => {
    render(
      <IapForm
        packageName="com.vnggames.ballisticherotwid"
        appId="app-1"
        appDefaults={{ currency: "USD", language: "en-US" }}
        mode={{ kind: "create" }}
      />,
    );
    const banner = screen.getByTestId("iap-form-app-defaults");
    expect(banner).toHaveTextContent(/pre-fill only/);
    expect(banner).not.toHaveTextContent(/Google enforces/);
    expect(screen.getByRole("link", { name: /Check them on the app page/ })).toHaveAttribute(
      "href",
      APP_PAGE,
    );
  });

  it("no values (new app) ⇒ points to DECLARING them on the app page — never to Refresh", () => {
    render(
      <IapForm
        packageName="com.vnggames.ballisticherotwid"
        appId="app-1"
        appDefaults={{ currency: null, language: null }}
        mode={{ kind: "create" }}
      />,
    );
    const banner = screen.getByTestId("iap-form-app-defaults");
    expect(banner).toHaveTextContent(/not declared/);
    expect(banner).not.toHaveTextContent(/Refresh/);
    expect(screen.getByRole("link", { name: /Declare them on the app page/ })).toHaveAttribute(
      "href",
      APP_PAGE,
    );
  });
});
