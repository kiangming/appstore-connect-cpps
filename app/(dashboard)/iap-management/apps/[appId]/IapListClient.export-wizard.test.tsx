// @vitest-environment jsdom
/**
 * 🎯 THE PRIMARY ACCEPTANCE FOR THIS FEATURE IS AN ABSENCE, AND IT ONLY EXISTS
 * AT THIS LAYER (design §2.I.1).
 *
 * ⚠ WHY IT CANNOT BE TESTED LOWER. Every existing export test lives below the
 * page — inside `fetchExportSources`, inside `buildExportPlan`, inside the
 * route. Not one of them can observe what OPENING the wizard costs, because
 * none of them opens it. That is the same blind spot D1 hit in the SC6 arc:
 * ~60 tests, all starting inside the modal, none noticing the feature was
 * unreachable.
 *
 * The whole value of item selection is that the Manager narrows the batch
 * BEFORE paying Apple. A pre-read anywhere in step 1 or step 2 silently
 * deletes that value while every lower test stays green. So the assertion is:
 * open the wizard, work it — search, both filters, select all, advance to
 * countries, come back — and `fetch` must never have been called.
 *
 * ⚠ The spy is asserted on `fetch` ITSELF, not on a count of Apple URLs. A
 * test that allowlisted "/api/iap-management/territories" would pass a version
 * that fetched the catalogue on open, which is precisely the regression shape
 * this guards (that route is what the availability modal calls, and the wizard
 * sits two clicks away from it in the same toolbar).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toast } from "sonner";
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

const iap = (
  n: string,
  over: { type?: string; state?: string } = {},
): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: over.type ?? "CONSUMABLE",
      state: over.state ?? "APPROVED",
    },
  }) as unknown as InAppPurchase;

const IAPS = [
  iap("a"),
  iap("b", { type: "NON_CONSUMABLE" }),
  iap("c", { state: "DEVELOPER_REMOVED_FROM_SALE" }),
];

let fetchSpy: ReturnType<typeof vi.fn>;

function stubFetch(exportHeaders: Record<string, string> = {}) {
  fetchSpy = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
        blob: async () => new Blob(["x"]),
        headers: new Headers({
          "Content-Disposition": 'attachment; filename="e.xlsx"',
          "X-Export-Item-Count": "2",
          "X-Export-Failed-Count": "0",
          ...exportHeaders,
        }),
      }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchSpy);
  // jsdom has no object-URL plumbing; the download path uses both.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
}

/**
 * ⚠ `appleToInternal` DEFAULTS TO EMPTY, and that is doing two jobs.
 *
 * 1. It is the honest export case. The export route never touches the local
 *    DB, so an Apple item with no internal UUID must be fully selectable
 *    (design §2.G) — the defect chunk 2b's module exists to prevent. Every
 *    test below therefore runs against exactly the rows A′ would have
 *    excluded.
 * 2. It keeps the PAGE quiet. `AvailabilityCell` (IapListClient.tsx:733)
 *    fetches per row that HAS an internal id, on the shared Hotfix-25 queue,
 *    draining asynchronously. Those are the page's requests, not the wizard's,
 *    and with a populated map they would land inside the spy's window and be
 *    miscounted as the wizard's cost.
 */
function renderList(
  iaps: InAppPurchase[] = IAPS,
  appleToInternal: Record<string, string> = {},
) {
  render(
    <IapListClient
      appId="123"
      appName="App"
      appBundleId="com.x"
      iaps={iaps}
      drafts={[]}
      appleToInternal={appleToInternal}
      baseTerritoryByAppleId={{}}
    />,
  );
}

/**
 * ⚠ THE SPY IS CLEARED AT THE MOMENT THE WIZARD OPENS, and every assertion
 * below is about calls made AFTER that point.
 *
 * The page itself fetches the app icon from itunes.apple.com on mount
 * (`useAppIcon`), which has nothing to do with the wizard and would be counted
 * forever otherwise. Scoping by TIME, not by URL, is deliberate: an allowlist
 * ("ignore /api/iap-management/territories") would happily pass a version that
 * fetched the territory catalogue on open — the exact regression shape this
 * guards, since that route is what the availability modal in the same toolbar
 * calls. Any new fetch of any kind still fails these tests.
 */
function openWizard() {
  fetchSpy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Export list/i }));
}

/** ⚠ Scoped, because the LIST PAGE behind the wizard has its own "Select all"
 *  and its own per-row checkboxes. An unscoped query would be ambiguous at
 *  best and, worse, could pass by driving the page instead of the wizard. */
function wizard() {
  return within(screen.getByTestId("export-wizard-items"));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ─── 🎯 the absence ────────────────────────────────────────────────────────

describe("opening and working the export wizard costs ZERO Apple requests", () => {
  it("opening it issues no fetch at all", () => {
    stubFetch();
    renderList();

    openWizard();

    expect(screen.getByTestId("export-wizard-items")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("changing the Type filter issues no fetch", () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.change(wizard().getByTestId("wizard-type-filter"), {
      target: { value: "NON_CONSUMABLE" },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("changing the Apple status filter issues no fetch", () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.change(wizard().getByTestId("wizard-status-filter"), {
      target: { value: "DEVELOPER_REMOVED_FROM_SALE" },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("selecting items and advancing to the country step issues no fetch", async () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(wizard().getByTestId("wizard-continue"));

    // ⚠ COMMENT CORRECTED BY G3, not just reworded: step 2 used to be the
    // SHARED dialog with 183 entries. Since [Q-EXPORT.apple-only-picker] the
    // Apple wizard passes Apple's own 175. Still static, still no request —
    // which is what this test is actually about.
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE WIRING, WHICH NOTHING TESTED UNTIL THIS POINT — P26 caught it.
   *
   * `ExportOptionsDialog.apple-catalog.test.tsx` proves the dialog behaves
   * correctly WHEN GIVEN Apple's catalog. It cannot prove the Apple wizard
   * actually gives it one. Mutating `ExportItemWizard` to pass the shared
   * catalog instead left this file's 19 tests green — the pattern was proven
   * and the wiring was not.
   *
   * This is the only place both halves meet: the real wizard, the real dialog,
   * the real catalog module.
   */
  it("⚠ step 2 offers APPLE's markets — Russia in, Andorra out (the wiring)", async () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );

    // 175, and said in the dialog's own words so a count change cannot hide.
    expect(screen.getByText("175 of 175 selected")).toBeInTheDocument();
    // RU is in Apple's list and has never been in TERRITORY_CATALOG, so its
    // presence can only come from the Apple catalog being wired through.
    expect(screen.getByLabelText(/Russia/i)).toBeInTheDocument();
    // AD is in the shared catalog and not in Apple's — its absence is the
    // other direction of the same proof.
    expect(screen.queryByLabelText(/Andorra/i)).not.toBeInTheDocument();
    // …and none of this cost a request, which is this file's whole subject.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("going back from countries to items issues no fetch and keeps the selection", async () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );

    // The dialog's own close control is the wizard's Back — composition
    // outside the (unmodified, three-prop) shared component.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.getByTestId("export-wizard-items")).toBeInTheDocument(),
    );
    expect(wizard().getByTestId("export-scale-line")).toHaveTextContent(
      "Export 3 items",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── the Apple status axis stays raw ───────────────────────────────────────

describe("Apple status is shown RAW, never translated", () => {
  it("the filter lists Apple's own tokens, not Available/Removed", () => {
    stubFetch();
    renderList();
    openWizard();

    const select = wizard().getByTestId("wizard-status-filter");
    expect(
      within(select).getByRole("option", {
        name: "DEVELOPER_REMOVED_FROM_SALE",
      }),
    ).toBeInTheDocument();
    // ⚠ If the two axes ever disagree, the Manager must SEE it. A friendly
    // word here would present Apple's status as this tool's availability
    // verdict and make the divergence invisible.
    expect(within(select).queryByRole("option", { name: /^Available$/i })).toBeNull();
    expect(within(select).queryByRole("option", { name: /^Removed$/i })).toBeNull();
    // Not title-cased either — the list page's stateLabel() is deliberately
    // not reused here.
    expect(
      within(select).queryByRole("option", {
        name: "Developer Removed From Sale",
      }),
    ).toBeNull();
  });

  it("the filter actually narrows the list", () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.change(wizard().getByTestId("wizard-status-filter"), {
      target: { value: "DEVELOPER_REMOVED_FROM_SALE" },
    });

    expect(wizard().getByRole("checkbox", { name: "Select com.x.c" })).toBeInTheDocument();
    expect(wizard().queryByRole("checkbox", { name: "Select com.x.a" })).toBeNull();
  });
});

// ─── selection honesty across the facet axis ───────────────────────────────

describe("a selection hidden by a facet is still counted", () => {
  it("says so, rather than letting the number silently drop", () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));
    expect(wizard().getByTestId("export-scale-line")).toHaveTextContent(
      "Export 3 items",
    );

    // Narrow to one type: two picks are now off-screen but still in the batch.
    fireEvent.change(wizard().getByTestId("wizard-type-filter"), {
      target: { value: "NON_CONSUMABLE" },
    });

    expect(wizard().getByTestId("facet-hidden-notice")).toHaveTextContent(
      "+ 2 more selected items are hidden",
    );
    // ⚠ And the batch itself did NOT shrink.
    expect(wizard().getByTestId("export-scale-line")).toHaveTextContent(
      "Export 3 items",
    );
  });
});

// ─── the scale line (§2.E) ─────────────────────────────────────────────────

describe("the scale line", () => {
  it("estimates 3 Apple requests per selected item, live", () => {
    stubFetch();
    renderList();
    openWizard();

    expect(wizard().getByTestId("export-scale-line")).toHaveTextContent(
      "Export 0 items · about 0 Apple requests",
    );

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select com.x.a" }));

    expect(wizard().getByTestId("export-scale-line")).toHaveTextContent(
      "Export 1 item · about 3 Apple requests",
    );
  });

  it("cautions above the threshold but never blocks", () => {
    stubFetch();
    // 100 items ⇒ 300 estimated requests, over the conservative 250 figure.
    renderList(Array.from({ length: 100 }, (_, i) => iap(`n${i}`)));
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));

    expect(wizard().getByTestId("export-scale-caution")).toHaveTextContent(
      "About 300 Apple requests",
    );
    // ⚠ Never a block — the Manager asked for stop-and-preserve.
    expect(wizard().getByTestId("wizard-continue")).not.toBeDisabled();
  });

  it("does not caution at a small selection", () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));

    expect(wizard().queryByTestId("export-scale-caution")).toBeNull();
  });
});

// ─── the payload ───────────────────────────────────────────────────────────

describe("the export payload carries exactly the ticked items", () => {
  it("posts the ticked Apple ids, not the rendered window and not the whole app", async () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select com.x.a" }));
    fireEvent.click(wizard().getByRole("checkbox", { name: "Select com.x.c" }));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/export");
    const body = JSON.parse(String(init.body)) as { selectedIds: string[] };
    expect([...body.selectedIds].sort()).toEqual(["apple-a", "apple-c"]);
  });

  it("carries a selection the search is hiding — narrowing is not unselecting", async () => {
    stubFetch();
    renderList();
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select com.x.a" }));
    fireEvent.change(wizard().getByTestId("wizard-type-filter"), {
      target: { value: "NON_CONSUMABLE" },
    });
    fireEvent.click(wizard().getByRole("checkbox", { name: "Select com.x.b" }));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { selectedIds: string[] };
    expect([...body.selectedIds].sort()).toEqual(["apple-a", "apple-b"]);
  });
});

// ─── the 2b guarantee, end to end ──────────────────────────────────────────

describe("items with no internal UUID are exportable from this page", () => {
  it("selects and posts them exactly like linked items", async () => {
    stubFetch();
    // Only `apple-a` is linked locally; the other two are Apple-only rows that
    // the availability modal would have excluded as "Not linked locally".
    renderList(IAPS, { "apple-a": "i-a" });
    openWizard();

    fireEvent.click(wizard().getByRole("checkbox", { name: "Select all" }));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(([u]) => String(u).includes("/export")),
      ).toBe(true),
    );
    const call = fetchSpy.mock.calls.find(([u]) =>
      String(u).includes("/export"),
    ) as [string, RequestInit];
    const body = JSON.parse(String(call[1].body)) as { selectedIds: string[] };
    expect([...body.selectedIds].sort()).toEqual([
      "apple-a",
      "apple-b",
      "apple-c",
    ]);
  });
});

// ─── the outcome copy (2f) ─────────────────────────────────────────────────

/** Drive the wizard all the way through to a finished export. */
async function runExport(pick: string[]) {
  openWizard();
  for (const p of pick) {
    fireEvent.click(wizard().getByRole("checkbox", { name: `Select ${p}` }));
  }
  fireEvent.click(wizard().getByTestId("wizard-continue"));
  await waitFor(() =>
    expect(screen.getByText("Export options")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));
  await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
}

describe("the toast names the denominator the operator asked for", () => {
  it("⚠ says 'X of M selected' — not a bare count that hides what is missing", async () => {
    // 3 picked, 2 came back, 1 refused. "Exported 2 items" is true and
    // useless; it hides the one that did not.
    stubFetch({ "X-Export-Item-Count": "2", "X-Export-Failed-Count": "1" });
    renderList();

    await runExport(["com.x.a", "com.x.b", "com.x.c"]);

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining("Exported 2 of 3 selected."),
        expect.anything(),
      ),
    );
  });

  it("a stopped run is warned, not celebrated, and still reports what landed", async () => {
    stubFetch({
      "X-Export-Item-Count": "2",
      "X-Export-Not-Attempted-Count": "1",
      "X-Export-Stopped": "rate_limit",
    });
    renderList();

    await runExport(["com.x.a", "com.x.b", "com.x.c"]);

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining("stopped on Apple's rate limit"),
        expect.anything(),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a clean run succeeds, with the selection denominator intact", async () => {
    stubFetch({ "X-Export-Item-Count": "2" });
    renderList();

    await runExport(["com.x.a", "com.x.b"]);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Exported 2 of 2 selected.",
        expect.anything(),
      ),
    );
  });
});

describe("the result panel appears only when a toast cannot carry it", () => {
  it("opens on a stopped run, naming the three outcomes separately", async () => {
    stubFetch({
      "X-Export-Item-Count": "2",
      "X-Export-Failed-Count": "1",
      "X-Export-Partial-Count": "1",
      "X-Export-Not-Attempted-Count": "3",
      "X-Export-Stopped": "rate_limit",
    });
    renderList();

    await runExport(["com.x.a", "com.x.b", "com.x.c"]);

    await waitFor(() =>
      expect(screen.getByTestId("export-result-summary")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("result-failed")).toHaveTextContent("1");
    expect(screen.getByTestId("result-not-attempted")).toHaveTextContent("3");
    expect(screen.getByTestId("result-partial")).toHaveTextContent("1");
    expect(screen.getByTestId("failure-sheet-pointer")).toHaveTextContent(
      "Export Failures",
    );
  });

  it("stays shut on a clean run — no dialog for nothing", async () => {
    stubFetch({ "X-Export-Item-Count": "2" });
    renderList();

    await runExport(["com.x.a", "com.x.b"]);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByTestId("export-result-summary")).toBeNull();
  });
  /**
   * ⚠ G5 WIRING — P26 AGAIN, PRE-EMPTED THIS TIME.
   *
   * `ExportResultSummary.test.tsx` proves the panel renders drift correctly
   * WHEN GIVEN it. It cannot prove the client reads the header, or — the part
   * that actually decides whether a Manager ever sees this — that the panel
   * OPENS AT ALL on a clean export. That condition is the load-bearing line:
   * drift arrives on runs where nothing failed, and every other trigger for
   * this panel is a failure.
   */
  it("⚠ drift opens the panel on an OTHERWISE CLEAN export, and names the codes", async () => {
    stubFetch({
      "X-Export-Item-Count": "2",
      "X-Export-Failed-Count": "0",
      "X-Export-Partial-Count": "0",
      "X-Export-Not-Attempted-Count": "0",
      "X-Export-Unknown-Territories": "ZZA ZZB",
    });
    renderList();
    // ⚠ Reuses the file's own `runExport` helper rather than re-driving the
    // wizard by hand — its `/^Export \d+ countr/` selector is scoped past the
    // toolbar's own "Export list" button, which a bare /^Export/ matches too.
    await runExport(["com.x.a", "com.x.b"]);

    // ⚠ Nothing failed. Before G5 this panel would not have opened at all and
    // the warning would have existed only in a Railway log.
    await waitFor(() =>
      expect(screen.getByTestId("export-result-summary")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("unknown-territories-codes")).toHaveTextContent(
      "ZZA, ZZB",
    );
  });

  it("⚠ VACUITY GUARD — a clean export with no drift opens nothing", async () => {
    // The other half: if the panel opened unconditionally, the test above
    // would pass while telling us nothing.
    stubFetch({ "X-Export-Item-Count": "2", "X-Export-Failed-Count": "0" });
    renderList();
    await runExport(["com.x.a", "com.x.b"]);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByTestId("export-result-summary")).not.toBeInTheDocument();
  });

});
