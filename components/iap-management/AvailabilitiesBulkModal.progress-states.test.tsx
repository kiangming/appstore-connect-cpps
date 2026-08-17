// @vitest-environment jsdom
/**
 * D2 — the two legacy bulk modes must not render NOT_ATTEMPTED as "Failed".
 *
 * ⚠ WHY THIS IS REAL AND NOT THEORETICAL. The rate-limit stop latch lives in
 * the SHARED `withConcurrency` callback of `executeBulkAvailability`
 * (bulk-availability.ts:336-341) with NO action gating — the `action ===`
 * branches at :291/:293 only decide how the selection is built. So `set-all`
 * and `remove` can both return `{ ok: false, status: "NOT_ATTEMPTED" }`, and
 * before this fix `ProgressList` drew those as a red "!" labelled "Failed".
 *
 * The consequence was operational, not cosmetic: an operator was told to redo
 * work that had never been sent, and could not tell it apart from work Apple
 * had actively rejected — the two need opposite responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { AvailabilitiesBulkModal, type BulkMode } from "./AvailabilitiesBulkModal";
import type { InAppPurchase } from "@/types/iap-management/apple";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const iap = (n: string, removed: boolean): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_TO_SUBMIT",
    },
    __removed: removed,
  }) as unknown as InAppPurchase;

const IAPS = [iap("a", true), iap("b", true), iap("c", true)];
const MAP = { "apple-a": "i-a", "apple-b": "i-b", "apple-c": "i-c" };

/** A stopped run: one written, one rejected, one never attempted. */
const STOPPED = {
  total: 3,
  succeeded: 1,
  failed: 1,
  overall: "STOPPED_RATE_LIMITED",
  summary: "stopped after 2 of 3",
  remainder: ["i-c"],
  results: [
    { iapId: "i-a", ok: true, status: "SUCCESS", apple_iap_id: "apple-a" },
    {
      iapId: "i-b",
      ok: false,
      status: "FAILED",
      error: "Apple 409 PRICING_LOCK",
      apple_iap_id: "apple-b",
    },
    { iapId: "i-c", ok: false, status: "NOT_ATTEMPTED", apple_iap_id: "apple-c" },
  ],
};

/** `available: true` makes every item currently-Available, which is what the
 *  `remove` mode's eligibility filter requires. */
function stubFetch(opts?: { available?: boolean; outcome?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/availability")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: opts?.available
              ? {
                  territoryIds: ["USA"],
                  territoryCount: 1,
                  availableInNewTerritories: false,
                }
              : null,
          }),
        } as Response;
      }
      if (u.includes("bulk-availability")) {
        return {
          ok: true,
          status: 200,
          json: async () => opts?.outcome ?? STOPPED,
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

async function runToResults(mode: BulkMode) {
  render(
    <AvailabilitiesBulkModal
      open
      mode={mode}
      iaps={IAPS}
      appleToInternal={MAP}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Select all")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByLabelText("Select all"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^OK \(/ }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("set-all renders three distinct row states", () => {
  it("⚠ NOT_ATTEMPTED is NOT rendered as failed", async () => {
    stubFetch();
    await runToResults("set-all");

    await waitFor(() =>
      expect(screen.getByTestId("progress-row-i-c")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("progress-row-i-a")).toHaveAttribute(
      "data-state",
      "success",
    );
    expect(screen.getByTestId("progress-row-i-b")).toHaveAttribute(
      "data-state",
      "failed",
    );
    // ⚠ The whole point: its own state, not "failed".
    expect(screen.getByTestId("progress-row-i-c")).toHaveAttribute(
      "data-state",
      "not-attempted",
    );
  });

  it("⚠ says the unattempted row is safe to re-run, and names no Apple error", async () => {
    stubFetch();
    await runToResults("set-all");

    await waitFor(() =>
      expect(screen.getByTestId("progress-row-i-c")).toBeInTheDocument(),
    );
    const row = screen.getByTestId("progress-row-i-c").textContent ?? "";
    expect(row).toContain("Not attempted");
    expect(row).toContain("safe to re-run");
    expect(row).not.toContain("Failed");

    // The rejected row keeps Apple's own reason, verbatim.
    expect(screen.getByTestId("progress-row-i-b").textContent).toContain(
      "Apple 409 PRICING_LOCK",
    );
  });

  it("explains the stop above the list, and warns the list is not saved", async () => {
    stubFetch();
    await runToResults("set-all");

    await waitFor(() =>
      expect(
        screen.getByTestId("progress-not-attempted-banner"),
      ).toBeInTheDocument(),
    );
    const banner =
      screen.getByTestId("progress-not-attempted-banner").textContent ?? "";
    expect(banner).toContain("never attempted");
    expect(banner).toContain("not a failure");
    expect(banner).toContain("not saved anywhere");
  });

  it("no banner when the run completed with nothing unattempted", async () => {
    stubFetch({
      outcome: { ...STOPPED, overall: "SUCCESS", results: [STOPPED.results[0]] },
    });
    await runToResults("set-all");
    await waitFor(() =>
      expect(screen.getByTestId("progress-row-i-a")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("progress-not-attempted-banner"),
    ).not.toBeInTheDocument();
  });
});

describe("remove mode gets the same treatment", () => {
  it("⚠ NOT_ATTEMPTED is its own state in the destructive mode too", async () => {
    // `remove` only lists currently-Available items, so the stub must report
    // them as available or the modal shows its empty state and nothing renders.
    stubFetch({ available: true });
    render(
      <AvailabilitiesBulkModal
        open
        mode="remove"
        iaps={IAPS}
        appleToInternal={MAP}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Select all")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText("Select all"));
    // Destructive mode routes through its own reconfirm before the write.
    fireEvent.click(screen.getByRole("button", { name: /^Remove \(/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Confirm/ })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId("progress-row-i-c")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("progress-row-i-c")).toHaveAttribute(
      "data-state",
      "not-attempted",
    );
    expect(screen.getByTestId("progress-row-i-b")).toHaveAttribute(
      "data-state",
      "failed",
    );
  });
});
