// @vitest-environment jsdom

/**
 * C2 — a status the UI does not recognise must LOOK unrecognised.
 *
 * The badge used to end with `map[status] ?? map.SKIPPED`, so anything the
 * component had not been taught wore SKIPPED's slate styling. That is not a
 * cosmetic default: on the server, `SKIPPED` (the Manager chose to skip this
 * product at conflict resolution) and `NOT_ATTEMPTED` (nothing was sent —
 * safe to re-run) are deliberately separate statuses, and
 * `conflict-resolution.test.ts` pins the first meaning. Rendering them
 * identically collapses the distinction in the one place a person actually
 * reads it.
 */
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { StatusBadge } from "./BulkImportWizard";

afterEach(cleanup);

function classesFor(status: string): string {
  const { container } = render(<StatusBadge status={status} />);
  return container.querySelector("span")!.className;
}

describe("StatusBadge", () => {
  it("renders the three known statuses with distinct styling", () => {
    const seen = new Set(["SUCCESS", "SKIPPED", "ERROR"].map(classesFor));
    expect(seen.size).toBe(3);
  });

  it("⚠ NOT_ATTEMPTED is styled differently from SKIPPED — the two are not the same skip", () => {
    expect(classesFor("NOT_ATTEMPTED")).not.toBe(classesFor("SKIPPED"));
  });

  it("NOT_ATTEMPTED reads as 'not sent', not as raw enum jargon", () => {
    render(<StatusBadge status="NOT_ATTEMPTED" />);
    expect(screen.getByText("not sent")).toBeTruthy();
  });

  it("⚠ an UNKNOWN status does not borrow SKIPPED's styling — it fails loud", () => {
    // The server shipping ahead of this component is a real deployment fact.
    // It should be visible, not disguised as a normal outcome.
    const unknown = classesFor("SOME_FUTURE_STATUS");
    expect(unknown).not.toBe(classesFor("SKIPPED"));
    expect(unknown).not.toBe(classesFor("SUCCESS"));
    expect(unknown).not.toBe(classesFor("ERROR"));
    expect(unknown).not.toBe(classesFor("NOT_ATTEMPTED"));
  });

  it("an unknown status still renders its own name, so it can be reported", () => {
    render(<StatusBadge status="SOME_FUTURE_STATUS" />);
    expect(screen.getByText("some_future_status")).toBeTruthy();
  });
});
