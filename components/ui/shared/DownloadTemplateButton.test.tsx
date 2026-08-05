// @vitest-environment jsdom
/**
 * DownloadTemplateButton — the single shared call-site component for the
 * bulk-import template download + its locale picker. Generation itself is
 * covered by the parsers' template-spec tests; here we cover the modal
 * contract: nothing pre-ticked, zero-locale as a first-class confirm,
 * filtered select-all, no selection memory between opens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DownloadTemplateButton } from "./DownloadTemplateButton";
import type { LocaleOption, XlsxTemplateSpec } from "@/lib/xlsx-template";

const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", () => ({ downloadXlsxTemplate }));

const OPTIONS: LocaleOption[] = [
  { name: "English (U.S.)", language: "English", country: "U.S.", code: "en-US" },
  { name: "English (U.K.)", language: "English", country: "U.K.", code: "en-GB" },
  { name: "Vietnamese", language: "Vietnamese", country: "—", code: "vi" },
  { name: "Japanese", language: "Japanese", country: "Japan", code: "ja-JP" },
];

const FAKE_SPEC: XlsxTemplateSpec = {
  dataSheetName: "IAP Items",
  headers: ["Product ID"],
  dataRows: [],
  notesSheetName: "Notes",
  notesRows: [["note"]],
  filename: "fake-template.xlsx",
};

function renderButton(extra: Record<string, unknown> = {}) {
  const getSpec = vi.fn((_selected: readonly string[]) => FAKE_SPEC);
  render(
    <DownloadTemplateButton
      localeOptions={OPTIONS}
      getSpec={getSpec}
      {...extra}
    />,
  );
  return getSpec;
}

const openModal = () =>
  userEvent.click(screen.getByRole("button", { name: /download template/i }));
const confirm = () =>
  userEvent.click(
    screen.getByRole("button", { name: /^Download template \(/i }),
  );

beforeEach(() => {
  downloadXlsxTemplate.mockReset();
  downloadXlsxTemplate.mockResolvedValue(undefined);
});

describe("DownloadTemplateButton — opening the picker", () => {
  it("clicking the trigger opens the modal and does NOT download yet", async () => {
    renderButton();
    await openModal();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(downloadXlsxTemplate).not.toHaveBeenCalled();
  });

  it("opens with NOTHING pre-ticked and the zero-state banner visible", async () => {
    renderButton();
    await openModal();
    for (const cb of screen.getAllByRole("checkbox")) {
      expect(cb).not.toBeChecked();
    }
    expect(screen.getByText(/Selected/)).toHaveTextContent("Selected 0 of 4");
    expect(
      screen.getByText(/only the core columns/i),
    ).toBeInTheDocument();
  });

  it("renders language, country and code per row; region-less shows the dash", async () => {
    renderButton();
    await openModal();
    expect(screen.getByText("Vietnamese")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("vi")).toBeInTheDocument();
    expect(screen.getByText("Japan")).toBeInTheDocument();
  });

  it("shows a module-specific zero-locale caution when provided (Google)", async () => {
    renderButton({ zeroLocaleCaution: "OVERWRITE replaces listings." });
    await openModal();
    expect(
      screen.getByText(/OVERWRITE replaces listings\./),
    ).toBeInTheDocument();
  });
});

describe("DownloadTemplateButton — selection → generation", () => {
  it("ZERO locales (the default path) confirms with an EMPTY selection", async () => {
    const getSpec = renderButton();
    await openModal();
    await confirm();
    await waitFor(() => expect(downloadXlsxTemplate).toHaveBeenCalled());
    expect(getSpec).toHaveBeenCalledWith([]);
    expect(downloadXlsxTemplate).toHaveBeenCalledWith(FAKE_SPEC);
  });

  it("passes exactly the ticked locale NAMES to the spec factory", async () => {
    const getSpec = renderButton();
    await openModal();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Vietnamese \(vi\)/i }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Japanese \(ja-JP\)/i }),
    );
    await confirm();
    await waitFor(() => expect(downloadXlsxTemplate).toHaveBeenCalled());
    expect(getSpec.mock.calls[0][0]).toEqual(["Vietnamese", "Japanese"]);
  });

  it("search narrows the list and 'Select all shown' applies to the FILTER only", async () => {
    const getSpec = renderButton();
    await openModal();
    await userEvent.type(
      screen.getByPlaceholderText(/search language/i),
      "English",
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("button", { name: /select all shown/i }),
    );
    await confirm();
    expect(getSpec.mock.calls[0][0]).toEqual([
      "English (U.S.)",
      "English (U.K.)",
    ]);
  });

  it("search matches the code and the country, not just the language", async () => {
    renderButton();
    await openModal();
    const box = screen.getByPlaceholderText(/search language/i);
    await userEvent.type(box, "ja-JP");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    await userEvent.clear(box);
    await userEvent.type(box, "Japan");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("Clear all empties the selection", async () => {
    const getSpec = renderButton();
    await openModal();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Vietnamese \(vi\)/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /clear all/i }));
    await confirm();
    expect(getSpec.mock.calls[0][0]).toEqual([]);
  });

  it("does NOT remember the previous selection on re-open (Manager lock)", async () => {
    const getSpec = renderButton();
    await openModal();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Vietnamese \(vi\)/i }),
    );
    await confirm();
    await waitFor(() => expect(downloadXlsxTemplate).toHaveBeenCalledTimes(1));

    await openModal();
    for (const cb of screen.getAllByRole("checkbox")) {
      expect(cb).not.toBeChecked();
    }
    await confirm();
    expect(getSpec.mock.calls[1][0]).toEqual([]);
  });

  it("Cancel closes without downloading", async () => {
    renderButton();
    await openModal();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(downloadXlsxTemplate).not.toHaveBeenCalled();
  });
});

describe("DownloadTemplateButton — errors", () => {
  it("surfaces a failure via onError when provided", async () => {
    downloadXlsxTemplate.mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    renderButton({ onError });
    await openModal();
    await confirm();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("boom"));
  });

  it("falls back to an inline error message without onError", async () => {
    downloadXlsxTemplate.mockRejectedValueOnce(new Error("disk full"));
    renderButton();
    await openModal();
    await confirm();
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });
});
