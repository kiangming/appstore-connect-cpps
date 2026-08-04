// @vitest-environment jsdom
/**
 * Google apps-list page — asserts the "Download bulk import template"
 * call site renders (Manager UAT: the wizard-step-2 placement was too
 * buried). One of the four guarded call sites of
 * components/ui/shared/DownloadTemplateButton.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { AppsListClient } from "./AppsListClient";
import type { GoogleConsoleAccountPublic } from "@/lib/google-iap-management/repository/google-accounts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Partial mock: keep the real consts (the template-spec modules import
// TEMPLATE_SAMPLE_PRODUCT_IDS at load), intercept only the download.
const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xlsx-template")>();
  return { ...actual, downloadXlsxTemplate };
});

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

  it("is wired to the GOOGLE spec (getSpec is a factory prop — a cross-wired spec would pass render tests)", async () => {
    render(
      <AppsListClient
        activeAccount={ACCOUNT}
        initialApps={[]}
        initialLastRefreshedAt={new Date().toISOString()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /download bulk import template/i }),
    );
    await waitFor(() => expect(downloadXlsxTemplate).toHaveBeenCalled());
    const spec = downloadXlsxTemplate.mock.calls[0][0];
    expect(spec.filename).toBe("google-iap-bulk-import-template.xlsx");
    expect(spec.headers.length).toBe(168); // 4 lead + 82 locale pairs
  });
});
