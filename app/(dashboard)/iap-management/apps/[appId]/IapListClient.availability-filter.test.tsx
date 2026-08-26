// @vitest-environment jsdom
/**
 * [EXPORT-availability-filter] C6 — the availability facet, at the page layer.
 *
 * MUTATION (b): changing the availability filter must issue NO fetch. The
 * whole premise of `[Q-EXPORT-avail.mirror]` is that filtering reads the local
 * mirror, so a facet that reached Apple would quietly reintroduce the ~2N cost
 * the mirror exists to remove — and every lower test would stay green, because
 * none of them opens the wizard (design §2.I.1).
 *
 * MUTATION (c): the raw Apple-status control must survive alongside it. Two
 * axes, both visible. U3 measured `state` and real availability agreeing on
 * 35/35 items, and the tool's own API-driven removal is still untested — so
 * the day they disagree, the Manager has to be able to SEE it rather than get
 * one control that silently picked a side.
 *
 * ⚠ Same spy discipline as the sibling export-wizard suite: `fetch` itself,
 * scoped by TIME from the moment the wizard opens. An allowlist would pass a
 * version that fetched availability on open, which is the exact regression
 * this guards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { IapListClient } from "./IapListClient";
import type { InAppPurchase } from "@/types/iap-management/apple";
import type { AvailabilityMirrorByAppleId } from "@/lib/iap-management/apple/availability-as-of";

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

const iap = (n: string, state = "APPROVED"): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: "CONSUMABLE",
      state,
    },
  }) as unknown as InAppPurchase;

/**
 * Three items, one per bucket — and item `c` is the interesting one: Apple
 * says APPROVED while the mirror says REMOVED. That combination is the U3
 * residual made concrete, and it is why both columns exist.
 */
const IAPS = [iap("a"), iap("b", "DEVELOPER_REMOVED_FROM_SALE"), iap("c")];

const MIRROR: AvailabilityMirrorByAppleId = {
  "apple-a": { state: "AVAILABLE", territoryCount: 175, syncedAt: "2026-08-26T10:00:00Z" },
  "apple-c": { state: "REMOVED", territoryCount: 0, syncedAt: "2026-08-26T10:00:00Z" },
  // ⚠ `apple-b` is deliberately ABSENT — never synced, i.e. Unknown.
};

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

/** ⚠ `appleToInternal` stays empty so the page's own `AvailabilityCell`
 *  fetches never land inside the spy window — the same reason the sibling
 *  suite does it. Export selectability does not depend on it (design §2.G). */
function renderList(mirror: AvailabilityMirrorByAppleId = MIRROR) {
  render(
    <IapListClient
      appId="123"
      appName="App"
      appBundleId="com.x"
      iaps={IAPS}
      drafts={[]}
      appleToInternal={{}}
      baseTerritoryByAppleId={{}}
      availabilityByAppleId={mirror}
    />,
  );
}

function openWizard() {
  fetchSpy.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Export list/i }));
}

function wizard() {
  return within(screen.getByTestId("export-wizard-items"));
}

function setAvailability(value: string) {
  fireEvent.change(screen.getByTestId("wizard-availability-filter"), {
    target: { value },
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ─── MUTATION (b) — the filter is free ─────────────────────────────────────

describe("⚠ MUTATION (b) — changing the availability filter issues NO fetch", () => {
  it.each(["AVAILABLE", "REMOVED", "UNKNOWN", "ALL"])(
    "selecting %s costs zero requests",
    (value) => {
      stubFetch();
      renderList();
      openWizard();
      setAvailability(value);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("cycling every value in sequence still costs zero", () => {
    stubFetch();
    renderList();
    openWizard();
    for (const v of ["AVAILABLE", "REMOVED", "UNKNOWN", "ALL", "AVAILABLE"]) {
      setAvailability(v);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("combining it with the Type and Apple-status facets still costs zero", () => {
    stubFetch();
    renderList();
    openWizard();
    setAvailability("AVAILABLE");
    fireEvent.change(screen.getByTestId("wizard-type-filter"), {
      target: { value: "CONSUMABLE" },
    });
    fireEvent.change(screen.getByTestId("wizard-status-filter"), {
      target: { value: "APPROVED" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── MUTATION (a) at the UI layer — Unknown never counts as Available ───────

describe("⚠ the filter actually narrows, and Unknown is never folded into Available", () => {
  it("Available shows only the mirror-confirmed available item", () => {
    stubFetch();
    renderList();
    openWizard();
    setAvailability("AVAILABLE");
    expect(wizard().getByText("com.x.a")).toBeTruthy();
    expect(wizard().queryByText("com.x.c")).toBeNull();
    // ⚠ THE MUTATION. `apple-b` has never been synced. A default-to-available
    //   would put it here, and the Manager would export an item nobody has
    //   checked as though it were confirmed on sale.
    expect(wizard().queryByText("com.x.b")).toBeNull();
  });

  it("Removed shows only the mirror-confirmed removed item — not the unsynced one", () => {
    stubFetch();
    renderList();
    openWizard();
    setAvailability("REMOVED");
    expect(wizard().getByText("com.x.c")).toBeTruthy();
    expect(wizard().queryByText("com.x.a")).toBeNull();
    expect(wizard().queryByText("com.x.b")).toBeNull();
  });

  it("Unknown surfaces exactly the never-synced item", () => {
    stubFetch();
    renderList();
    openWizard();
    setAvailability("UNKNOWN");
    expect(wizard().getByText("com.x.b")).toBeTruthy();
    expect(wizard().queryByText("com.x.a")).toBeNull();
    expect(wizard().queryByText("com.x.c")).toBeNull();
  });

  it("⚠ with an EMPTY mirror, Available is empty — not everything", () => {
    // The first-run state of any app nobody has swept. Degrading "we know
    // nothing" into "everything is available" is the whole defect class.
    stubFetch();
    renderList({});
    openWizard();
    setAvailability("AVAILABLE");
    expect(wizard().queryByText("com.x.a")).toBeNull();
    expect(wizard().queryByText("com.x.b")).toBeNull();
    expect(wizard().queryByText("com.x.c")).toBeNull();
    expect(wizard().getByTestId("wizard-nothing-selectable")).toBeTruthy();
  });
});

// ─── MUTATION (c) — the raw state axis survives ────────────────────────────

describe("⚠ MUTATION (c) — the raw Apple-status control is still there, still raw", () => {
  it("both facets render — availability did not replace status", () => {
    stubFetch();
    renderList();
    openWizard();
    expect(screen.getByTestId("wizard-status-filter")).toBeTruthy();
    expect(screen.getByTestId("wizard-availability-filter")).toBeTruthy();
  });

  it("the status control still lists Apple's own tokens, untranslated", () => {
    stubFetch();
    renderList();
    openWizard();
    const options = within(screen.getByTestId("wizard-status-filter")).getAllByRole(
      "option",
    );
    const values = options.map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain("DEVELOPER_REMOVED_FROM_SALE");
    // ⚠ Not "Removed", not "Developer Removed From Sale". The raw token is
    //   load-bearing here: it is what keeps a state/availability divergence
    //   legible instead of pre-resolved.
    expect(values).not.toContain("Removed");
  });

  it("⚠ EVERY ROW SHOWS BOTH AXES — the divergence is visible per item", () => {
    stubFetch();
    renderList();
    openWizard();
    // Item `c`: Apple says APPROVED, the mirror says REMOVED. Both on screen.
    expect(wizard().getByTestId("row-status-apple-c").textContent).toBe("APPROVED");
    expect(wizard().getByTestId("row-availability-apple-c").textContent).toBe("Removed");
  });

  it("an unsynced row reads Unknown on the availability axis, whatever Apple says", () => {
    stubFetch();
    renderList();
    openWizard();
    expect(wizard().getByTestId("row-status-apple-b").textContent).toBe(
      "DEVELOPER_REMOVED_FROM_SALE",
    );
    expect(wizard().getByTestId("row-availability-apple-b").textContent).toBe("Unknown");
  });
});

// ─── The as-of label, on both surfaces ─────────────────────────────────────

describe("the wizard dates the data it filters on", () => {
  it("renders an as-of line naming the unsynced count", () => {
    stubFetch();
    renderList();
    openWizard();
    const line = screen.getByTestId("wizard-availability-as-of").textContent ?? "";
    expect(line).toContain("Availability as of");
    expect(line).toContain("1 never synced (Unknown)");
  });

  it("⚠ with nothing synced it says so instead of claiming a date", () => {
    stubFetch();
    renderList({});
    openWizard();
    const line = screen.getByTestId("wizard-availability-as-of").textContent ?? "";
    expect(line).toContain("Availability never synced");
    expect(line).not.toContain("as of");
  });
});

describe("the LIST page dates its Availabilities column the same way", () => {
  it("renders the shared as-of label", () => {
    // ⚠ One `asOfLabel`, two surfaces — so the list and the wizard cannot
    //   describe the same mirror differently, which is the divergence the
    //   census was opened over.
    stubFetch();
    renderList();
    const line = screen.getByTestId("list-availability-as-of").textContent ?? "";
    expect(line).toContain("Availability as of");
    expect(line).toContain("1 never synced (Unknown)");
  });
});

// ─── Selection accounting across the new axis ──────────────────────────────

describe("a selection hidden by the AVAILABILITY facet is still counted", () => {
  it("⚠ says so, rather than letting the number silently drop", () => {
    // The facet axis's own `selectedHidden`. Without it, ticking an item and
    // then narrowing availability looks like the tool discarding the pick.
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(wizard().getByLabelText("Select com.x.a"));
    setAvailability("REMOVED");
    expect(wizard().getByTestId("facet-hidden-notice")).toHaveTextContent(
      "+ 1 more selected item is hidden",
    );
  });

  it("and the hidden pick is still in the exported batch", async () => {
    stubFetch();
    renderList();
    openWizard();
    fireEvent.click(wizard().getByLabelText("Select com.x.a"));
    setAvailability("REMOVED");
    fireEvent.click(wizard().getByLabelText("Select com.x.c"));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const exportCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/export"),
    );
    const body = JSON.parse(String((exportCall![1] as RequestInit).body));
    expect(body.selectedIds.sort()).toEqual(["apple-a", "apple-c"]);
  });
});
