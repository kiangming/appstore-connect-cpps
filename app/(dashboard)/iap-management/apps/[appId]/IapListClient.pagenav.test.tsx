// @vitest-environment jsdom
/**
 * [Y2] THE LIST PAGE'S FOOTER, AFTER THE PageNav EXTRACTION.
 *
 * ⚠ Y2.8 asked whether the outer table's existing tests still pass. They do —
 * because there were none for this footer. That absence is the finding: the
 * extraction had nothing to fail. These tests are the guard the first consumer
 * never had, written so the SECOND consumer cannot change it for them.
 *
 * ⚠ AND THE ASYMMETRY IS ASSERTED (Q4): this surface must have NO page-size
 * selector. The picker offers 20/30/50; the list stays at PAGE_SIZE = 100. It
 * is a decision, so it gets an assertion rather than a comment nobody reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { IapListClient } from "./IapListClient";
import type { InAppPurchase } from "@/types/iap-management/apple";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-id"),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/** PAGE_SIZE is 100, so 240 items is 3 pages. */
const many = (n: number): InAppPurchase[] =>
  Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(3, "0");
    return {
      id: `apple-${k}`,
      type: "inAppPurchases",
      attributes: {
        name: `Item ${k}`,
        productId: `com.x.${k}`,
        inAppPurchaseType: "CONSUMABLE",
        state: "APPROVED",
      },
    } as unknown as InAppPurchase;
  });

function renderList(iaps: InAppPurchase[]) {
  render(
    <IapListClient
      appId="123"
      appName="App"
      appBundleId="com.x"
      iaps={iaps}
      drafts={[]}
      appleToInternal={{}}
      baseTerritoryByAppleId={{}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("the list page footer still behaves as it did before the extraction", () => {
  it("shows the range, the total, and the position", () => {
    renderList(many(240));
    const nav = screen.getByTestId("page-nav");
    expect(nav.textContent).toContain("Showing");
    expect(nav.textContent).toContain("1–100");
    expect(nav.textContent).toContain("240");
    expect(screen.getByTestId("page-nav-position").textContent).toContain(
      "of 3",
    );
  });

  it("Next advances the page and the range moves with it", () => {
    renderList(many(240));
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(screen.getByTestId("page-nav").textContent).toContain("101–200");
  });

  /** ⚠ The behaviour that would have been silently lost if the single-page
   *  hide had been moved into PageNav: a small app shows NO footer at all. */
  it("renders no footer at all for a single-page app — unchanged", () => {
    renderList(many(12));
    expect(screen.queryByTestId("page-nav")).toBeNull();
  });

  it("⚠ Q4 — NO page-size selector on this surface, deliberately", () => {
    renderList(many(240));
    expect(screen.queryByTestId("page-size-select")).toBeNull();
  });
});
