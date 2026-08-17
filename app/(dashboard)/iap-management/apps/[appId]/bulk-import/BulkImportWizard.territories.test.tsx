// @vitest-environment jsdom
/**
 * SC7 — the wizard's Territories step (4).
 *
 * ⚠ THE END-TO-END CHAIN. There is no practical HTTP test that reaches the
 * execute route's row loop: that route takes multipart FormData and would need
 * the entire Apple create pipeline mocked to get past the parse/resolve stages,
 * and the existing `execute/route.test.ts` deliberately only covers the early
 * exits (401 / 400 / 422 / 502). So the chain is held from both ends around ONE
 * shared function, the same way SC6p2 did it:
 *
 *   wizard  → asserts the posted `config` carries the selection verbatim  (here)
 *   route   → calls `resolveBatchAvailabilitySelection` on that same blob
 *   resolver→ asserted directly in bulk-availability-view.test.ts
 *
 * A break at either end fails a test. This is stated plainly rather than
 * dressed up as an HTTP round-trip it is not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
// Partial mock: keep the real consts, intercept only the download (the module
// is imported at load time for TEMPLATE_SAMPLE_PRODUCT_IDS).
const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xlsx-template")>();
  return { ...actual, downloadXlsxTemplate };
});

import { BulkImportWizard } from "./BulkImportWizard";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";

const EMPTY_TIERS: Record<PricingSourceKind, UsdTierEntry[]> = {
  APPLE: [],
  DEFAULT_TEMPLATE: [],
  APP_TEMPLATE: [],
};

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const parseIapItemsXlsx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/parsers/iap-items", () => ({ parseIapItemsXlsx }));

const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];
const TERRITORIES_URL = "/api/iap-management/territories";
const EXECUTE_FRAGMENT = "/bulk-import/execute";

interface Posted {
  url: string;
  config?: Record<string, unknown>;
}

function installFetch(opts?: { territories?: unknown }) {
  const posted: Posted[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes(TERRITORIES_URL)) {
      return {
        ok: true,
        status: 200,
        json: async () => opts?.territories ?? { territoryIds: CATALOGUE },
      } as Response;
    }
    if (u.includes(EXECUTE_FRAGMENT)) {
      const fd = init?.body as FormData;
      const raw = fd?.get?.("config");
      posted.push({
        url: u,
        config: typeof raw === "string" ? JSON.parse(raw) : undefined,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          batch_id: "b-1",
          counts: { created: 1, overwritten: 0, skipped: 0, errored: 0 },
          results: [],
        }),
      } as Response;
    }
    // hub-tracking start/cancel and anything else.
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { posted };
}

/** Same minimal shape the sibling wizard test uses (IapItemsParseResult). */
function parsedItems(n = 2) {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      row_index: i + 1,
      product_id: `com.vng.test.p${i}`,
      reference_name: `P${i}`,
      type: "CONSUMABLE" as const,
      type_source: "DEFAULT" as const,
      price_usd: 0,
      base_price: 0,
      base_currency: "USD",
      localizations: [],
      warnings: [],
    })),
    skipped_locales: [],
    locale_pair_count: 0,
    warnings: [],
    sample_rows_skipped: [],
  };
}

function renderWizard() {
  const { container } = render(
    <BulkImportWizard
      appId="123"
      appName="App"
      existingProductIds={[]}
      usdTiersBySource={EMPTY_TIERS}
    />,
  );
  return container;
}

async function dropExcel(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(["x"], "items.xlsx")] } });
    await Promise.resolve();
  });
}

/** Excel → Screenshots → Preview → Territories. */
async function goToTerritories(container: HTMLElement) {
  await dropExcel(container);
  for (let i = 0; i < 3; i++) {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  parseIapItemsXlsx.mockResolvedValue(parsedItems());
});
afterEach(() => vi.unstubAllGlobals());

describe("the Territories step", () => {
  it("appears as step 4, before Result", () => {
    installFetch();
    renderWizard();
    // The stepper names it, so the Manager can see the import has one more gate.
    expect(screen.getByText("Territories")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("⚠ defaults to ALL — every territory plus the forward flag", async () => {
    installFetch();
    const c = renderWizard();
    await goToTerritories(c);

    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    const footer = screen.getByTestId("territory-picker-footer").textContent ?? "";
    // bulkSurfaceDefaultSelection, not a hardcoded list and not surface C's
    // current-territories default.
    expect(footer).toContain(`${CATALOGUE.length} of ${CATALOGUE.length} selected`);
    expect(footer).toContain("includes any new market Apple launches later");
  });

  it("states that ONE selection covers every row — no per-item override", async () => {
    installFetch();
    const c = renderWizard();
    await goToTerritories(c);
    await waitFor(() =>
      expect(
        screen.getByText(/One selection is applied to every item/),
      ).toBeInTheDocument(),
    );
  });

  it("fetches the catalogue lazily — nothing on step 1", async () => {
    installFetch();
    renderWizard();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some((call) => String(call[0]).includes(TERRITORIES_URL)),
    ).toBe(false);
  });
});

describe("no real catalogue ⇒ no picker, no import", () => {
  it("⚠ shows the error and blocks Execute when the fetch fails", async () => {
    installFetch({ territories: { territoryIds: [], error: "fetch_failed" } });
    const c = renderWizard();
    await goToTerritories(c);

    await waitFor(() =>
      expect(
        screen.getByTestId("bulk-territories-load-error"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("territory-picker-footer"),
    ).not.toBeInTheDocument();
    // ⚠ Executing here would fall back to a selection nobody chose.
    expect(screen.getByRole("button", { name: /Execute/ })).toBeDisabled();
  });

  it("an EMPTY catalogue is a failure, not '0 of 0'", async () => {
    installFetch({ territories: { territoryIds: [] } });
    const c = renderWizard();
    await goToTerritories(c);
    await waitFor(() =>
      expect(
        screen.getByTestId("bulk-territories-load-error"),
      ).toBeInTheDocument(),
    );
  });
});

describe("the selection reaches the execute request verbatim", () => {
  it("⚠ posts the batch selection in config, ids and flag intact", async () => {
    const { posted } = installFetch();
    const c = renderWizard();
    await goToTerritories(c);
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
      await Promise.resolve();
    });

    await waitFor(() => expect(posted).toHaveLength(1));
    const sel = posted[0].config?.availability_selection as {
      territoryIds: string[];
      availableInNewTerritories: boolean;
    };
    expect(sel.territoryIds).toEqual(CATALOGUE);
    expect(sel.availableInNewTerritories).toBe(true);
  });

  it("⚠ a hand-picked subset posts the flag OFF (KB §4.13)", async () => {
    const { posted } = installFetch();
    const c = renderWizard();
    await goToTerritories(c);
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );

    // Switch to the explicit mode: same ids, flag off — a different body.
    fireEvent.click(
      screen.getByRole("button", { name: "Selected countries or regions" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
      await Promise.resolve();
    });

    await waitFor(() => expect(posted).toHaveLength(1));
    const sel = posted[0].config?.availability_selection as {
      territoryIds: string[];
      availableInNewTerritories: boolean;
    };
    expect(sel.availableInNewTerritories).toBe(false);
    expect([...sel.territoryIds].sort()).toEqual([...CATALOGUE].sort());
  });

  it("un-ticking a territory narrows what is posted, verbatim", async () => {
    const { posted } = installFetch();
    const c = renderWizard();
    await goToTerritories(c);
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Selected countries or regions" }),
    );
    fireEvent.click(
      screen
        .getByTestId("territory-row-KAZ")
        .querySelector("input[type=checkbox]")!,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
      await Promise.resolve();
    });

    await waitFor(() => expect(posted).toHaveLength(1));
    const sel = posted[0].config?.availability_selection as {
      territoryIds: string[];
    };
    expect(sel.territoryIds).not.toContain("KAZ");
    expect(sel.territoryIds).toHaveLength(CATALOGUE.length - 1);
  });
});
