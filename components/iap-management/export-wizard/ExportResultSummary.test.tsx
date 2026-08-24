// @vitest-environment jsdom
/**
 * The export result panel — three outcomes kept apart, and a stopped run that
 * does not read as a failure.
 *
 * ⚠ The assertions that matter are the ones about what must NOT collapse:
 * partial is a property of exported rows (never a fourth bucket added to the
 * total), a stop is not a failure, and the remainder is pointed AT its real
 * home rather than warned about as lost — which is where export genuinely
 * differs from the availability modal.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ExportResultSummary } from "./ExportResultSummary";

function renderSummary(over: Partial<Parameters<typeof ExportResultSummary>[0]> = {}) {
  render(
    <ExportResultSummary
      exported={4}
      partial={1}
      failed={1}
      notAttempted={3}
      stopped={false}
      selectedCount={null}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

describe("a stopped run is not a failed run", () => {
  it("says so in words, and counts what already landed", () => {
    renderSummary({ stopped: true, exported: 374, partial: 6, failed: 2, notAttempted: 18 });

    expect(screen.getByTestId("export-result-summary")).toHaveAttribute(
      "data-stopped",
      "rate_limit",
    );
    expect(screen.getByTestId("export-result-title")).toHaveTextContent(
      "Export stopped",
    );
    // 374 exported + 2 failed = 376 attempted, of 394 total.
    expect(screen.getByTestId("export-result-title")).toHaveTextContent(
      "after 376 of 394 items",
    );
    expect(screen.getByTestId("export-result-summary")).toHaveTextContent(
      "This is not a failure — 374 items already exported",
    );
  });

  it("a completed run with failures is NOT labelled stopped", () => {
    renderSummary({ stopped: false, failed: 2, notAttempted: 0 });

    expect(screen.getByTestId("export-result-summary")).toHaveAttribute(
      "data-stopped",
      "no",
    );
    expect(screen.getByTestId("export-result-title")).not.toHaveTextContent(
      "stopped",
    );
  });
});

describe("the three outcomes stay apart", () => {
  it("renders exported, failed and not-attempted as separate lines", () => {
    renderSummary();

    expect(screen.getByTestId("result-exported")).toHaveTextContent("4");
    expect(screen.getByTestId("result-failed")).toHaveTextContent(
      "Apple was asked and refused",
    );
    expect(screen.getByTestId("result-not-attempted")).toHaveTextContent(
      "nothing was sent",
    );
    // ⚠ Only NOT_ATTEMPTED is safe to redo blindly; FAILED is not, and the
    // copy must not invite it.
    expect(screen.getByTestId("result-not-attempted")).toHaveTextContent(
      "Safe to export again",
    );
    expect(screen.getByTestId("result-failed")).not.toHaveTextContent(
      "Safe to export again",
    );
  });

  it("partial is a SUBSET of exported, not a fourth bucket", () => {
    renderSummary({ exported: 4, partial: 1, failed: 0, notAttempted: 0 });

    expect(screen.getByTestId("result-exported")).toHaveTextContent("4");
    expect(screen.getByTestId("result-partial")).toHaveTextContent("of those");
    // The headline arithmetic must not have counted it twice: 4 exported + 0
    // failed + 0 not attempted = 4 total.
    renderSummary({
      stopped: true,
      exported: 4,
      partial: 1,
      failed: 0,
      notAttempted: 0,
    });
    expect(screen.getAllByTestId("export-result-title")[1]).toHaveTextContent(
      "after 4 of 4 items",
    );
  });

  it("omits buckets that are empty rather than printing zeroes", () => {
    renderSummary({ exported: 5, partial: 0, failed: 0, notAttempted: 0 });

    expect(screen.queryByTestId("result-failed")).toBeNull();
    expect(screen.queryByTestId("result-not-attempted")).toBeNull();
    expect(screen.queryByTestId("result-partial")).toBeNull();
  });
});

describe("the remainder's home", () => {
  it("points at the failure sheet — closing this does not lose it", () => {
    renderSummary({ failed: 1, notAttempted: 3, partial: 1 });

    const pointer = screen.getByTestId("failure-sheet-pointer");
    expect(pointer).toHaveTextContent("Export Failures");
    expect(pointer).toHaveTextContent("5 rows");
    // ⚠ Export's advantage over the availability modal: no "closing loses
    // this" warning, because it does not.
    expect(pointer).toHaveTextContent("closing this does not lose them");
  });

  it("has no retry affordance — the ids are not on the wire", () => {
    // ⚠ PART 3's mockup shows "Export the N not-attempted". It needs their
    // IDS; the response carries a COUNT. Re-sending the whole selection would
    // re-send the FAILED items too, which SC3 locked against.
    renderSummary({ notAttempted: 18 });

    expect(screen.queryByRole("button", { name: /not.attempted/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.getByTestId("export-result-close")).toBeInTheDocument();
  });

  it("does not point anywhere on a clean run", () => {
    renderSummary({ exported: 5, partial: 0, failed: 0, notAttempted: 0 });

    expect(screen.queryByTestId("failure-sheet-pointer")).toBeNull();
  });
});

describe("the selection denominator", () => {
  it("names how many the operator picked, when they picked", () => {
    renderSummary({ selectedCount: 40 });

    expect(screen.getByTestId("result-of-selected")).toHaveTextContent(
      "You selected 40 items",
    );
  });

  it("says nothing about a denominator on the export-all path", () => {
    renderSummary({ selectedCount: null });

    expect(screen.queryByTestId("result-of-selected")).toBeNull();
  });
});
