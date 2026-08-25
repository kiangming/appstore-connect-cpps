// @vitest-environment jsdom

/**
 * C3 chunk B — a PARTIAL row must SHOW what it achieved.
 *
 * Chunk A made the server honest and shipped a known debt: every badge
 * returned "—" for any row whose status was not SUCCESS, so a row created on
 * Apple, localized and priced rendered a dash because a later stage failed.
 * Under-reporting rather than misreporting — but a Manager reading that row
 * cannot tell it apart from a row where nothing happened, which is the whole
 * decision the badge exists to support.
 *
 * ⚠ THE RULE UNDER TEST IS "ASK THE MAP". Everything here fixes a row whose
 * `status` and whose `stages` point in different directions, and asserts the
 * UI follows the stages. A badge that reads `status` passes the happy cases
 * and fails these.
 *
 * ⚠ Lives in its own file so C2's StatusBadge/OutcomeBadge/PriceBadge pins
 * stay byte-identical — adding an entry must not be able to loosen the net
 * those tests hold.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  StatusBadge,
  OutcomeBadge,
  PriceBadge,
  Step4Result,
} from "./BulkImportWizard";
import type { RowStages } from "@/lib/iap-management/bulk-import/row-outcome";

afterEach(cleanup);

type Row = Parameters<typeof OutcomeBadge>[0]["result"];

const stages = (over: Partial<RowStages> = {}): RowStages => ({
  create: { state: "OK" },
  localizations: { state: "OK", done: 3, total: 3, failed: [], skippedByStop: 0 },
  pricing: { state: "OK", outcome: "set" },
  screenshot: { state: "OK", note: "uploaded-new" },
  availability: { state: "OK" },
  submit: { state: "NOT_APPLICABLE" },
  ...over,
});

function row(over: Partial<Row> = {}): Row {
  return {
    product_id: "com.x.y",
    status: "PARTIAL",
    disposition: "CREATE",
    apple_iap_id: "6775742430",
    stages: stages(),
    ...over,
  } as Row;
}

function classesFor(status: string): string {
  const { container } = render(<StatusBadge status={status} />);
  const cls = container.querySelector("span")!.className;
  cleanup();
  return cls;
}

// ─── B1 ─────────────────────────────────────────────────────────────────────

describe("B1 — StatusBadge learns PARTIAL", () => {
  it("⚠ does NOT borrow SUCCESS's styling — a missing stage is not done", () => {
    expect(classesFor("PARTIAL")).not.toBe(classesFor("SUCCESS"));
  });

  it("⚠ does NOT borrow ERROR's styling — the IAP exists on Apple", () => {
    expect(classesFor("PARTIAL")).not.toBe(classesFor("ERROR"));
  });

  it("is distinct from every other status the badge knows", () => {
    const others = ["SUCCESS", "ERROR", "SKIPPED", "NOT_ATTEMPTED"].map(classesFor);
    expect(others).not.toContain(classesFor("PARTIAL"));
    expect(new Set([...others, classesFor("PARTIAL")]).size).toBe(5);
  });

  it("⚠ stops rendering as the loud unknown — the C2 socket is now filled", () => {
    expect(classesFor("PARTIAL")).not.toBe(classesFor("SOME_FUTURE_STATUS"));
    expect(classesFor("PARTIAL")).not.toMatch(/fuchsia/);
  });

  it("⚠ and the unknown net still catches everything else", () => {
    // Adding an entry must not be a way to loosen C2's fail-loud fallback.
    expect(classesFor("ANOTHER_FUTURE_STATUS")).toMatch(/fuchsia/);
  });

  it("carries amber — the colour this module already uses for 'landed, but not all of it'", () => {
    expect(classesFor("PARTIAL")).toMatch(/amber/);
  });
});

// ─── B2 ─────────────────────────────────────────────────────────────────────

describe("B2 — the badges read the stage map, not the status", () => {
  it("⚠ a PARTIAL row whose price DID set still shows the price", () => {
    // The debt chunk A declared, stated as a test: `stages.pricing` says OK
    // while `status` says PARTIAL. Reading the status renders "—".
    render(<PriceBadge result={row({ status: "PARTIAL" })} />);
    expect(screen.getByText("Price set")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("⚠ a PARTIAL row still shows its outcome badge", () => {
    render(<OutcomeBadge result={row({ status: "PARTIAL", submitted: true })} />);
    expect(screen.getByText("Created + submitted")).toBeTruthy();
  });

  it("the price comes from the MAP even when the flat field disagrees", () => {
    // Belt and braces: if the two ever diverge, the map is authoritative.
    render(
      <PriceBadge
        result={row({
          stages: stages({ pricing: { state: "OK", outcome: "set" } }),
          pricing_outcome: "skipped-no-tier",
        })}
      />,
    );
    expect(screen.getByText("Price set")).toBeTruthy();
  });

  it("⚠ a budget-stopped price says 'not sent', NOT red 'Not ready'", () => {
    // The route reuses the `skipped-not-ready` kind for a stage that never
    // ran. Routed through the kind-based branches that renders red, blaming
    // Apple's poll window — an event that did not happen.
    render(
      <PriceBadge
        result={row({
          stages: stages({
            pricing: { state: "SKIPPED_BY_STOP", outcome: "skipped-not-ready" },
          }),
        })}
      />,
    );
    const badge = screen.getByText("Not sent");
    expect(badge.className).not.toMatch(/red/);
    expect(badge.getAttribute("title")).toMatch(/rate-limit budget/);
    expect(screen.queryByText("Not ready")).toBeNull();
  });

  it("⚠ a stopped CREATE row does not read 'Created only'", () => {
    // "Created only" means nothing further was wanted. "Stopped" means we
    // did not get to finish. Opposite instructions to the Manager.
    render(
      <OutcomeBadge
        result={row({
          submitted: false,
          stages: stages({ availability: { state: "SKIPPED_BY_STOP" } }),
        })}
      />,
    );
    expect(screen.getByText("Created — stopped by rate limit")).toBeTruthy();
    expect(screen.queryByText("Created only")).toBeNull();
  });

  it("ERROR and the skips keep their dash — nothing landed, nothing to say", () => {
    for (const status of ["ERROR", "SKIPPED", "NOT_ATTEMPTED"]) {
      render(<OutcomeBadge result={row({ status, stages: undefined } as Partial<Row>)} />);
      render(<PriceBadge result={row({ status, stages: undefined } as Partial<Row>)} />);
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
      cleanup();
    }
  });
});

// ─── B3 / B4 / B5 ───────────────────────────────────────────────────────────

const RESULT_PROPS = {
  appId: "app1",
  appName: "Demo",
  batchHasNrs: false,
  pricingSource: "APP_TEMPLATE" as const,
};

function result(over: Record<string, unknown> = {}) {
  return {
    batch_id: "b1",
    total: 1,
    succeeded: 0,
    partial: 1,
    failed: 0,
    skipped: 0,
    not_attempted: 0,
    results: [row()],
    ...over,
  };
}

describe("B3 — the row detail renders the stage map", () => {
  it("⚠ shows every stage, and a FAILED stage never reads ok", () => {
    const r = row({
      status: "PARTIAL",
      summary: "Created on Apple · all 3 locales · missing screenshot",
      stages: stages({
        screenshot: { state: "FAILED", note: "failed", error: "invalid PNG" },
      }),
    });
    render(
      <Step4Result
        {...RESULT_PROPS}
        result={result({ results: [r] }) as never}
      />,
    );
    fireEvent.click(screen.getByText("Detail"));
    const pre = document.querySelector("pre")!;
    expect(pre.textContent).toContain("Screenshot");
    expect(pre.textContent).toMatch(/Screenshot\s+failed/);
    expect(pre.textContent).toContain("invalid PNG");
    expect(pre.textContent).toContain("Create");
    expect(pre.textContent).toContain("Availability");
  });

  it("⚠ the locale line carries its denominator", () => {
    const r = row({
      stages: stages({
        localizations: {
          state: "SKIPPED_BY_STOP", done: 12, total: 39, failed: [], skippedByStop: 27,
        },
      }),
      summary: "Created on Apple · 12/39 locales · stopped by rate limit before localizations",
    });
    render(
      <Step4Result {...RESULT_PROPS} result={result({ results: [r] }) as never} />,
    );
    fireEvent.click(screen.getByText("Detail"));
    expect(document.querySelector("pre")!.textContent).toContain("12/39 done");
    expect(document.querySelector("pre")!.textContent).toContain("27 not sent");
  });

  it("a clean SUCCESS row gets no stage disclosure — the map has nothing to say", () => {
    const r = row({ status: "SUCCESS", stages: stages(), summary: undefined });
    render(
      <Step4Result
        {...RESULT_PROPS}
        result={result({ succeeded: 1, partial: 0, results: [r] }) as never}
      />,
    );
    expect(screen.queryByText("Detail")).toBeNull();
  });
});

describe("B4 — the summary sentence is what the Manager reads first", () => {
  it("renders the row's own summary, uncollapsed", () => {
    // ⚠ The map must actually have findings — the cell is gated on the
    // evidence, not on `summary` being set, so a clean row correctly shows
    // its ordinary note instead. (My first draft of this fixture passed a
    // summary with an all-OK map and rightly rendered nothing.)
    const r = row({
      summary: "Created on Apple · 12/39 locales · missing screenshot, pricing",
      stages: stages({
        localizations: {
          state: "SKIPPED_BY_STOP", done: 12, total: 39, failed: [], skippedByStop: 27,
        },
        screenshot: { state: "FAILED", note: "failed", error: "bad" },
        pricing: { state: "FAILED", outcome: "failed-set", error: "nope" },
      }),
    });
    render(
      <Step4Result {...RESULT_PROPS} result={result({ results: [r] }) as never} />,
    );
    expect(
      screen.getByText("Created on Apple · 12/39 locales · missing screenshot, pricing"),
    ).toBeTruthy();
  });
});

describe("B5 — the tally tiles still sum to total", () => {
  const tileValues = () =>
    Array.from(document.querySelectorAll("p.text-lg")).map((n) =>
      Number(n.textContent),
    );

  it("⚠ PARTIAL gets its own tile and the arithmetic closes", () => {
    render(
      <Step4Result
        {...RESULT_PROPS}
        result={
          result({
            total: 10, succeeded: 4, partial: 3, failed: 1, skipped: 2,
            not_attempted: 0, results: [row()],
          }) as never
        }
      />,
    );
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(tileValues().reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("⚠ closes with every status present at once", () => {
    render(
      <Step4Result
        {...RESULT_PROPS}
        result={
          result({
            total: 15, succeeded: 4, partial: 3, failed: 1, skipped: 2,
            not_attempted: 5, results: [row()],
          }) as never
        }
      />,
    );
    expect(tileValues().reduce((a, b) => a + b, 0)).toBe(15);
  });

  it("a clean run keeps the familiar three-up layout", () => {
    render(
      <Step4Result
        {...RESULT_PROPS}
        result={
          result({
            total: 3, succeeded: 3, partial: 0, failed: 0, skipped: 0,
            not_attempted: 0, results: [row({ status: "SUCCESS" })],
          }) as never
        }
      />,
    );
    expect(screen.queryByText("Partial")).toBeNull();
    expect(tileValues().reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("a response predating C3 renders exactly as before", () => {
    const { partial: _drop, ...noPartial } = result({
      total: 3, succeeded: 3, failed: 0, skipped: 0, not_attempted: 0,
      results: [row({ status: "SUCCESS" })],
    }) as Record<string, unknown>;
    render(<Step4Result {...RESULT_PROPS} result={noPartial as never} />);
    expect(screen.queryByText("Partial")).toBeNull();
    expect(tileValues().reduce((a, b) => a + b, 0)).toBe(3);
  });
});
