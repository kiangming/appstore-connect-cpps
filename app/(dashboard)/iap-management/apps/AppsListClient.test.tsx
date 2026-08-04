// @vitest-environment jsdom
/**
 * Apple apps-list page — asserts the "Download bulk import template"
 * call site renders (Manager UAT: the wizard-only placement was too
 * buried). One of the four guarded call sites of
 * components/ui/shared/DownloadTemplateButton.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { AppsListClient } from "./AppsListClient";

// Partial mock: keep the real consts (the template-spec modules import
// TEMPLATE_SAMPLE_PRODUCT_IDS at load), intercept only the download.
const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xlsx-template")>();
  return { ...actual, downloadXlsxTemplate };
});

describe("AppsListClient (Apple) — template download call site", () => {
  it("renders the labeled Download bulk import template button in the header", () => {
    render(<AppsListClient apps={[]} />);
    expect(
      screen.getByRole("button", { name: /download bulk import template/i }),
    ).toBeInTheDocument();
  });

  it("is wired to the APPLE spec (getSpec is a factory prop — a cross-wired spec would pass render tests)", async () => {
    render(<AppsListClient apps={[]} />);
    fireEvent.click(
      screen.getByRole("button", { name: /download bulk import template/i }),
    );
    await waitFor(() => expect(downloadXlsxTemplate).toHaveBeenCalled());
    const spec = downloadXlsxTemplate.mock.calls[0][0];
    expect(spec.filename).toBe("apple-iap-bulk-import-template.xlsx");
    expect(spec.headers.length).toBe(84); // 6 lead + 39 locale pairs
  });
});
