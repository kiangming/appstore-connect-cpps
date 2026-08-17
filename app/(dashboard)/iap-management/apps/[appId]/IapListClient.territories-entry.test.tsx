// @vitest-environment jsdom
/**
 * D1 — the entry point, tested at the layer 3619 other tests skipped.
 *
 * ⚠ WHY THIS FILE EXISTS. SC6 built the per-territory bulk picker end to end:
 * modal, route schema, orchestrator, ~60 tests. Every one of them started
 * INSIDE the modal (rendering it with `mode="set-territories"` as a prop) or
 * BELOW it (posting to the route, calling the orchestrator). None started from
 * the IAP list, so none noticed that nothing ever set that mode — the feature
 * shipped unreachable and the whole test suite stayed green.
 *
 * This test starts one layer out: it clicks the toolbar button and asserts the
 * modal opens in the right mode. That is the only layer where D1 was visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { IapListClient } from "./IapListClient";
import type { InAppPurchase } from "@/types/iap-management/apple";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/iap-management/territories")) {
        return { ok: true, status: 200, json: async () => ({ territoryIds: CATALOGUE }) } as Response;
      }
      if (u.includes("/availability")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: { territoryIds: ["USA"], territoryCount: 1, availableInNewTerritories: false },
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

function renderList() {
  render(
    <IapListClient
      appId="123"
      appName="App"
      appBundleId="com.x"
      iaps={[iap("a"), iap("b")]}
      drafts={[]}
      appleToInternal={{ "apple-a": "i-a", "apple-b": "i-b" }}
      baseTerritoryByAppleId={{ "apple-a": "USA" }}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("D1 — per-territory selection is reachable from the IAP list", () => {
  it("⚠ the toolbar offers a Choose territories entry point", () => {
    stubFetch();
    renderList();
    // Absent for the entire SC6 arc; every other test bypassed this layer.
    expect(
      screen.getByRole("button", { name: /Choose territories/i }),
    ).toBeInTheDocument();
  });

  it("⚠ clicking it opens the modal in set-territories mode, not remove", async () => {
    stubFetch();
    renderList();

    fireEvent.click(screen.getByRole("button", { name: /Choose territories/i }));

    // The picker is the mode's fingerprint — it renders for no other mode.
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    // ⚠ And the copy must be this mode's own. Before D1 the five header
    // strings were binary ternaries, so the third mode inherited "Remove from
    // Sales" — a destructive label over a territory picker. Scoped to the
    // dialog: the toolbar button carries the same words.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Choose territories")).toBeInTheDocument();
    expect(within(dialog).queryByText("Remove from Sales")).not.toBeInTheDocument();
  });

  it("the two all-or-nothing presets still open their own modes", async () => {
    stubFetch();
    renderList();

    fireEvent.click(
      screen.getByRole("button", { name: /^Set Availabilities$/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("Set Availabilities for items")).toBeInTheDocument(),
    );
    // No picker in the all-or-nothing modes.
    expect(screen.queryByTestId("territory-picker-footer")).not.toBeInTheDocument();
  });
});
