// @vitest-environment jsdom
/**
 * [Y1] Shift-click range, END TO END: from the gesture to the POST body.
 *
 * ⚠ WHY A SEPARATE FILE AND NOT MORE CASES IN `export-wizard.test.tsx`. That
 * file's premise is stated at the top of it — the primary acceptance is an
 * ABSENCE (opening and working the wizard must issue no `fetch`), and every
 * helper in it is built around a spy scoped by time. Nothing there is edited
 * or deleted by this arc. The range needs the opposite kind of assertion — a
 * PRESENCE, in the request body — so it gets its own file rather than being
 * threaded through a harness built for the other question.
 *
 * ⚠ THE ZERO-FETCH ACCEPTANCE IS RE-ASSERTED HERE ANYWAY, for the new gesture
 * specifically. It is the feature's first acceptance criterion
 * (ExportItemWizard.tsx:8-14) and it is exactly the sort of thing a new
 * interaction quietly breaks.
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

const iap = (n: string, over: { type?: string } = {}): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: over.type ?? "CONSUMABLE",
      state: "APPROVED",
    },
  }) as unknown as InAppPurchase;

/** Six rows, in a known order — "the rows between" needs an order. */
const IAPS = [
  iap("a"),
  iap("b"),
  iap("c", { type: "NON_CONSUMABLE" }),
  iap("d"),
  iap("e"),
  iap("f"),
];

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
          "X-Export-Item-Count": "3",
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

/** ⚠ Empty `appleToInternal` for the same two reasons the sibling file states:
 *  it is the honest export case (no internal UUID needed), and it keeps
 *  `AvailabilityCell` from firing page-owned requests into the spy's window. */
function renderList(iaps: InAppPurchase[] = IAPS) {
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

function openWizard() {
  fetchSpy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Export list/i }));
}

/** ⚠ Scoped: the list page behind the wizard has its own checkboxes. */
function wizard() {
  return within(screen.getByTestId("export-wizard-items"));
}

const cb = (productId: string) =>
  wizard().getByRole("checkbox", { name: `Select ${productId}` });

async function exportNow() {
  fireEvent.click(wizard().getByTestId("wizard-continue"));
  await waitFor(() =>
    expect(screen.getByText("Export options")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));
  await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { selectedIds: string[] }).selectedIds;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("a shift-click range reaches the POST body", () => {
  it("posts the whole range — the rows between the two clicks", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.b"));
    fireEvent.click(cb("com.x.e"), { shiftKey: true });
    expect((await exportNow()).sort()).toEqual([
      "apple-b",
      "apple-c",
      "apple-d",
      "apple-e",
    ]);
  });

  /**
   * ⚠ Q3, AT THE LAYER WHERE IT COSTS MONEY. If the range ever REPLACES the
   * selection (the Finder/Explorer model M1 disqualifies), `apple-a` drops
   * out of the workbook and nothing on screen says why.
   */
  it("⚠ ADDITIVE — a pick made before the range is still in the payload", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.a"));
    fireEvent.click(cb("com.x.c"));
    fireEvent.click(cb("com.x.e"), { shiftKey: true });
    expect((await exportNow()).sort()).toEqual([
      "apple-a",
      "apple-c",
      "apple-d",
      "apple-e",
    ]);
  });

  /**
   * ⚠ M4 + M5 THROUGH THE RANGE. The facet hides `com.x.c` (the only
   * NON_CONSUMABLE), so a range from b to e must NOT contain it — and the pick
   * made before the facet changed must survive.
   */
  it("a facet-hidden row between the two clicks is not swept into the export", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.a")); // ticked with no facet applied
    fireEvent.change(wizard().getByTestId("wizard-type-filter"), {
      target: { value: "CONSUMABLE" },
    });
    expect(
      wizard().queryByRole("checkbox", { name: "Select com.x.c" }),
    ).toBeNull();
    fireEvent.click(cb("com.x.b"));
    fireEvent.click(cb("com.x.e"), { shiftKey: true });
    const ids = await exportNow();
    expect(ids).not.toContain("apple-c");
    expect(ids.sort()).toEqual(["apple-a", "apple-b", "apple-d", "apple-e"]);
  });

  it("⚠ still ZERO Apple requests — the gesture is client-side, like the rest of step 1", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.b"));
    fireEvent.click(cb("com.x.e"), { shiftKey: true });
    fireEvent.click(cb("com.x.a"), { shiftKey: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the scale line counts the range — the cost is visible before the run", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.b"));
    fireEvent.click(cb("com.x.e"), { shiftKey: true });
    // 4 items × REQUESTS_PER_ITEM (3) = 12
    expect(wizard().getByTestId("export-scale-line").textContent).toContain(
      "Export 4 items",
    );
    expect(wizard().getByTestId("export-scale-line").textContent).toContain(
      "about 12 Apple requests",
    );
  });
});

describe("⚠ THERE IS NO 'all' SENTINEL, and there must never be one", () => {
  /**
   * The census found (A)'s state is DERIVED — `selectedMatching === matching` —
   * so "select all, then untick one" is a plain `Set.delete` with nothing to
   * convert. That is currently true by a good decision rather than by a guard,
   * which is exactly the kind of property that gets "optimised" away later.
   *
   * ⚠ MUTATION: represent a full selection as a sentinel (e.g. `selected =
   * "ALL"`) and expand it at POST time. This goes red, because unticking one
   * row must remove exactly one id.
   */
  it("select all, then untick ONE row — the payload is N-1 ids, not all of them", async () => {
    stubFetch();
    renderList();
    openWizard();
    // ⚠ [Y2/Q1] (A) is a BUTTON now, not a checkbox. Re-targeted, same act.
    fireEvent.click(wizard().getByTestId("select-all-matching"));
    fireEvent.click(cb("com.x.d"));
    const ids = await exportNow();
    expect(ids).toHaveLength(IAPS.length - 1);
    expect(ids).not.toContain("apple-d");
  });

  /**
   * ⚠ RE-EXPRESSED IN Y2, AND THE REASON IS THE POINT OF M2.
   *
   * The Y1 form asserted `indeterminate` on (A)'s checkbox. Q1 turned (A) into
   * a labelled button, and a button has no indeterminate state — that cost was
   * DECLARED when Q1 was taken, and M2's two-tier counter is what pays it
   * back. So the same fact ("the batch is now partial") is asserted where it
   * actually lives: on the counter and on (A)'s own label.
   *
   * ⚠ This is a stronger assertion than the original, not a weaker one: it
   * pins that the counter really does carry the signal the checkbox used to,
   * which is the whole justification for allowing Q1.
   */
  it("⚠ once one row is out, (A)'s LABEL and the M2 counter both say partial", () => {
    stubFetch();
    renderList();
    openWizard();
    const all = () => wizard().getByTestId("select-all-matching");
    const counts = () => wizard().getByTestId("selection-counts").textContent;

    fireEvent.click(all());
    expect(all().textContent).toContain(`Clear all ${IAPS.length}`);
    expect(counts()).toContain(`${IAPS.length} selected`);

    fireEvent.click(cb("com.x.d"));
    // The label flips back to the "select" direction — it is no longer "all".
    expect(all().textContent).toContain(
      `Select all ${IAPS.length} matching`,
    );
    expect(counts()).toContain(`${IAPS.length - 1} selected`);
  });
});

describe("the hint is on the export surface — Y1.2", () => {
  it("the baseline tip renders, because the gesture has no control of its own", () => {
    stubFetch();
    renderList();
    openWizard();
    expect(wizard().getByTestId("range-hint")).toBeInTheDocument();
  });

  it("a Shift-click with no starting row ticks one row and SAYS SO", () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(cb("com.x.d"), { shiftKey: true });
    expect(wizard().getByTestId("range-hint-miss")).toBeInTheDocument();
    expect(
      (cb("com.x.d") as HTMLInputElement).checked,
    ).toBe(true);
  });
});
