// @vitest-environment jsdom
/**
 * Custom-prices dialog — the behaviours that are cheap to break and expensive
 * to lose.
 *
 * ⚠ The first test is the whole performance premise (gate G3): the ~175-row
 * table renders with ZERO price-point requests. If that regresses, opening the
 * dialog becomes ~105,000 objects and ~175 Apple calls against a ~3,600/hr
 * budget — a change that would still "work" in dev and would be caught by
 * nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CustomPricesDialog } from "./CustomPricesDialog";
import type { CustomPriceBaseline } from "@/lib/iap-management/custom-prices/model";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const BASELINE: CustomPriceBaseline = {
  tier_id: "TIER_10",
  pricing_source: "APP_TEMPLATE",
  base_territory: "USA",
};

const BASELINE_RESPONSE = {
  base_territory: "USA",
  base_price: 9.99,
  territories: [
    { code: "USA", name: "United States", currency: "USD" },
    { code: "VNM", name: "Vietnam", currency: "VND" },
    { code: "BRA", name: "Brazil", currency: "BRL" },
    { code: "KAZ", name: "Kazakhstan", currency: "KZT" },
  ],
  template_entries: [
    { territory_code: "VNM", customer_price: 24000, currency_code: "VND" },
  ],
  existing_manual: [{ territory: "BRA", customerPrice: 29.9, currency: "BRL" }],
  custom_prices: [],
  donor_available: true,
  warnings: [] as string[],
};

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

function mockFetch(opts?: {
  baseline?: Partial<typeof BASELINE_RESPONSE>;
  pricePoints?: number[];
  pricePointStatus?: number;
  pricePointBody?: unknown;
}) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (url.includes("/custom-prices/baseline")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...BASELINE_RESPONSE, ...(opts?.baseline ?? {}) }),
      } as Response;
    }
    if (url.includes("/price-points")) {
      const status = opts?.pricePointStatus ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () =>
          opts?.pricePointBody ?? {
            territory: "VNM",
            prices: opts?.pricePoints ?? [19000, 22000, 25000, 29000],
          },
      } as Response;
    }
    if (url.includes("/custom-prices")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: "replace", entries: [] }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

const priceePointCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/price-points"));

function renderDialog(props?: Partial<Parameters<typeof CustomPricesDialog>[0]>) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <CustomPricesDialog
      open
      onClose={onClose}
      appAppleId="123"
      iapId="iap-1"
      currentBaseline={BASELINE}
      storedBaseline={BASELINE}
      initialEntries={[]}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onSaved, onClose };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ─── G3: the whole performance premise ───────────────────────────────────────

describe("G3 — the table renders with ZERO price-point requests", () => {
  it("⚠ fetches the baseline once and NO price points", async () => {
    const { calls } = mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());

    expect(
      calls.filter((c) => c.url.includes("/custom-prices/baseline")),
    ).toHaveLength(1);
    expect(
      priceePointCalls(calls),
      "Rendering the table must not touch Apple's price-point catalog. Eager " +
        "fetching all ~175 territories is ~105,000 objects and ~175 Apple calls " +
        "against a ~3,600/hr budget, for a table the Manager edits ~5 rows of.",
    ).toEqual([]);
  });

  it("fetches points only when a picker opens, and only for that territory", async () => {
    const { calls } = mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());

    fireEvent.focus(screen.getByLabelText("Custom price for Vietnam"));
    await waitFor(() => expect(priceePointCalls(calls)).toHaveLength(1));
    expect(priceePointCalls(calls)[0].url).toContain("territory=VNM");
    expect(priceePointCalls(calls)[0].url).not.toContain("BRA");
  });

  it("caches per territory for the dialog's lifetime (no repeat fetch, no server cache)", async () => {
    const { calls } = mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    const picker = screen.getByLabelText("Custom price for Vietnam");
    fireEvent.focus(picker);
    await waitFor(() => expect(priceePointCalls(calls)).toHaveLength(1));
    fireEvent.focus(picker);
    fireEvent.focus(picker);
    await new Promise((r) => setTimeout(r, 10));
    expect(priceePointCalls(calls)).toHaveLength(1);
  });
});

// ─── Provenance + the auto row ───────────────────────────────────────────────

describe("provenance rendering", () => {
  it("labels a template row as unverified and shows the base row read-only", async () => {
    mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    expect(screen.getByText("template · unverified")).toBeInTheDocument();
    expect(
      screen.getByText(/This is the base price/),
    ).toBeInTheDocument();
    // §E — the base row has no picker at all.
    expect(
      screen.queryByLabelText("Custom price for United States"),
    ).not.toBeInTheDocument();
  });

  it("renders an auto territory as '— auto —' and never a number", async () => {
    mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Kazakhstan")).toBeInTheDocument());
    const row = screen.getByTestId("custom-price-row-KAZ");
    expect(row.textContent).toContain("— auto —");
    expect(row.textContent).toContain("Apple equalises");
  });
});

// ─── J-6 ─────────────────────────────────────────────────────────────────────

describe("J-6 — existing Apple prices are shown as at risk, and importable", () => {
  it("states the replace-all consequence on the 'on Apple now' row", async () => {
    mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Brazil")).toBeInTheDocument());
    const row = screen.getByTestId("custom-price-row-BRA");
    expect(row.textContent).toContain("on Apple now");
    expect(row.textContent).toMatch(/revert to auto/i);
    expect(row.textContent).toMatch(/next push/i);
  });

  it("offers bulk import with a count, and per-row import", async () => {
    mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Brazil")).toBeInTheDocument());
    const banner = screen.getByTestId("custom-prices-import-banner");
    expect(banner.textContent).toContain("1 territory has a price set on Apple");
    expect(
      screen.getByRole("button", { name: /Import all as custom prices/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Import as custom price/ }),
    ).toBeInTheDocument();
  });

  it("bulk import turns Apple's current value into a custom, verbatim", async () => {
    const { calls } = mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Brazil")).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole("button", { name: /Import all as custom prices/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("custom-prices-changed-count").textContent).toContain(
        "1 customised",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Save custom prices/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeDefined();
      expect((put!.body as { custom_prices: unknown[] }).custom_prices).toEqual([
        { territory_code: "BRA", customer_price: 29.9, currency_code: "BRL" },
      ]);
    });
  });

  it("an import is recorded with source=imported-from-apple (a payload fact, not a new action type)", async () => {
    const { calls } = mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Brazil")).toBeInTheDocument());
    fireEvent.click(
      screen.getByRole("button", { name: /Import all as custom prices/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save custom prices/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT")!;
      expect((put.body as { source: string }).source).toBe("imported-from-apple");
    });
  });

  it("no import banner when nothing is at risk", async () => {
    mockFetch({ baseline: { existing_manual: [] } });
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    expect(
      screen.queryByTestId("custom-prices-import-banner"),
    ).not.toBeInTheDocument();
  });
});

// ─── J-1 ─────────────────────────────────────────────────────────────────────

describe("J-1 — no donor synced IAP", () => {
  it("shows the reason and renders no picker; there is no CSV fallback", async () => {
    const { calls } = mockFetch({ baseline: { donor_available: false } });
    renderDialog();
    await waitFor(() =>
      expect(screen.getByTestId("custom-prices-no-donor")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("custom-prices-no-donor").textContent).toMatch(
      /create this IAP first/i,
    );
    expect(
      screen.queryByLabelText("Custom price for Vietnam"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Picker unavailable").length).toBeGreaterThan(0);
    // Nothing is fetched from any price source — no silent fallback path.
    expect(priceePointCalls(calls)).toEqual([]);
  });

  it("surfaces a per-territory no-donor response on the row", async () => {
    mockFetch({
      pricePointStatus: 409,
      pricePointBody: { error: "no donor", reason: "no-donor" },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.focus(screen.getByLabelText("Custom price for Vietnam"));
    await waitFor(() =>
      expect(
        screen.getByTestId("custom-price-row-VNM").textContent,
      ).toMatch(/create this IAP first/i),
    );
  });
});

// ─── Revertibility ───────────────────────────────────────────────────────────

describe("revertibility — one territory and all", () => {
  it("picking the placeholder clears that territory (delete, not a sentinel)", async () => {
    const { calls } = mockFetch();
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    expect(screen.getByTestId("custom-prices-changed-count").textContent).toContain("1");

    fireEvent.change(screen.getByLabelText("Custom price for Vietnam"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("custom-prices-changed-count").textContent).toContain(
        "0 customised",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Save custom prices/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT")!;
      // Empty array — an explicit clear, and no sentinel row.
      expect((put.body as { custom_prices: unknown[] }).custom_prices).toEqual([]);
      expect((put.body as { custom_prices_baseline: unknown }).custom_prices_baseline).toBeNull();
    });
  });

  it("Revert × clears the row", async () => {
    mockFetch();
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Revert ×/ }));
    await waitFor(() =>
      expect(screen.getByTestId("custom-prices-changed-count").textContent).toContain(
        "0 customised",
      ),
    );
  });

  it("Clear all empties the set after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockFetch();
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
        { territory_code: "BRA", customer_price: 24.9, currency_code: "BRL" },
      ],
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.click(
      screen.getByRole("button", { name: /Clear all custom prices/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("custom-prices-changed-count").textContent).toContain(
        "0 customised",
      ),
    );
  });

  it("Cancel discards the draft — presentation state never leaks into the data", async () => {
    const { calls } = mockFetch();
    const { onClose } = renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.click(
      screen.getByRole("button", { name: /Import all as custom prices/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

// ─── Stale ───────────────────────────────────────────────────────────────────

describe("stale state (§D)", () => {
  it("renders the banner with both resolutions when the baseline moved", async () => {
    mockFetch();
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
      currentBaseline: { ...BASELINE, tier_id: "TIER_15" },
      storedBaseline: BASELINE,
    });
    await waitFor(() =>
      expect(screen.getByTestId("custom-prices-stale-banner")).toBeInTheDocument(),
    );
    const banner = screen.getByTestId("custom-prices-stale-banner");
    expect(banner.textContent).toContain("TIER_10");
    expect(banner.textContent).toContain("TIER_15");
    expect(banner.textContent).toMatch(/Nothing has been deleted/);
    expect(
      screen.getByRole("button", { name: /Keep them \(reviewed\)/ }),
    ).toBeInTheDocument();
  });

  it("no banner when the baseline matches", async () => {
    mockFetch();
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    expect(
      screen.queryByTestId("custom-prices-stale-banner"),
    ).not.toBeInTheDocument();
  });

  it("no banner when there are no customs to review", async () => {
    mockFetch();
    renderDialog({
      currentBaseline: { ...BASELINE, tier_id: "TIER_15" },
      storedBaseline: BASELINE,
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    expect(
      screen.queryByTestId("custom-prices-stale-banner"),
    ).not.toBeInTheDocument();
  });
});

// ─── §I.3 ────────────────────────────────────────────────────────────────────

describe("§I.3 — a stored custom Apple no longer offers", () => {
  it("flags the row once its picker has been opened", async () => {
    mockFetch({ pricePoints: [19000, 22000, 29000] }); // 25000 withdrawn
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.focus(screen.getByLabelText("Custom price for Vietnam"));
    await waitFor(() =>
      expect(screen.getByText("no longer offered")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("custom-price-row-VNM").textContent).toMatch(
      /Apple withdrew this price point/,
    );
  });
});

// ─── Filtering ───────────────────────────────────────────────────────────────

describe("search + filter across ~175 rows", () => {
  it("search narrows by name", async () => {
    mockFetch();
    renderDialog();
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Search territories"), {
      target: { value: "brazil" },
    });
    expect(screen.getByText("Brazil")).toBeInTheDocument();
    expect(screen.queryByText("Vietnam")).not.toBeInTheDocument();
  });

  it("'Only customised' hides untouched rows but keeps the base row visible", async () => {
    mockFetch();
    renderDialog({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });
    await waitFor(() => expect(screen.getByText("Vietnam")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Only customised/));
    expect(screen.getByText("Vietnam")).toBeInTheDocument();
    expect(screen.queryByText("Kazakhstan")).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The chrome net (SC4 BƯỚC 1).
//
// These pin the toolbar/filter behaviours that were about to be extracted
// into TerritoryPickerShell. They were written and confirmed GREEN against
// the ORIGINAL inline chrome, BEFORE the extraction — that ordering is the
// whole point. Written afterwards they would be tests of the shell that
// happen to pass, not a regression net for the refactor.
//
// The continent predicate in particular had ZERO coverage: it could have
// been deleted outright and the other 476 lines stayed green.
//
// Fixture geography (verified via getContinentForTerritory):
//   Americas = { USA (base), BRA }      Asia = { VNM, KAZ }
//
// Row selectors use `custom-price-row-<CODE>` testids rather than country
// names, because the header also renders the base territory code.
//
// NOT COVERED HERE, deliberately: sticky thead + scroll frame. jsdom has no
// layout, so the only assertable thing is a className — a gate that proves
// nothing. Declared as a gap, verified by eye on the dev server.
// ═══════════════════════════════════════════════════════════════════════════

const row = (code: string) => screen.queryByTestId(`custom-price-row-${code}`);

async function renderLoaded(props?: Partial<Parameters<typeof CustomPricesDialog>[0]>) {
  mockFetch();
  const handles = renderDialog(props);
  await waitFor(() => expect(row("VNM")).toBeInTheDocument());
  return handles;
}

const continentChip = (name: string) => screen.getByRole("button", { name });
const searchBox = () => screen.getByLabelText("Search territories");

describe("chrome — continent chip filter", () => {
  it("filters to the chosen continent and drops every other row", async () => {
    await renderLoaded();

    fireEvent.click(continentChip("Asia"));

    expect(row("VNM")).toBeInTheDocument();
    expect(row("KAZ")).toBeInTheDocument();
    expect(row("USA")).not.toBeInTheDocument();
    expect(row("BRA")).not.toBeInTheDocument();
  });

  it("'All' restores the full catalogue after a continent filter", async () => {
    await renderLoaded();

    fireEvent.click(continentChip("Americas"));
    expect(row("VNM")).not.toBeInTheDocument();

    fireEvent.click(continentChip("All"));
    for (const code of ["USA", "VNM", "BRA", "KAZ"]) {
      expect(row(code)).toBeInTheDocument();
    }
  });
});

describe("chrome — search predicate branches", () => {
  it("matches on alpha-3 code, not only on name", async () => {
    await renderLoaded();

    // "usa" is a substring of neither "United States" nor "USD" — the only
    // way this row can survive is the territory_code branch.
    fireEvent.change(searchBox(), { target: { value: "usa" } });

    expect(row("USA")).toBeInTheDocument();
    expect(row("VNM")).not.toBeInTheDocument();
    expect(row("BRA")).not.toBeInTheDocument();
    expect(row("KAZ")).not.toBeInTheDocument();
  });

  it("matches on currency code", async () => {
    await renderLoaded();

    // "vnd" appears in neither "Vietnam" nor "VNM" — currency branch only.
    fireEvent.change(searchBox(), { target: { value: "vnd" } });

    expect(row("VNM")).toBeInTheDocument();
    expect(row("USA")).not.toBeInTheDocument();
  });

  it("is reversible — clearing the box restores every row", async () => {
    await renderLoaded();

    fireEvent.change(searchBox(), { target: { value: "brazil" } });
    expect(row("VNM")).not.toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: "" } });
    for (const code of ["USA", "VNM", "BRA", "KAZ"]) {
      expect(row(code)).toBeInTheDocument();
    }
  });
});

describe("chrome — the predicates compose", () => {
  it("continent AND query both apply; a row must satisfy both", async () => {
    await renderLoaded();

    fireEvent.click(continentChip("Asia"));
    fireEvent.change(searchBox(), { target: { value: "kaz" } });

    expect(row("KAZ")).toBeInTheDocument();
    // In Asia but fails the query.
    expect(row("VNM")).not.toBeInTheDocument();
    // Matches nothing and is out of continent.
    expect(row("USA")).not.toBeInTheDocument();
    expect(row("BRA")).not.toBeInTheDocument();
  });
});

describe("chrome — the base row's exemption is filter-specific", () => {
  it("'Only customised' exempts the base row", async () => {
    await renderLoaded({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });

    fireEvent.click(screen.getByLabelText(/Only customised/));

    // USA has no custom price and is kept anyway — is_base is exempt (:181).
    expect(row("USA")).toBeInTheDocument();
    expect(row("KAZ")).not.toBeInTheDocument();
  });

  it("continent and query do NOT exempt it — the base row can be filtered away", async () => {
    await renderLoaded();

    fireEvent.click(continentChip("Asia"));
    expect(row("USA")).not.toBeInTheDocument();

    fireEvent.click(continentChip("All"));
    fireEvent.change(searchBox(), { target: { value: "vietnam" } });
    expect(row("USA")).not.toBeInTheDocument();
  });
});

describe("chrome — the count chip counts the SET, not the view", () => {
  it("stays put when a filter hides the customised row", async () => {
    await renderLoaded({
      initialEntries: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
    });

    const chip = () => screen.getByTestId("custom-prices-changed-count").textContent;
    expect(chip()).toContain("1 customised");

    // Filter to a continent the custom is NOT in. If the count were ever
    // derived from the visible rows instead of the full set it would read 0.
    fireEvent.click(continentChip("Americas"));
    expect(row("VNM")).not.toBeInTheDocument();
    expect(chip()).toContain("1 customised");
  });
});

describe("chrome — empty state", () => {
  it("says the filter matched nothing rather than rendering a blank table", async () => {
    await renderLoaded();

    fireEvent.change(searchBox(), { target: { value: "zzzznotaterritory" } });

    expect(
      screen.getByText("No territories match the current filter."),
    ).toBeInTheDocument();
    for (const code of ["USA", "VNM", "BRA", "KAZ"]) {
      expect(row(code)).not.toBeInTheDocument();
    }
  });
});
