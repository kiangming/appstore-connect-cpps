// @vitest-environment jsdom
/**
 * Google apps-list page — asserts the "Download bulk import template"
 * call site renders (Manager UAT: the wizard-step-2 placement was too
 * buried). One of the four guarded call sites of
 * components/ui/shared/DownloadTemplateButton.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppsListClient } from "./AppsListClient";
import type { GoogleConsoleAccountPublic } from "@/lib/google-iap-management/repository/google-accounts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const ACCOUNT = {
  display_name: "Test Console Account",
} as GoogleConsoleAccountPublic;

describe("AppsListClient (Google) — template download call site", () => {
  it("renders the labeled Download bulk import template button in the header", () => {
    render(
      <AppsListClient
        activeAccount={ACCOUNT}
        initialApps={[]}
        // Fresh timestamp → the Hotfix 29 staleness check does NOT fire
        // an auto-refresh fetch on mount, keeping this a pure render test.
        initialLastRefreshedAt={new Date().toISOString()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /download bulk import template/i }),
    ).toBeInTheDocument();
  });
});
