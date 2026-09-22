// @vitest-environment jsdom

/**
 * [TIER-TIEBREAK-priority] 3.4-B — Step 3 must SAY how many rows need a tier
 * choice, and be able to show only those.
 *
 * ⚠ THE PROBLEM IS SCALE, NOT ABSENCE. The amber `TierCell` dropdown has
 * existed since IAP.o.5; Manager's batches are 88 rows and the census found
 * five shared-price groups, so a real batch can hide three amber cells inside
 * a 420px scroller. Hunting for a colour is precisely the job the export
 * picker arc was built to delete — this is the same answer in the same place.
 *
 * ⚠ AND THE DEFAULT NOW POINTS AT THE STANDARD TIER. Manager's census
 * (2026-09-22) showed all five collision groups are TIER-vs-ALT, and that the
 * two are NOT interchangeable — $0.99 diverges in 75 of 175 countries. So the
 * pre-selected value is a real choice, not a formality.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";
import type { ConflictDecision } from "@/lib/iap-management/bulk-import/conflict-resolution";
import type { ParsedIapItem } from "@/lib/iap-management/parsers/iap-items";
import { resolveTierByUsdPrice } from "@/lib/iap-management/queries/price-tiers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Step3Preview } from "./BulkImportWizard";

/**
 * ⚠ THE REAL COLLISION SHAPE, from Manager's census SQL (2026-09-22): five
 * shared-price groups, all TIER-vs-ALT, and $0.99 carries FOUR tiers.
 */
/**
 * ⚠ THE ORDER HERE IS ADVERSARIAL ON PURPOSE — ALT BEFORE TIER IN BOTH GROUPS.
 *
 * The first draft listed `TIER_1` and `TIER_5` first, and the "pre-selects the
 * STANDARD tier" test below passed even when the dropdown was mutated back to
 * an UNSORTED `usdTiers.filter(...)` — because the fixture already happened to
 * be in the desired order. A test that cannot fail is not a test.
 *
 * This order is also the realistic one: the USD lists are
 * `.order("customer_price")` only (`price-tiers.ts`, `templates.ts`), so
 * within a shared price Postgres may return any order at all.
 */
const TIERS: UsdTierEntry[] = [
  { tier_id: "ALT_B", customer_price: 0.99 },
  { tier_id: "ALT_A", customer_price: 0.99 },
  { tier_id: "ALT_1", customer_price: 0.99 },
  { tier_id: "TIER_1", customer_price: 0.99 },
  { tier_id: "ALT_5", customer_price: 4.99 },
  { tier_id: "TIER_5", customer_price: 4.99 },
  { tier_id: "TIER_20", customer_price: 19.99 },
];

function item(product_id: string, price_usd: number): ParsedIapItem {
  return {
    row_index: 1,
    product_id,
    // ⚠ NOT the product_id. The preview table renders both in the same row,
    // so a fixture that repeats the id makes every `getAllByText(/^com\./)`
    // count each row twice — which the first draft of this file did, and
    // which reads exactly like the filter being broken (P44).
    reference_name: `Ref ${product_id}`,
    type: "CONSUMABLE",
    type_source: "DEFAULT",
    price_usd,
    base_price: price_usd,
    base_currency: "USD",
    localizations: [],
    warnings: [],
  };
}

/**
 * ⚠ `resolved_tier_id` COMES FROM THE REAL RESOLVER, NOT A LITERAL.
 *
 * In production `enrichWithTiers` fills this before Step 3 renders. The first
 * draft hard-coded `null`, and `TierCell` short-circuits to an em-dash when
 * nothing is selected (`if (!selected)`) — so the dropdown never rendered and
 * the suite reported "0 selects found", which looks identical to the feature
 * being absent. Calling the resolver keeps the fixture honest AND means this
 * file exercises the very tie-break it is asserting.
 */
function decision(product_id: string, price_usd: number): ConflictDecision {
  return {
    product_id,
    disposition: "CREATE",
    source: item(product_id, price_usd),
    resolved_tier_id: resolveTierByUsdPrice(price_usd, TIERS),
  } as ConflictDecision;
}

/** Two ambiguous rows ($0.99, $4.99) and three unambiguous ($19.99). */
const DECISIONS: ConflictDecision[] = [
  decision("com.amb.a", 0.99),
  decision("com.plain.a", 19.99),
  decision("com.amb.b", 4.99),
  decision("com.plain.b", 19.99),
  decision("com.plain.c", 19.99),
];

function renderPreview(decisions = DECISIONS, tiers = TIERS) {
  return render(
    <Step3Preview
      decisions={decisions}
      counts={{ create: decisions.length, overwrite: 0, skip: 0, error: 0 }}
      conflictMode="OVERWRITE"
      onConflictModeChange={vi.fn()}
      onToggleOverride={vi.fn()}
      overrides={{}}
      existingSet={new Set()}
      lastImportByProductId={{}}
      screenshots={[]}
      submitOnCreate={false}
      onSubmitOnCreateChange={vi.fn()}
      parsedSkippedLocales={[]}
      usdTiers={tiers}
      tierOverrides={{}}
      onTierOverride={vi.fn()}
      pricingSource="APPLE"
      onPricingSourceChange={vi.fn()}
      defaultTemplateAvailable={false}
      appTemplateAvailable={false}
    />,
  );
}

/** Product-id cells only — the first `<td>` of each body row. */
const rowIds = () =>
  Array.from(
    document.querySelectorAll("tbody tr > td:first-child"),
  ).map((el) => (el.textContent ?? "").trim().split("\n")[0]);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("the count", () => {
  it("⚠ states how many rows need a tier choice, before any click", () => {
    // Without this the Manager has to discover the amber cells by scrolling.
    renderPreview();
    expect(screen.getByTestId("ambiguous-tier-count")).toHaveTextContent("2");
    expect(screen.getByTestId("ambiguous-tier-bar")).toHaveTextContent(
      /2 of 5 rows match more than one tier/,
    );
  });

  it("⚠ counts ROWS needing a decision, not tiers and not collision groups", () => {
    // $0.99 has four candidate tiers and $4.99 has two — six tiers across two
    // rows. The number the Manager acts on is 2.
    renderPreview();
    expect(screen.getByTestId("ambiguous-tier-count")).toHaveTextContent("2");
  });

  it("hides the whole bar when nothing is ambiguous", () => {
    // "0 rows need a tier choice" on every clean batch is noise, not comfort.
    renderPreview([decision("com.plain.a", 19.99)]);
    expect(screen.queryByTestId("ambiguous-tier-bar")).not.toBeInTheDocument();
  });
});

describe("the filter", () => {
  it("shows every row when off", () => {
    renderPreview();
    expect(rowIds()).toHaveLength(5);
  });

  it("⚠ shows ONLY the rows needing a choice when on", () => {
    renderPreview();
    fireEvent.click(screen.getByTestId("ambiguous-tier-filter"));
    const ids = rowIds();
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining(["com.amb.a", "com.amb.b"]));
    expect(ids).not.toEqual(expect.arrayContaining(["com.plain.a"]));
  });

  it("is reversible — unticking restores the full list", () => {
    renderPreview();
    const box = screen.getByTestId("ambiguous-tier-filter");
    fireEvent.click(box);
    expect(rowIds()).toHaveLength(2);
    fireEvent.click(box);
    expect(rowIds()).toHaveLength(5);
  });

  it("⚠ the count does NOT shrink when the filter is applied", () => {
    // The count is the denominator-bearing fact ("2 of 5"); recomputing it
    // from the visible rows would make it say "2 of 2" and lose the scale
    // that motivated the filter.
    renderPreview();
    fireEvent.click(screen.getByTestId("ambiguous-tier-filter"));
    expect(screen.getByTestId("ambiguous-tier-bar")).toHaveTextContent(
      /2 of 5 rows/,
    );
  });
});

describe("the default the filter points at", () => {
  it("⚠ pre-selects the STANDARD tier, and lists it first", () => {
    // The arc's whole subject. Under the old localeCompare tie-break this
    // select would have opened on ALT_1 at $0.99 and ALT_5 at $4.99.
    renderPreview();
    fireEvent.click(screen.getByTestId("ambiguous-tier-filter"));
    const selects = screen.getAllByRole("combobox").filter((el) =>
      el.getAttribute("title")?.includes("Same USD price matches"),
    );
    expect(selects).toHaveLength(2);
    for (const sel of selects) {
      const opts = Array.from(sel.querySelectorAll("option"));
      expect(opts[0].textContent).toMatch(/^Tier /);
      expect(opts[0].textContent).not.toMatch(/^Alt Tier /);
    }
  });
});
