// @vitest-environment jsdom
/**
 * The modal in set-territories mode — the wiring, not the logic.
 *
 * Covers what only a rendered modal can prove: that the catalogue is fetched
 * from the shared route, that the default arrives via
 * `bulkSurfaceDefaultSelection` rather than a hardcoded ALL, that a failed
 * catalogue fetch yields NO picker, and that Cancel sends zero write requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { AvailabilitiesBulkModal } from "./AvailabilitiesBulkModal";
import type { InAppPurchase } from "@/types/iap-management/apple";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

const iap = (n: string): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_TO_SUBMIT",
    },
  }) as unknown as InAppPurchase;

const IAPS = [iap("a"), iap("b")];
const MAP = { "apple-a": "i-a", "apple-b": "i-b" };

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** Records every request so "Cancel sends nothing" is provable. */
function stubFetch(opts?: {
  territories?: { territoryIds: string[]; error?: string };
  availability?: unknown;
}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined,
    });
    if (url.includes("/api/iap-management/territories")) {
      return {
        ok: true,
        status: 200,
        json: async () => opts?.territories ?? { territoryIds: CATALOGUE },
      } as Response;
    }
    if (url.includes("/availability")) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          opts?.availability ?? {
            state: {
              territoryIds: ["USA"],
              territoryCount: 1,
              availableInNewTerritories: false,
            },
          },
      } as Response;
    }
    if (url.includes("hub-tracking")) {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    if (url.includes("bulk-availability")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: 1,
          succeeded: 1,
          failed: 0,
          overall: "SUCCESS",
          summary: "1 updated",
          results: [{ iapId: "i-a", ok: true, status: "SUCCESS" }],
          remainder: [],
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

function renderModal() {
  render(
    <AvailabilitiesBulkModal
      open
      mode="set-territories"
      iaps={IAPS}
      appleToInternal={MAP}
      baseTerritoryByAppleId={{ "apple-a": "USA" }}
      onClose={vi.fn()}
    />,
  );
}

const writeCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.includes("bulk-availability"));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("catalogue comes from the shared route", () => {
  it("fetches /api/iap-management/territories on open", async () => {
    const { calls } = stubFetch();
    renderModal();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes("/api/iap-management/territories")),
      ).toBe(true),
    );
  });

  it("⚠ defaults to ALL — every territory ticked, forward flag on", async () => {
    stubFetch();
    renderModal();

    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    // bulkSurfaceDefaultSelection ⇒ all N + the flag, which the footer states
    // in words. A hardcoded id list, or surface C's current-territories
    // default, would both fail here.
    const footer = screen.getByTestId("territory-picker-footer").textContent ?? "";
    expect(footer).toContain(`${CATALOGUE.length} of ${CATALOGUE.length} selected`);
    expect(footer).toContain("includes any new market Apple launches later");
  });
});

describe("no real catalogue ⇒ no picker", () => {
  it("⚠ renders the load error and NO picker when the fetch reports failure", async () => {
    stubFetch({ territories: { territoryIds: [], error: "fetch_failed" } });
    renderModal();

    await waitFor(() =>
      expect(screen.getByTestId("territories-load-error")).toBeInTheDocument(),
    );
    // Building a selection on an invented baseline is the thing SC5 refused.
    expect(
      screen.queryByTestId("territory-picker-footer"),
    ).not.toBeInTheDocument();
  });

  it("an EMPTY catalogue is treated as a failure, not as '0 of 0'", async () => {
    stubFetch({ territories: { territoryIds: [] } });
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId("territories-load-error")).toBeInTheDocument(),
    );
  });
});

describe("the confirm gate stands between the click and the write", () => {
  it("⚠ Cancel sends ZERO write requests", async () => {
    const { calls } = stubFetch();
    renderModal();

    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    // Select an item, then open the confirm.
    fireEvent.click(screen.getByLabelText("Select com.x.a"));
    fireEvent.click(screen.getByRole("button", { name: /^OK \(/ }));

    await waitFor(() =>
      expect(screen.getByTestId("confirm-headline")).toBeInTheDocument(),
    );
    expect(writeCalls(calls)).toHaveLength(0);

    // Scoped to the confirm dialog: the modal footer has its own Cancel, and
    // clicking the wrong one would prove nothing about this gate.
    const dialog = screen.getByRole("dialog", {
      name: "Confirm availability replacement",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByTestId("confirm-headline")).not.toBeInTheDocument(),
    );
    // Still nothing sent, and the modal is back on the selection screen.
    expect(writeCalls(calls)).toHaveLength(0);
  });

  it("confirming sends exactly one write, carrying the selection", async () => {
    const { calls } = stubFetch();
    renderModal();

    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText("Select com.x.a"));
    fireEvent.click(screen.getByRole("button", { name: /^OK \(/ }));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-submit")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("confirm-submit"));

    await waitFor(() => expect(writeCalls(calls)).toHaveLength(1));
    const body = writeCalls(calls)[0].body as {
      action: string;
      selection: { territoryIds: string[]; availableInNewTerritories: boolean };
    };
    expect(body.action).toBe("set-territories");
    // ⚠ The selection must be on the wire. Its absence is the layer gap.
    expect(body.selection.territoryIds).toEqual(CATALOGUE);
    expect(body.selection.availableInNewTerritories).toBe(true);
  });
});
