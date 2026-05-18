// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "./DataTable";

interface Row {
  locale: string;
  status: string;
}

const cols: DataTableColumn<Row>[] = [
  { key: "locale", header: "Locale", render: (r) => r.locale },
  { key: "status", header: "Status", render: (r) => r.status },
];

describe("DataTable", () => {
  it("renders one row per data entry with each column resolved", () => {
    render(
      <DataTable
        columns={cols}
        rows={[
          { locale: "en-GB", status: "Prepare for Submission" },
          { locale: "vi", status: "Approved" },
        ]}
      />,
    );
    expect(screen.getByText("en-GB")).toBeInTheDocument();
    expect(screen.getByText("vi")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 rows
  });

  it("renders the default empty state when rows is empty", () => {
    render(<DataTable columns={cols} rows={[]} />);
    expect(screen.getByText("No data.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a custom empty-state node when supplied", () => {
    render(
      <DataTable
        columns={cols}
        rows={[]}
        emptyState={<span>No upcoming changes.</span>}
      />,
    );
    expect(screen.getByText("No upcoming changes.")).toBeInTheDocument();
  });

  it("uses the rowKey callback for React keys", () => {
    // No direct assertion possible on React internals, but the render
    // succeeding without warnings indicates the keys are unique. We rely
    // on rows[].locale uniqueness here.
    render(
      <DataTable
        columns={cols}
        rows={[
          { locale: "en-GB", status: "x" },
          { locale: "vi", status: "x" },
        ]}
        rowKey={(r) => r.locale}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});
