// @vitest-environment jsdom
/**
 * DownloadTemplateButton — the single shared call-site component for the
 * bulk-import template download (apps-list headers + wizard headers,
 * both modules). Generation itself is covered by the parsers'
 * template-spec tests; here we cover the trigger contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DownloadTemplateButton } from "./DownloadTemplateButton";
import type { XlsxTemplateSpec } from "@/lib/xlsx-template";

const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", () => ({ downloadXlsxTemplate }));

const FAKE_SPEC: XlsxTemplateSpec = {
  dataSheetName: "IAP Items",
  headers: ["Product ID"],
  dataRows: [],
  notesSheetName: "Notes",
  notesRows: [["note"]],
  filename: "fake-template.xlsx",
};

beforeEach(() => {
  downloadXlsxTemplate.mockReset();
});

describe("DownloadTemplateButton", () => {
  it("renders the explicit default label and triggers generation with the module spec on click", async () => {
    downloadXlsxTemplate.mockResolvedValueOnce(undefined);
    const getSpec = vi.fn(() => FAKE_SPEC);
    render(<DownloadTemplateButton getSpec={getSpec} />);

    const button = screen.getByRole("button", { name: /download template/i });
    await userEvent.click(button);

    expect(getSpec).toHaveBeenCalledTimes(1);
    expect(downloadXlsxTemplate).toHaveBeenCalledWith(FAKE_SPEC);
  });

  it("renders a custom label (apps-list discoverability wording)", () => {
    render(
      <DownloadTemplateButton
        getSpec={() => FAKE_SPEC}
        label="Download bulk import template"
      />,
    );
    expect(
      screen.getByRole("button", { name: /download bulk import template/i }),
    ).toBeInTheDocument();
  });

  it("surfaces a failure via onError when provided", async () => {
    downloadXlsxTemplate.mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    render(
      <DownloadTemplateButton getSpec={() => FAKE_SPEC} onError={onError} />,
    );

    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("boom"));
  });

  it("falls back to an inline error message without onError", async () => {
    downloadXlsxTemplate.mockRejectedValueOnce(new Error("disk full"));
    render(<DownloadTemplateButton getSpec={() => FAKE_SPEC} />);

    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });
});
