// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ExportOptionsDialog } from "./ExportOptionsDialog";
import { ALL_TERRITORY_CODES } from "@/lib/iap-management/territory-catalog";

describe("ExportOptionsDialog — visibility", () => {
  it("renders nothing when closed", () => {
    render(<ExportOptionsDialog open={false} onCancel={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByText("Export options")).not.toBeInTheDocument();
  });

  it("renders the dialog when open", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    expect(screen.getByText("Export options")).toBeInTheDocument();
  });
});

describe("ExportOptionsDialog — default state (all selected)", () => {
  it("shows every catalog territory selected and the full count", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    expect(
      screen.getByText(`${ALL_TERRITORY_CODES.length} of ${ALL_TERRITORY_CODES.length} selected`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Export ${ALL_TERRITORY_CODES.length} countries` }),
    ).toBeInTheDocument();
  });

  it("clicking Export while untouched calls onExport with null (no filter)", () => {
    const onExport = vi.fn();
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: /Export \d+ countries/ }));
    expect(onExport).toHaveBeenCalledWith(null);
  });
});

describe("ExportOptionsDialog — search", () => {
  it("filters by currency (EUR narrows to eurozone countries)", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search country, code, or currency/), {
      target: { value: "eur" },
    });
    expect(screen.getByText("Germany")).toBeInTheDocument();
    expect(screen.getByText("France")).toBeInTheDocument();
    expect(screen.queryByText("Vietnam")).not.toBeInTheDocument();
  });

  it("filters by country name (partial, case-insensitive)", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search country, code, or currency/), {
      target: { value: "viet" },
    });
    expect(screen.getByText("Vietnam")).toBeInTheDocument();
    expect(screen.queryByText("Germany")).not.toBeInTheDocument();
  });

  it("filters by ISO code", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search country, code, or currency/), {
      target: { value: "vn" },
    });
    expect(screen.getByText("Vietnam")).toBeInTheDocument();
  });

  it("shows an empty-state message when nothing matches", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Search country, code, or currency/), {
      target: { value: "zzzznotacountry" },
    });
    expect(screen.getByText(/No countries match/)).toBeInTheDocument();
  });
});

describe("ExportOptionsDialog — selection", () => {
  it("deselecting a country decrements the count and is excluded from onExport's payload", () => {
    const onExport = vi.fn();
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={onExport} />);
    fireEvent.change(screen.getByPlaceholderText(/Search country, code, or currency/), {
      target: { value: "viet" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(
      screen.getByText(`${ALL_TERRITORY_CODES.length - 1} of ${ALL_TERRITORY_CODES.length} selected`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Export \d+ countries/ }));
    const payload = onExport.mock.calls[0][0] as string[];
    expect(payload).not.toBeNull();
    expect(payload).not.toContain("VN");
    expect(payload.length).toBe(ALL_TERRITORY_CODES.length - 1);
  });

  it("Clear all then Select all round-trips back to the full default set", () => {
    const onExport = vi.fn();
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText(`0 of ${ALL_TERRITORY_CODES.length} selected`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select at least 1 country" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(
      screen.getByText(`${ALL_TERRITORY_CODES.length} of ${ALL_TERRITORY_CODES.length} selected`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Export \d+ countries/ }));
    expect(onExport).toHaveBeenCalledWith(null);
  });

  it("zero selected disables Export with a clear hint", () => {
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const btn = screen.getByRole("button", { name: "Select at least 1 country" });
    expect(btn).toBeDisabled();
  });
});

describe("ExportOptionsDialog — cancel + reopen reset", () => {
  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(<ExportOptionsDialog open onCancel={onCancel} onExport={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("reopening resets a prior partial selection back to all-selected", () => {
    const { rerender } = render(
      <ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText(`0 of ${ALL_TERRITORY_CODES.length} selected`)).toBeInTheDocument();

    rerender(<ExportOptionsDialog open={false} onCancel={vi.fn()} onExport={vi.fn()} />);
    rerender(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    expect(
      screen.getByText(`${ALL_TERRITORY_CODES.length} of ${ALL_TERRITORY_CODES.length} selected`),
    ).toBeInTheDocument();
  });
});
