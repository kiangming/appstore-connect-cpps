// @vitest-environment jsdom

/**
 * IAP.q.2 — OutcomeBadge rendering for the bulk-import create→submit fix.
 *
 * The bug: "Submit to Apple review after create" created the IAP successfully
 * but the immediate submit 409'd (missing appStoreReviewScreenshot
 * relationship + not-yet-READY_TO_SUBMIT state) and the whole row collapsed
 * to a bare red ERROR badge, hiding the apple_iap_id. The fix adds a
 * `submit_outcome` field so a state-guard deferral (or a genuine post-guard
 * submit failure) renders as a distinct AMBER/ORANGE "Created — ..." badge —
 * never red ERROR — and the create result (incl. apple_iap_id) is preserved.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OutcomeBadge } from "./BulkImportWizard";

type Result = Parameters<typeof OutcomeBadge>[0]["result"];

function row(overrides: Partial<Result> = {}): Result {
  return {
    product_id: "com.x.y",
    status: "SUCCESS",
    disposition: "CREATE",
    apple_iap_id: "6775742430",
    ...overrides,
  } as Result;
}

describe("OutcomeBadge — IAP.q.2 submit_outcome", () => {
  it("renders GREEN 'Created + submitted' when submit actually succeeded (unchanged)", () => {
    render(
      <OutcomeBadge
        result={row({ submitted: true, submit_outcome: "submitted" })}
      />,
    );
    const badge = screen.getByText("Created + submitted");
    expect(badge.className).toMatch(/emerald/);
  });

  it("renders AMBER 'Created — submit deferred' (not red) when the state guard blocks submission", () => {
    render(
      <OutcomeBadge
        result={row({
          submitted: false,
          submit_outcome: "deferred",
          submit_deferred_state: "MISSING_METADATA",
        })}
      />,
    );
    const badge = screen.getByText("Created — submit deferred");
    expect(badge.className).toMatch(/amber/);
    expect(badge.className).not.toMatch(/red/);
    expect(badge.getAttribute("title")).toContain("MISSING_METADATA");
  });

  it("renders ORANGE 'Created — submit failed' (not red ERROR) for a genuine post-guard submit failure", () => {
    render(
      <OutcomeBadge
        result={row({
          submitted: false,
          submit_outcome: "failed",
          submit_error: "409: some Apple error",
        })}
      />,
    );
    const badge = screen.getByText("Created — submit failed");
    expect(badge.className).not.toMatch(/\bred\b/);
    expect(badge.getAttribute("title")).toContain("409");
  });

  it("renders 'Created only' when submit was never attempted (unchanged)", () => {
    render(<OutcomeBadge result={row({ submitted: false })} />);
    expect(screen.getByText("Created only")).toBeTruthy();
  });

  it("still shows an em-dash for non-SUCCESS rows (unchanged)", () => {
    render(<OutcomeBadge result={row({ status: "ERROR" })} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
