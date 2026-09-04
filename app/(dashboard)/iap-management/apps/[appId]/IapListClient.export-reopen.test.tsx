// @vitest-environment jsdom
/**
 * [Y3] REOPENING THE EXPORT WIZARD — the defect census found and NO test covered.
 *
 * ⚠ THE GAP WAS THE ASSERTION, NOT THE LOGIC. `grep -i reopen` over
 * `IapListClient.export-wizard.test.tsx` returned nothing: every test there
 * opens the wizard once and drives it forward. Nothing ever closed it and
 * opened it again, so nothing could notice that `step` survived the close and
 * the second open landed on step 2 with the old ticks intact.
 *
 * That is why the fix ships with these tests rather than as three lines: the
 * three lines are easy, the reason it lived for a whole cycle is that no test
 * ever performed the gesture.
 *
 * ⚠ AND THE FIX IS KEYED ON OPENING, NOT ON CLOSING. The tests below therefore
 * exercise BOTH exits — Cancel (which already reset) and a completed export
 * (which did not) — because a fix that only covered the broken exit would pass
 * a test written only against the broken exit.
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

const iap = (n: string): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "APPROVED",
    },
  }) as unknown as InAppPurchase;

const IAPS = [iap("a"), iap("b"), iap("c")];

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

const openBtn = () => screen.getByRole("button", { name: /Export list/i });
const wizard = () => within(screen.getByTestId("export-wizard-items"));
const cb = (productId: string) =>
  wizard().getByRole("checkbox", { name: `Select ${productId}` });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("⚠ after a COMPLETED export, reopening starts over at step 1", () => {
  /**
   * ⚠ MUTATION: delete the `if (open) reset()` effect. This goes red — the
   * second open renders "Export options" (step 2) and
   * `export-wizard-items` (step 1) is not in the document at all.
   */
  it("reopens on STEP 1, not on the country step", async () => {
    stubFetch();
    renderList();

    fireEvent.click(openBtn());
    fireEvent.click(cb("com.x.a"));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // The wizard closed itself.
    await waitFor(() =>
      expect(screen.queryByTestId("export-wizard-items")).toBeNull(),
    );

    fireEvent.click(openBtn());
    expect(screen.getByTestId("export-wizard-items")).toBeInTheDocument();
    expect(screen.queryByText("Export options")).toBeNull();
  });

  /**
   * ⚠ AND THE SELECTION IS GONE. Carrying it over is the expensive half of the
   * defect: the Manager would be one click from re-billing ~3 requests per
   * item they picked for the PREVIOUS export.
   */
  it("reopens with NOTHING ticked — the previous export's picks do not carry over", async () => {
    stubFetch();
    renderList();

    fireEvent.click(openBtn());
    fireEvent.click(cb("com.x.a"));
    fireEvent.click(cb("com.x.b"));
    expect(wizard().getByTestId("export-scale-line").textContent).toContain(
      "Export 2 items",
    );
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Export \d+ countr/ }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    fireEvent.click(openBtn());
    expect(wizard().getByTestId("export-scale-line").textContent).toContain(
      "Export 0 items",
    );
    expect((cb("com.x.a") as HTMLInputElement).checked).toBe(false);
    expect((cb("com.x.b") as HTMLInputElement).checked).toBe(false);
    expect(wizard().getByTestId("wizard-continue")).toBeDisabled();
  });
});

describe("the OTHER exits reset too — the fix is keyed on opening, not on closing", () => {
  it("Cancel then reopen: step 1, nothing ticked", () => {
    stubFetch();
    renderList();
    fireEvent.click(openBtn());
    fireEvent.click(cb("com.x.a"));
    fireEvent.click(wizard().getByRole("button", { name: "Cancel" }));
    fireEvent.click(openBtn());
    expect((cb("com.x.a") as HTMLInputElement).checked).toBe(false);
  });

  it("✕ then reopen: step 1, nothing ticked", () => {
    stubFetch();
    renderList();
    fireEvent.click(openBtn());
    fireEvent.click(cb("com.x.a"));
    fireEvent.click(wizard().getByLabelText("Close"));
    fireEvent.click(openBtn());
    expect((cb("com.x.a") as HTMLInputElement).checked).toBe(false);
  });

  /**
   * ⚠ Closed from STEP 2 — the exit that produced the bug. Cancelling on the
   * country step is "Back" (it returns to step 1), so this closes from step 2
   * via the export itself; covered above. Here the guard is that a reopen
   * after reaching step 2 and going BACK is still a clean step 1.
   */
  it("reached step 2, went Back, cancelled, reopened: clean step 1", async () => {
    stubFetch();
    renderList();
    fireEvent.click(openBtn());
    fireEvent.click(cb("com.x.c"));
    fireEvent.click(wizard().getByTestId("wizard-continue"));
    await waitFor(() =>
      expect(screen.getByText("Export options")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ })); // = Back
    await waitFor(() =>
      expect(screen.getByTestId("export-wizard-items")).toBeInTheDocument(),
    );
    // Back preserves the selection — that is existing, pinned behaviour.
    expect((cb("com.x.c") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(wizard().getByRole("button", { name: "Cancel" }));
    fireEvent.click(openBtn());
    expect((cb("com.x.c") as HTMLInputElement).checked).toBe(false);
  });
});

describe("⚠ reopening does NOT cost an Apple request", () => {
  it("close and reopen issue no fetch", () => {
    stubFetch();
    renderList();
    fireEvent.click(openBtn());
    fetchSpy.mockClear();
    fireEvent.click(wizard().getByRole("button", { name: "Cancel" }));
    fireEvent.click(openBtn());
    fireEvent.click(wizard().getByRole("button", { name: "Cancel" }));
    fireEvent.click(openBtn());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
