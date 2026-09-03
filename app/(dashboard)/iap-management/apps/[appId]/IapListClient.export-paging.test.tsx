// @vitest-environment jsdom
/**
 * [Y2] PAGINATION IN THE EXPORT PICKER — and the risk it introduces.
 *
 * ⚠ THIS FILE EXISTS FOR ONE SENTENCE. Before Y2 the picker's render window
 * only ever GREW, so a row the Manager had seen could never leave the screen
 * and the only possible divergence was "not shown yet". Pagination lets a
 * TICKED row travel off-screen, so "what I am looking at" and "what I have
 * selected" can now disagree IN BOTH DIRECTIONS — the same class of defect
 * the Google arc spent five chunks removing
 * ([GOOGLE-export-intersection-silent-drop]).
 *
 * Every assertion here is about that: the payload keeps what left the screen,
 * the counter says so out loud, and the two bulk controls keep their different
 * scopes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
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

/** 45 items: with page size 20 that is 3 pages, so "a middle page" is real. */
const N = 45;
const IAPS: InAppPurchase[] = Array.from({ length: N }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: i % 5 === 0 ? "NON_CONSUMABLE" : "CONSUMABLE",
      state: "APPROVED",
    },
  } as unknown as InAppPurchase;
});

let fetchSpy: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchSpy = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
        blob: async () => new Blob(["x"]),
        headers: new Headers({
          "Content-Disposition": 'attachment; filename="e.xlsx"',
          "X-Export-Item-Count": "1",
          "X-Export-Failed-Count": "0",
        }),
      }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
}

function renderList() {
  render(
    <IapListClient
      appId="123"
      appName="App"
      appBundleId="com.x"
      iaps={IAPS}
      drafts={[]}
      appleToInternal={{}}
      baseTerritoryByAppleId={{}}
    />,
  );
}

function openWizard() {
  fetchSpy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Export list/i }));
}

/** ⚠ Scoped — the list page behind the wizard has its OWN PageNav. */
function wizard() {
  return within(screen.getByTestId("export-wizard-items"));
}
const cb = (productId: string) =>
  wizard().getByRole("checkbox", { name: `Select ${productId}` });
const next = () => fireEvent.click(wizard().getByLabelText("Next page"));
const prev = () => fireEvent.click(wizard().getByLabelText("Previous page"));
const counts = () => wizard().getByTestId("selection-counts").textContent ?? "";
const pos = () => wizard().getByTestId("page-nav-position").textContent ?? "";

async function exportNow() {
  fireEvent.click(wizard().getByTestId("wizard-continue"));
  await waitFor(() =>
    expect(screen.getByText("Export options")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));
  await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { selectedIds: string[] })
    .selectedIds;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ─── Y2.4 — THE BIGGEST RISK, ITS OWN TEST ────────────────────────────────

describe("⚠ Y2.4 — a pick that scrolled off the screen is STILL IN THE EXPORT", () => {
  /**
   * ⚠ MUTATION (Y2.7, "lựa chọn mất khi flip trang"): reset `selected` in the
   * page-change handler, or scope the payload to the current page. Red here.
   */
  it("tick on page 1 → go to page 3 → export ⇒ the page-1 id is in the payload", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02")); // page 1
    next();
    next(); // page 3
    expect(pos()).toContain("3");
    expect(
      wizard().queryByRole("checkbox", { name: "Select com.x.02" }),
    ).toBeNull();
    fireEvent.click(cb("com.x.41")); // page 3
    expect((await exportNow()).sort()).toEqual(["apple-02", "apple-41"]);
  });

  /**
   * ⚠ THE DIVERGENCE MUST BE ON SCREEN, NOT MERELY CORRECT. M2 is a
   * requirement precisely because this state is now reachable.
   *
   * ⚠ VACUITY GUARD: it must read "0 on this page", not omit the clause. An
   * absent number reads as "nothing is selected".
   */
  it("the counter reports BOTH tiers, and says 0 on this page when they diverge", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    expect(counts()).toContain("1 selected");
    expect(counts()).toContain("1 on this page");
    next();
    expect(counts()).toContain("1 selected");
    expect(counts()).toContain("0 on this page");
  });

  it("and it names the off-page picks in words, not just a number", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    expect(
      wizard().queryByTestId("selection-offpage-notice"),
    ).toBeNull(); // on this page — nothing to warn about
    next();
    expect(
      wizard().getByTestId("selection-offpage-notice").textContent,
    ).toContain("on other pages");
  });

  /**
   * ⚠ MUTATION (Y2.7, "lựa chọn mất khi xoá search"): red here.
   * M4 held before Y2; this proves paging did not break it.
   */
  it("M4 across pages — search, tick, clear the search: still selected", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.change(wizard().getByTestId("item-search"), {
      target: { value: "com.x.33" },
    });
    fireEvent.click(cb("com.x.33"));
    fireEvent.change(wizard().getByTestId("item-search"), {
      target: { value: "" },
    });
    expect(counts()).toContain("1 selected");
    expect((await exportNow())).toEqual(["apple-33"]);
  });
});

// ─── (A) vs (B) — the M7 money test ───────────────────────────────────────

describe("⚠ (A) and (B) have DIFFERENT scopes, and that is the whole of M7", () => {
  /**
   * ⚠ MUTATION (Y2.7): "(B) chọn toàn bộ list" → red. "(A) chỉ chọn trang
   * hiện tại" → red. The two numbers here are 20 and 45; nothing else in the
   * suite would notice them being swapped.
   */
  it("(B) takes exactly this page — 20, not 45", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(wizard().getByTestId("select-all-in-page"));
    expect(counts()).toContain("20 selected");
    expect(counts()).toContain("20 on this page");
  });

  it("(A) takes every matching row across every page — 45, not 20", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(wizard().getByTestId("select-all-matching"));
    expect(counts()).toContain("45 selected");
    expect(counts()).toContain("20 on this page");
  });

  it("(B) on page 2 leaves page 1's picks alone — M1, cumulative", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(wizard().getByTestId("select-all-in-page")); // 20
    next();
    fireEvent.click(wizard().getByTestId("select-all-in-page")); // +20
    expect(counts()).toContain("40 selected");
  });

  it("(B) while SEARCHING ticks the filtered page only — M5", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.change(wizard().getByTestId("item-search"), {
      target: { value: "com.x.1" },
    });
    // ⚠ Ids are zero-padded, so "com.x.1" matches com.x.10..19 and NOT a
    //   "com.x.1" (that row is com.x.01) — 10 matches, one page at size 20.
    fireEvent.click(wizard().getByTestId("select-all-in-page"));
    expect(counts()).toContain("10 selected");
    expect(counts()).toContain("10 matching");
    // ⚠ And (B) took the filtered page, not the unfiltered 20.
    expect(counts()).toContain("10 on this page");
  });
});

describe("(B)'s tri-state — partial FILLS, it never clears (§2.2)", () => {
  it("partial ⇒ indeterminate, and the label still says Select", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.03"));
    const box = wizard().getByTestId("select-all-in-page") as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
    expect(box.getAttribute("aria-label")).toBe(
      "Select all 20 on this page",
    );
  });

  /**
   * ⚠ MUTATION: make the partial click clear the page. Red — and that mutation
   * is the destructive reading of an ambiguous click, which is how picks get
   * lost.
   */
  it("clicking from PARTIAL fills the rest of the page — 1 becomes 20, not 0", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.03"));
    fireEvent.click(wizard().getByTestId("select-all-in-page"));
    expect(counts()).toContain("20 selected");
  });

  it("from FULL the label flips to Clear, and clicking clears just this page", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(wizard().getByTestId("select-all-matching")); // all 45
    const box = wizard().getByTestId("select-all-in-page") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-label")).toBe("Clear 20 on this page");
    fireEvent.click(box);
    expect(counts()).toContain("25 selected"); // 45 − this page's 20
    expect(counts()).toContain("0 on this page");
  });
});

// ─── Q7 — the page-size selector ──────────────────────────────────────────

describe("⚠ Q7 — changing the page size ANCHORS the viewport", () => {
  const setSize = (n: number) =>
    fireEvent.change(wizard().getByTestId("page-size-select"), {
      target: { value: String(n) },
    });

  it("is a dropdown offering 20 / 30 / 50", () => {
    stubFetch();
    renderList();
    openWizard();
    const sel = wizard().getByTestId("page-size-select") as HTMLSelectElement;
    expect(sel.tagName).toBe("SELECT");
    expect([...sel.options].map((o) => o.value)).toEqual(["20", "30", "50"]);
  });

  /**
   * ⚠ MUTATION (Y2.7, "đổi page size reset về trang 1"): red here.
   * 45 items, page 3 at size 20 ⇒ startIndex 40 ⇒ floor(40/30)+1 = 2.
   */
  it("20 → 30 while on page 3 lands on page 2, NOT page 1", () => {
    stubFetch();
    renderList();
    openWizard();
    next();
    next();
    expect(pos()).toContain("3");
    setSize(30);
    expect(pos()).toContain("Page 2");
    expect(pos()).toContain("of 2");
  });

  /**
   * ⚠ THE CLAMP CASE THE MANAGER ASKED FOR EXPLICITLY. 45 items, page 3 at
   * size 20 ⇒ startIndex 40 ⇒ floor(40/50)+1 = 1, and there is only 1 page at
   * size 50 anyway — so the anchor and the clamp agree here. The assertion is
   * that nothing lands out of range and the selection survives.
   */
  it("20 → 50 while on the last page clamps into range without losing picks", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    next();
    next();
    setSize(50);
    // 45 items at size 50 is a single page, so the position label is gone —
    // which is itself the assertion that we did not land out of range.
    expect(wizard().queryByTestId("page-nav-position")).toBeNull();
    expect(counts()).toContain("1 selected");
    expect(counts()).toContain("1 on this page");
  });

  it("the selection is byte-for-byte unaffected by a size change", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    fireEvent.click(cb("com.x.05"));
    setSize(50);
    expect((await exportNow()).sort()).toEqual(["apple-02", "apple-05"]);
  });
});

// ─── Q5 — "Selected only" ─────────────────────────────────────────────────

describe("Q5 — 'Selected only' is a VIEW over the same selection", () => {
  it("shows exactly the ticked rows, wherever they were", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    next();
    fireEvent.click(cb("com.x.25"));
    fireEvent.click(wizard().getByTestId("view-selected"));
    expect(cb("com.x.02")).toBeInTheDocument();
    expect(cb("com.x.25")).toBeInTheDocument();
    expect(
      wizard().queryByRole("checkbox", { name: "Select com.x.03" }),
    ).toBeNull();
    expect(counts()).toContain("2 selected");
    expect(counts()).toContain("2 on this page");
  });

  /** ⚠ Q5: (B) is NOT special-cased there — the state machine already gives
   *  it `checked` + the Clear label, because every rendered row is ticked. */
  it("(B) needs no special case there — it renders checked, labelled Clear", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    fireEvent.click(wizard().getByTestId("view-selected"));
    const box = wizard().getByTestId("select-all-in-page") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-label")).toBe("Clear 1 on this page");
  });

  it("switching the view selects nothing and unselects nothing", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.02"));
    fireEvent.click(wizard().getByTestId("view-selected"));
    fireEvent.click(wizard().getByTestId("view-all"));
    expect((await exportNow())).toEqual(["apple-02"]);
  });
});

describe("⚠ paging still costs ZERO Apple requests", () => {
  it("flipping pages, changing the size and switching views issue no fetch", () => {
    stubFetch();
    renderList();
    openWizard();
    next();
    next();
    prev();
    fireEvent.change(wizard().getByTestId("page-size-select"), {
      target: { value: "50" },
    });
    fireEvent.click(wizard().getByTestId("select-all-in-page"));
    fireEvent.click(wizard().getByTestId("view-selected"));
    fireEvent.click(wizard().getByTestId("view-all"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
