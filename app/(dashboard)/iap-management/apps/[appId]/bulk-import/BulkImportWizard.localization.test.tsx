// @vitest-environment jsdom
/**
 * `[BULKIMPORT-loc-step]` C3 — the Localization step INSIDE the wizard.
 *
 * ⚠ WHY A WIZARD-LEVEL TEST AND NOT ONLY A COMPONENT ONE. The selection has to
 * survive a hop the component test cannot see: component state → the wizard's
 * `config` blob → the POST body. That intermediate payload is exactly where a
 * threaded field goes missing (the repo has hit this before), and the server
 * re-parses the spreadsheet itself, so the selection is the ONLY thing the
 * client contributes about localizations. If it does not reach `config`, the
 * step is decorative and the 409s come back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const downloadXlsxTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xlsx-template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xlsx-template")>();
  return { ...actual, downloadXlsxTemplate };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const parseIapItemsXlsx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/parsers/iap-items", () => ({ parseIapItemsXlsx }));

import { BulkImportWizard } from "./BulkImportWizard";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";

const EMPTY_TIERS: Record<PricingSourceKind, UsdTierEntry[]> = {
  APPLE: [],
  DEFAULT_TEMPLATE: [],
  APP_TEMPLATE: [],
};

interface Posted {
  url: string;
  config?: Record<string, unknown>;
}

function installFetch() {
  const posted: Posted[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/iap-management/territories")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ territoryIds: ["USA", "VNM"] }),
      } as Response;
    }
    if (u.includes("/bulk-import/execute")) {
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
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { posted };
}

function withLocales() {
  return {
    items: [
      {
        row_index: 1,
        product_id: "com.vng.nikki.pack199ak",
        reference_name: "Item box ingame",
        type: "CONSUMABLE" as const,
        type_source: "DEFAULT" as const,
        price_usd: 0,
        base_price: 0,
        base_currency: "USD",
        localizations: [
          {
            locale: "vi",
            locale_name: "Vietnamese",
            display_name: "188 Vàng.",
            description: "Gói 188 Vàng",
          },
          {
            locale: "en-US",
            locale_name: "English (U.S.)",
            display_name: "188 Gold",
            description: "188 Gold pack",
          },
        ],
        warnings: [],
      },
    ],
    skipped_locales: [],
    locale_pair_count: 2,
    warnings: [],
    sample_rows_skipped: [],
  };
}

function noLocales() {
  const p = withLocales();
  return { ...p, items: [{ ...p.items[0], localizations: [] }], locale_pair_count: 0 };
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
  const file = new File(["x"], "items.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(input, "files", { value: [file] });
  fireEvent.change(input);
  await waitFor(() => expect(parseIapItemsXlsx).toHaveBeenCalled());
}

/** Excel → Screenshots → Preview → Localization. */
async function goToLocalization(container: HTMLElement) {
  await dropExcel(container);
  for (let i = 0; i < 3; i++) {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  }
  await waitFor(() =>
    expect(screen.getByTestId("localization-step")).toBeInTheDocument(),
  );
}

beforeEach(() => {
  parseIapItemsXlsx.mockReset();
  parseIapItemsXlsx.mockResolvedValue(withLocales());
});
afterEach(() => vi.unstubAllGlobals());

describe("the Localization step sits between Preview and Territories", () => {
  it("is reached after Preview, and BOTH the stepper and the panel name it", async () => {
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    // Two on purpose: the stepper label and the panel heading. A single match
    // would mean one of them is missing.
    const named = screen.getAllByText("Localization");
    expect(named).toHaveLength(2);
    expect(named.some((el) => el.tagName === "H2")).toBe(true);
  });

  it("the step 3 label reads 'Preview itemID & Price' (M-2), not 'Preview'", async () => {
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    expect(screen.getByText("Preview itemID & Price")).toBeInTheDocument();
  });
});

describe("the confirm dialog", () => {
  it("Next opens it with the cell counts rather than advancing", async () => {
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByTestId("localization-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("localization-confirm-process").textContent).toBe("2");
    expect(screen.getByTestId("localization-confirm-skip").textContent).toBe("0");
    // Still on the step — the dialog is a gate, not a receipt.
    expect(screen.getByTestId("localization-step")).toBeInTheDocument();
  });

  it("counts reflect an un-ticked cell", async () => {
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    fireEvent.click(screen.getByTestId("localization-cell-com.vng.nikki.pack199ak-vi"));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByTestId("localization-confirm-process").textContent).toBe("1");
    expect(screen.getByTestId("localization-confirm-skip").textContent).toBe("1");
  });

  it("Cancel keeps the Manager on the step", async () => {
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByTestId("localization-confirm-cancel"));
    expect(screen.queryByTestId("localization-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("localization-step")).toBeInTheDocument();
  });

  it("Confirm advances to Territories", async () => {
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByTestId("localization-confirm-ok"));
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
  });

  /** ⚠ Q7.3 — nothing to process ⇒ nothing to confirm. */
  it("does NOT open when the file has no localization content", async () => {
    parseIapItemsXlsx.mockResolvedValue(noLocales());
    installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    expect(screen.getByTestId("localization-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.queryByTestId("localization-confirm")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
  });
});

describe("⭐ the selection reaches the POSTed config — the hop that matters", () => {
  async function runToExecute() {
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    const ok = screen.queryByTestId("localization-confirm-ok");
    if (ok) fireEvent.click(ok);
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    const exec = screen.getByRole("button", { name: /Execute|Import/i });
    fireEvent.click(exec);
  }

  it("default (nothing un-ticked) posts an EMPTY selection — the server reads that as ALL", async () => {
    const { posted } = installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    await runToExecute();
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const sel = posted[0].config?.localization_selection as {
      ignore_all: boolean;
      selected: Record<string, string[]>;
    };
    expect(sel).toBeDefined();
    expect(sel.ignore_all).toBe(false);
    // ⭐ PARITY: no key means "no opinion", which the choke point turns into a
    // no-op. A fully-populated map here would work too, but an empty one proves
    // the default path never had to enumerate anything.
    expect(sel.selected).toEqual({});
  });

  it("an un-ticked cell survives the hop, verbatim", async () => {
    const { posted } = installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    fireEvent.click(screen.getByTestId("localization-cell-com.vng.nikki.pack199ak-vi"));
    await runToExecute();
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const sel = posted[0].config?.localization_selection as {
      selected: Record<string, string[]>;
    };
    expect(sel.selected).toEqual({ "com.vng.nikki.pack199ak": ["en-US"] });
  });

  it("'Ignore all' travels as a flag, not as an emptied list", async () => {
    const { posted } = installFetch();
    const c = renderWizard();
    await goToLocalization(c);
    fireEvent.click(screen.getByTestId("localization-ignore-all"));
    await runToExecute();
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const sel = posted[0].config?.localization_selection as {
      ignore_all: boolean;
    };
    expect(sel.ignore_all).toBe(true);
  });
});
