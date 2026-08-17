// @vitest-environment jsdom
/**
 * The results view — three states on screen, and the remainder warning.
 *
 * ⚠ Two of these are the SC6 part-2 mutation targets:
 *   • the three states must render as three sections (merging NOT_ATTEMPTED
 *     into failed is invisible in a screenshot and kills the only safely
 *     resumable bucket);
 *   • the remainder-loss warning must be present BEFORE the close control,
 *     not delivered as a toast after the list is already gone (decision 6).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BulkResultsView } from "./BulkResultsView";
import type { BulkRowResult } from "@/lib/iap-management/apple/bulk-availability-view";

const ROWS: BulkRowResult[] = [
  { iapId: "i-1", status: "SUCCESS" },
  { iapId: "i-2", status: "SUCCESS" },
  { iapId: "i-3", status: "FAILED", error: "Apple 409 state guard" },
  { iapId: "i-4", status: "FAILED", error: "territory NOT_AVAILABLE" },
  { iapId: "i-5", status: "NOT_ATTEMPTED" },
  { iapId: "i-6", status: "NOT_ATTEMPTED" },
];

function renderView(
  over: Partial<React.ComponentProps<typeof BulkResultsView>> = {},
) {
  const onRetryNotAttempted = vi.fn();
  const onCloseConfirmed = vi.fn();
  render(
    <BulkResultsView
      results={ROWS}
      overall="STOPPED_RATE_LIMITED"
      summary="stopped after 4 of 6"
      labelFor={(id) => `Item ${id}`}
      retrying={false}
      onRetryNotAttempted={onRetryNotAttempted}
      onCloseConfirmed={onCloseConfirmed}
      {...over}
    />,
  );
  return { onRetryNotAttempted, onCloseConfirmed };
}

describe("three states render as three separate sections", () => {
  it("⚠ succeeded / failed / NOT_ATTEMPTED each get their own section", () => {
    renderView();

    expect(screen.getByTestId("results-succeeded")).toHaveAttribute(
      "data-count",
      "2",
    );
    expect(screen.getByTestId("results-failed")).toHaveAttribute(
      "data-count",
      "2",
    );
    // If NOT_ATTEMPTED were folded into failed, this section would be absent
    // and the failed count would read 4.
    expect(screen.getByTestId("results-not-attempted")).toHaveAttribute(
      "data-count",
      "2",
    );
  });

  it("names every row in its own bucket", () => {
    renderView();
    expect(screen.getByTestId("result-success-i-1")).toBeInTheDocument();
    expect(screen.getByTestId("result-failed-i-3")).toBeInTheDocument();
    expect(screen.getByTestId("result-not-attempted-i-5")).toBeInTheDocument();
  });

  it("⚠ shows each failure's OWN reason, never one shared summary", () => {
    renderView();
    expect(screen.getByTestId("result-failed-i-3").textContent).toContain(
      "Apple 409 state guard",
    );
    expect(screen.getByTestId("result-failed-i-4").textContent).toContain(
      "territory NOT_AVAILABLE",
    );
  });

  it("omits the failed and not-attempted sections when there are none", () => {
    renderView({
      results: [{ iapId: "i-1", status: "SUCCESS" }],
      overall: "SUCCESS",
    });
    expect(screen.queryByTestId("results-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("results-not-attempted")).not.toBeInTheDocument();
  });
});

describe("a stopped run does not render as a failure (P5)", () => {
  it("⚠ says stopped, not failed, and credits what already succeeded", () => {
    renderView();
    const title = screen.getByTestId("results-title").textContent ?? "";
    expect(title).toContain("Stopped early");
    expect(title).not.toContain("No items were updated");
    // The reassurance matters: most of the batch may already be done.
    expect(screen.getByTestId("results-headline").textContent).toContain(
      "This is not a failure",
    );
  });

  it("a genuine total failure DOES render as a failure", () => {
    renderView({
      results: [{ iapId: "i-1", status: "FAILED", error: "nope" }],
      overall: "FAILURE",
    });
    expect(screen.getByTestId("results-title").textContent).toContain(
      "No items were updated",
    );
  });

  it("the two are visually distinct, not just differently worded", () => {
    const { container: stopped } = render(
      <BulkResultsView
        results={ROWS}
        overall="STOPPED_RATE_LIMITED"
        summary="s"
        labelFor={(id) => id}
        retrying={false}
        onRetryNotAttempted={vi.fn()}
        onCloseConfirmed={vi.fn()}
      />,
    );
    const stoppedClass =
      stopped.querySelector('[data-testid="results-headline"]')?.className ?? "";
    expect(stoppedClass).toContain("amber");
    expect(stoppedClass).not.toContain("red");
  });
});

describe("retry touches NOT_ATTEMPTED only", () => {
  it("⚠ hands back exactly the not-attempted ids", () => {
    const { onRetryNotAttempted } = renderView();
    fireEvent.click(screen.getByTestId("results-retry"));
    expect(onRetryNotAttempted).toHaveBeenCalledWith(["i-5", "i-6"]);
  });

  it("the button says how many it will retry", () => {
    renderView();
    expect(screen.getByTestId("results-retry").textContent).toContain(
      "Retry the 2 not-attempted items",
    );
  });

  it("no retry affordance at all when nothing was left unattempted", () => {
    renderView({
      results: [{ iapId: "i-1", status: "FAILED", error: "x" }],
      overall: "FAILURE",
    });
    expect(screen.queryByTestId("results-retry")).not.toBeInTheDocument();
  });
});

describe("remainder-loss warning (decision 6)", () => {
  it("⚠ warns BEFORE the close control, naming the count", () => {
    renderView();

    const warning = screen.getByTestId("remainder-loss-warning");
    expect(warning.textContent).toContain("2 not-attempted items");
    expect(warning.textContent).toContain("not saved anywhere");

    // ⚠ ORDERING IS THE POINT. The warning must precede the close button in
    // the document, so it is read before the click — not after, when the list
    // it describes is already gone.
    const close = screen.getByTestId("results-close");
    expect(
      warning.compareDocumentPosition(close) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the close control names the consequence too", () => {
    renderView();
    expect(screen.getByTestId("results-close").textContent).toBe(
      "Close and discard the list",
    );
  });

  it("no warning when there is no remainder to lose", () => {
    renderView({
      results: [{ iapId: "i-1", status: "SUCCESS" }],
      overall: "SUCCESS",
    });
    expect(
      screen.queryByTestId("remainder-loss-warning"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("results-close").textContent).toBe("Close");
  });
});
