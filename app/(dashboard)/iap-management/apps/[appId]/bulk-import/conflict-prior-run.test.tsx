// @vitest-environment jsdom

/**
 * C3 C-3 [Q-C3.conflict-read-B] — the Step 3 conflict row must say WHY the
 * product already exists.
 *
 * Before this, a product that finished cleanly and a product left half-built
 * by a rate-limited batch produced IDENTICAL conflict rows, and the Manager
 * chose a ConflictMode from that row. The re-run decision for those two is
 * not the same, so presenting them the same way withheld the fact the
 * decision turns on.
 *
 * ⚠ ConflictMode mechanics are untouched ([Q-C3.rerun-A] — information only).
 * A test below pins that: the Action control renders exactly as it did, and
 * no default changes because a prior run was PARTIAL.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { Step3Preview } from "./BulkImportWizard";
import type { ConflictDecision } from "@/lib/iap-management/bulk-import/conflict-resolution";
import type { LastImportByProductId } from "@/lib/iap-management/queries/last-import";

afterEach(cleanup);

const PARTIAL_SENTENCE = "Created on Apple · 12/39 locales · missing screenshot";

function decision(productId: string): ConflictDecision {
  return {
    product_id: productId,
    disposition: "OVERWRITE",
    reason: "exists",
    conflict: true,
    resolved_tier_id: null,
    source: {
      row_index: 1,
      product_id: productId,
      reference_name: `Ref ${productId}`,
      type: "CONSUMABLE",
      type_source: "DEFAULT",
      price_usd: 0,
      base_price: 0,
      base_currency: "USD",
      localizations: [],
      warnings: [],
    },
  } as ConflictDecision;
}

function renderStep3(
  productIds: string[],
  lastImportByProductId: LastImportByProductId,
  existing = productIds,
) {
  return render(
    <Step3Preview
      decisions={productIds.map(decision)}
      counts={{ create: 0, overwrite: productIds.length, skip: 0, error: 0 } as never}
      conflictMode="OVERWRITE"
      onConflictModeChange={vi.fn()}
      onToggleOverride={vi.fn()}
      overrides={{}}
      existingSet={new Set(existing)}
      lastImportByProductId={lastImportByProductId}
      screenshots={[]}
      submitOnCreate={false}
      onSubmitOnCreateChange={vi.fn()}
      parsedSkippedLocales={[]}
      usdTiers={[]}
      tierOverrides={{}}
      onTierOverride={vi.fn()}
      pricingSource="APP_TEMPLATE"
      onPricingSourceChange={vi.fn()}
      defaultTemplateAvailable
      appTemplateAvailable
      defaultTemplateEntryCount={1}
      appTemplateEntryCount={1}
    />,
  );
}

const rowFor = (productId: string) =>
  screen.getByText(productId).closest("tr") as HTMLElement;

describe("a conflict row carries the previous run's verdict", () => {
  it("⚠ a PARTIAL prior run shows its sentence on the row", () => {
    renderStep3(["a"], { a: { status: "PARTIAL", summary: PARTIAL_SENTENCE } });
    expect(within(rowFor("a")).getByText(PARTIAL_SENTENCE)).toBeTruthy();
  });

  it("⚠ a SUCCESS prior run does NOT — and the two rows differ", () => {
    // The whole point: the Manager must be able to tell them apart at a
    // glance. If this ever passes with identical rows, the feature is gone.
    //
    // ⚠ The clean row's summary is asserted ABSENT BY ITS OWN TEXT, not by
    // keywords. A first draft checked the clean row for /missing|locales/ —
    // words that happen not to appear in "all stages OK" — so a mutation
    // showing EVERY prior run's sentence slipped straight through it. The
    // sentinel below cannot be missed that way.
    const CLEAN_SENTENCE = "Created on Apple · ZZ-CLEAN-SENTINEL";
    renderStep3(["a", "b"], {
      a: { status: "PARTIAL", summary: PARTIAL_SENTENCE },
      b: { status: "SUCCESS", summary: CLEAN_SENTENCE },
    });
    const partialRow = rowFor("a");
    const cleanRow = rowFor("b");
    expect(within(partialRow).queryByText(PARTIAL_SENTENCE)).toBeTruthy();
    expect(within(cleanRow).queryByText(PARTIAL_SENTENCE)).toBeNull();
    expect(cleanRow.textContent).not.toContain("ZZ-CLEAN-SENTINEL");
    expect(cleanRow.textContent).not.toMatch(/missing|locales/);
    expect(partialRow.textContent).not.toBe(cleanRow.textContent);
  });

  it("⚠ a product with NO prior record shows nothing — never 'fine'", () => {
    // Created in the single-IAP form, synced from Apple, or predating C3.
    // Compared against a row that DOES carry a note, so "renders nothing"
    // is measured rather than assumed from a keyword list.
    renderStep3(["a", "b"], { b: { status: "PARTIAL", summary: PARTIAL_SENTENCE } });
    const unknownRow = rowFor("a");
    expect(unknownRow.textContent).not.toMatch(/missing|incomplete|locales|Apple/);
    expect(unknownRow.querySelectorAll("svg")).toHaveLength(
      rowFor("b").querySelectorAll("svg").length - 1,
    );
  });

  it("a PARTIAL row with no stored sentence still says something", () => {
    renderStep3(["a"], { a: { status: "PARTIAL", summary: null } });
    expect(within(rowFor("a")).getByText(/incomplete/i)).toBeTruthy();
  });

  it("⚠ a NON-conflict row never carries a note", () => {
    // A verdict from an older run says nothing about a product that is not
    // in conflict now; showing it would be noise attached to the wrong row.
    renderStep3(["a"], { a: { status: "PARTIAL", summary: PARTIAL_SENTENCE } }, []);
    expect(rowFor("a").textContent).not.toContain(PARTIAL_SENTENCE);
  });
});

describe("⚠ ConflictMode mechanics are untouched — [Q-C3.rerun-A]", () => {
  it("the Action control renders the same for a PARTIAL and a clean prior run", () => {
    renderStep3(["a", "b"], {
      a: { status: "PARTIAL", summary: PARTIAL_SENTENCE },
      b: { status: "SUCCESS", summary: null },
    });
    // Last cell in each row is Action. The prior-run note must not change
    // which mode is offered or preselected — C3 adds information, not a
    // default.
    const actionOf = (id: string) => {
      const cells = rowFor(id).querySelectorAll("td");
      return cells[cells.length - 1].textContent;
    };
    expect(actionOf("a")).toBe(actionOf("b"));
    expect(actionOf("a")).toBe("OVERWRITE");
  });
});
