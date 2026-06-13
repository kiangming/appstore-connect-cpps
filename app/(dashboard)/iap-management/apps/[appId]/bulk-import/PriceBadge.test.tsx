// @vitest-environment jsdom

/**
 * Problem 2 — PriceBadge rendering for partial-template-fail.
 *
 * The bug: partial-template-fail fell through to the red "Price failed"
 * catch-all, wrongly implying total rejection when the price schedule POST
 * actually succeeded (base + matched territories applied; only unmatched
 * territories fell back to Apple auto-equalization). These tests pin:
 *  - partial-template-fail → AMBER "Partial: N unmatched" + lists territories,
 *  - genuine POST failures (failed-set/lookup/exception) → RED "Price failed",
 *  - the success/skip cases are unchanged.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PriceBadge } from "./BulkImportWizard";

type Result = Parameters<typeof PriceBadge>[0]["result"];

function row(overrides: Partial<Result> = {}): Result {
  return {
    product_id: "com.x.y",
    status: "SUCCESS",
    disposition: "OVERWRITE",
    ...overrides,
  } as Result;
}

describe("PriceBadge — Problem 2 partial-template-fail", () => {
  it("renders AMBER 'Partial: N unmatched' and lists the unmatched territories", () => {
    render(
      <PriceBadge
        result={row({
          pricing_outcome: "partial-template-fail",
          pricing_missing: [
            { territory_code: "MYS", customer_price: 12 },
            { territory_code: "SGP", customer_price: 33 },
          ],
        })}
      />,
    );
    const badge = screen.getByText(/Partial: 2 unmatched/);
    expect(badge).toBeTruthy();
    // amber, not red
    expect(badge.className).toMatch(/amber/);
    expect(badge.className).not.toMatch(/red/);
    // tooltip lists the exact territories + prices (Problem 3 visibility)
    expect(badge.getAttribute("title")).toContain("MYS @ 12");
    expect(badge.getAttribute("title")).toContain("SGP @ 33");
  });

  it("renders RED 'Price failed' for a genuine POST failure (failed-set)", () => {
    render(
      <PriceBadge
        result={row({ pricing_outcome: "failed-set", pricing_error: "Apple 409" })}
      />,
    );
    const badge = screen.getByText("Price failed");
    expect(badge.className).toMatch(/red/);
    expect(badge.getAttribute("title")).toContain("Apple 409");
  });

  it("renders RED 'Price failed' for failed-lookup and failed-exception too", () => {
    for (const kind of ["failed-lookup", "failed-exception"] as const) {
      const { unmount } = render(
        <PriceBadge result={row({ pricing_outcome: kind })} />,
      );
      expect(screen.getByText("Price failed").className).toMatch(/red/);
      unmount();
    }
  });

  it("renders GREEN 'Price set' for a full success (unchanged)", () => {
    render(<PriceBadge result={row({ pricing_outcome: "set" })} />);
    expect(screen.getByText("Price set").className).toMatch(/emerald/);
  });

  it("renders 'Unchanged' when no pricing outcome (overwrite tier match, unchanged)", () => {
    render(<PriceBadge result={row({ pricing_outcome: undefined })} />);
    expect(screen.getByText("Unchanged")).toBeTruthy();
  });
});
