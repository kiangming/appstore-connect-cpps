// @vitest-environment jsdom
/**
 * A′ — the acceptance suite for "opening the modal reads nothing".
 *
 * ⚠ THE PRIMARY ASSERTION IS AN ABSENCE. Every SC6 test rendered the modal
 * with state already in hand, so none of them could observe that opening it
 * cost ~2 Apple requests per listed item. An assertion that a request was NOT
 * made is the only shape that fails when someone re-adds the pre-read — which
 * is exactly the regression this suite exists to catch.
 *
 * ⚠ The two all-or-nothing modes MUST still pre-read. Their list filter is BY
 * current availability (Manager decision 5) and there is no other source for
 * it. A "simplification" that drops the read for all three modes would break
 * them silently, so that is asserted here too, in the same file, deliberately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { __resetQueueForTests } from "@/lib/iap-management/client-fetch-queue";
import { AvailabilitiesBulkModal, type BulkMode } from "./AvailabilitiesBulkModal";
import type { InAppPurchase } from "@/types/iap-management/apple";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

const iap = (n: string): InAppPurchase =>
  ({
    id: `apple-${n}`,
    type: "inAppPurchases",
    attributes: {
      name: `Item ${n}`,
      productId: `com.x.${n}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_TO_SUBMIT",
    },
  }) as unknown as InAppPurchase;

const IAPS = [iap("a"), iap("b"), iap("c")];
const MAP = { "apple-a": "i-a", "apple-b": "i-b", "apple-c": "i-c" };

/** ⚠ The read phase runs 3 workers. With only 3 targets every one is claimed
 *  immediately, so a stop leaves NO remainder and proceeding straight to
 *  confirm is the correct behaviour. Proving stop-and-preserve therefore needs
 *  more targets than workers — 8 here. */
const BIG_N = 8;
const BIG_IAPS = Array.from({ length: BIG_N }, (_, i) => iap(`n${i}`));
const BIG_MAP = Object.fromEntries(
  BIG_IAPS.map((x, i) => [x.id, `i-n${i}`]),
) as Record<string, string>;

interface Call { url: string; method: string; body?: Record<string, unknown> }

/** `availabilityFor` lets a single item answer differently (429, failure). */
function stubFetch(opts?: {
  availabilityFor?: (internalId: string) => unknown;
  territories?: { territoryIds: string[]; error?: string };
}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    });
    if (url.includes("/api/iap-management/territories")) {
      return { ok: true, status: 200, json: async () => opts?.territories ?? { territoryIds: CATALOGUE } } as Response;
    }
    if (url.includes("/availability")) {
      const internalId = /iaps\/([^/]+)\/availability/.exec(url)?.[1] ?? "";
      const payload = opts?.availabilityFor?.(internalId) ?? {
        state: { territoryIds: ["USA"], territoryCount: 1, availableInNewTerritories: false },
      };
      return { ok: true, status: 200, json: async () => payload } as Response;
    }
    if (url.includes("hub-tracking")) {
      return { ok: true, status: 200, json: async () => ({ run_id: "run-1" }) } as Response;
    }
    if (url.includes("bulk-availability")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          total: 1, succeeded: 1, failed: 0, overall: "SUCCESS",
          summary: "1 updated",
          results: [{ iapId: "i-a", ok: true, status: "SUCCESS" }],
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

const availabilityCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("/availability"));
const writeCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("bulk-availability"));

function renderModal(
  mode: BulkMode = "set-territories",
  extra: Partial<React.ComponentProps<typeof AvailabilitiesBulkModal>> = {},
) {
  render(
    <AvailabilitiesBulkModal
      open
      mode={mode}
      iaps={IAPS}
      appleToInternal={MAP}
      baseTerritoryByAppleId={{}}
      onClose={vi.fn()}
      {...extra}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetQueueForTests();
});
afterEach(() => vi.unstubAllGlobals());

// ───────────────────────────────────────────────────────────────────────────
describe("⚠ A′ ACCEPTANCE — opening the modal costs ZERO Apple reads", () => {
  it("set-territories: NO /availability request is made on open", async () => {
    const { calls } = stubFetch();
    renderModal("set-territories");

    // Wait for the modal to be fully settled — the catalogue HAS loaded and
    // the list has rendered, so "nothing happened yet" is not the explanation.
    await waitFor(() =>
      expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());

    // ⚠ MUTATION TARGET. Remove the `mode === "set-territories"` early-return
    // from the pre-read effect and this goes red with 3 calls.
    expect(availabilityCalls(calls)).toHaveLength(0);
  });

  it("every listed item is shown and selectable without any state being read", async () => {
    const { calls } = stubFetch();
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());
    expect(screen.getByLabelText("Select com.x.b")).toBeInTheDocument();
    expect(screen.getByLabelText("Select com.x.c")).toBeInTheDocument();
    expect(availabilityCalls(calls)).toHaveLength(0);
  });

  it("⚠ rows show no availability badge — nothing has been read, so nothing is claimed", async () => {
    stubFetch();
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());
    // The old code stamped "Removed" on every row via a binary
    // `destructive ? Available : Removed`, which in this mode is a state claim
    // about data the modal does not have.
    expect(screen.getByTestId("row-state-unread-apple-a")).toBeInTheDocument();
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
  });

  it.each(["set-all", "remove"] as const)(
    "⚠ %s STILL pre-reads — decision 5's filter has no other source",
    async (mode) => {
      const { calls } = stubFetch();
      renderModal(mode);
      await waitFor(() => expect(availabilityCalls(calls)).toHaveLength(3));
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
describe("the read happens for the SELECTION, at confirm", () => {
  it("reads only the selected items — not the whole list", async () => {
    const { calls } = stubFetch();
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select com.x.a"));
    expect(availabilityCalls(calls)).toHaveLength(0); // selecting reads nothing

    fireEvent.click(screen.getByRole("button", { name: /^Continue — read/ }));
    await waitFor(() => expect(screen.getByTestId("confirm-headline")).toBeInTheDocument());

    const read = availabilityCalls(calls);
    expect(read).toHaveLength(1);
    expect(read[0].url).toContain("/iaps/i-a/availability");
  });

  it("the button names the scale before it is spent", async () => {
    stubFetch();
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select com.x.a"));
    fireEvent.click(screen.getByLabelText("Select com.x.b"));
    expect(
      screen.getByRole("button", { name: /^Continue — read 2 items/ }),
    ).toBeInTheDocument();
  });

  it("selecting 1 of 3 costs 1 read — the cost tracks the ask, not the catalogue", async () => {
    const { calls } = stubFetch();
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select com.x.b"));
    fireEvent.click(screen.getByRole("button", { name: /^Continue — read/ }));
    await waitFor(() => expect(screen.getByTestId("confirm-headline")).toBeInTheDocument());
    expect(availabilityCalls(calls)).toHaveLength(1);
    expect(writeCalls(calls)).toHaveLength(0); // still nothing written
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the three confirm buckets stay apart", () => {
  it("will-change / already-matches / could-not-read are three distinct sections", async () => {
    const { calls } = stubFetch({
      availabilityFor: (id) => {
        // i-a already holds exactly the default (ALL + forward flag) → matches
        if (id === "i-a") {
          return { state: { territoryIds: CATALOGUE, territoryCount: CATALOGUE.length, availableInNewTerritories: true } };
        }
        // i-b holds a subset → will change
        if (id === "i-b") {
          return { state: { territoryIds: ["USA"], territoryCount: 1, availableInNewTerritories: false } };
        }
        // i-c cannot be read → excluded and NAMED
        return { state: null, error: "fetch_failed", reason: "boom" };
      },
    });
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select all"));
    fireEvent.click(screen.getByRole("button", { name: /^Continue — read/ }));
    await waitFor(() => expect(screen.getByTestId("confirm-headline")).toBeInTheDocument());

    // ⚠ MUTATION TARGET: fold alreadyMatches into "no change" and this dies.
    expect(screen.getByTestId("confirm-will-change")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-change-apple-b")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-already-matches")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-unknown-excluded")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-unknown-apple-c")).toBeInTheDocument();

    expect(availabilityCalls(calls)).toHaveLength(3);
  });

  it("⚠ an unreadable item is EXCLUDED from the write; a no-op item is still sent", async () => {
    const { calls } = stubFetch({
      availabilityFor: (id) =>
        id === "i-c"
          ? { state: null, error: "fetch_failed", reason: "boom" }
          : id === "i-a"
            ? { state: { territoryIds: CATALOGUE, territoryCount: CATALOGUE.length, availableInNewTerritories: true } }
            : { state: { territoryIds: ["USA"], territoryCount: 1, availableInNewTerritories: false } },
    });
    renderModal("set-territories");
    await waitFor(() => expect(screen.getByLabelText("Select com.x.a")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all"));
    fireEvent.click(screen.getByRole("button", { name: /^Continue — read/ }));
    await waitFor(() => expect(screen.getByTestId("confirm-submit")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("confirm-submit"));

    await waitFor(() => expect(writeCalls(calls)).toHaveLength(1));
    const body = writeCalls(calls)[0].body as { iapIds: string[] };
    // i-b changes, i-a is a no-op but REPLACE semantics still send it
    // (decision 1); i-c was unreadable and must NOT be written blind.
    expect(body.iapIds.sort()).toEqual(["i-a", "i-b"]);
    expect(body.iapIds).not.toContain("i-c");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("⚠ decision 3 on the READ — stop, preserve, retry only the remainder", () => {
  /** Throttles the Nth read; everything else succeeds. */
  function throttleOnCall(n: number) {
    let seen = 0;
    return stubFetch({
      availabilityFor: () => {
        seen += 1;
        return seen === n
          ? { state: null, error: "rate_limited" }
          : {
              state: {
                territoryIds: ["USA"],
                territoryCount: 1,
                availableInNewTerritories: false,
              },
            };
      },
    });
  }

  async function selectAllAndRead() {
    await waitFor(() =>
      expect(screen.getByLabelText("Select com.x.n0")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText("Select all"));
    fireEvent.click(screen.getByRole("button", { name: /^Continue — read/ }));
  }

  /** The remainder count, read off the button the Manager actually sees. */
  function remainingFromButton(): number {
    const label = screen.getByTestId("read-stopped-retry").textContent ?? "";
    return Number(/Retry the remaining (\d+)/.exec(label)?.[1]);
  }

  it("a rate limit stops the read and offers the preserved remainder", async () => {
    const { calls } = throttleOnCall(1);
    renderModal("set-territories", { iaps: BIG_IAPS, appleToInternal: BIG_MAP });
    await selectAllAndRead();

    await waitFor(() =>
      expect(screen.getByTestId("read-phase-stopped")).toBeInTheDocument(),
    );
    // ⚠ MUTATION TARGET: continue past the 429 instead of stopping, and the
    // remainder disappears — all 8 get read and this never renders.
    expect(remainingFromButton()).toBeGreaterThan(0);
    expect(availabilityCalls(calls).length).toBeLessThan(BIG_N);

    // Nothing written, and confirm never opened on a partial picture.
    expect(writeCalls(calls)).toHaveLength(0);
    expect(screen.queryByTestId("confirm-headline")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-stopped-continue")).toBeInTheDocument();
  });

  it("retry re-reads ONLY the preserved remainder — never what already resolved", async () => {
    const { calls } = throttleOnCall(1);
    renderModal("set-territories", { iaps: BIG_IAPS, appleToInternal: BIG_MAP });
    await selectAllAndRead();
    await waitFor(() =>
      expect(screen.getByTestId("read-phase-stopped")).toBeInTheDocument(),
    );

    const before = availabilityCalls(calls).length;
    const remaining = remainingFromButton();
    fireEvent.click(screen.getByTestId("read-stopped-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-headline")).toBeInTheDocument(),
    );

    // Exactly the remainder — not a re-read of the whole selection, and not a
    // re-send of the item Apple already refused (it was ASKED; SC3's rule).
    expect(availabilityCalls(calls).length - before).toBe(remaining);
    expect(availabilityCalls(calls).length).toBe(BIG_N);
  });

  it("'continue with what we read' proceeds on the subset and NAMES the excluded", async () => {
    throttleOnCall(1);
    renderModal("set-territories", { iaps: BIG_IAPS, appleToInternal: BIG_MAP });
    await selectAllAndRead();
    await waitFor(() =>
      expect(screen.getByTestId("read-phase-stopped")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("read-stopped-continue"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-headline")).toBeInTheDocument(),
    );
    // The throttled item is named as excluded rather than silently dropped.
    expect(screen.getByTestId("confirm-unknown-excluded")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("⚠ the silent drop, now visible", () => {
  const DRAFTS = [
    { id: "d-1", product_id: "com.x.draft", reference_name: "Draft One" },
  ];

  it.each(["set-territories", "set-all", "remove"] as const)(
    "%s: a local draft is SHOWN, disabled, and says why",
    async (mode) => {
      stubFetch();
      renderModal(mode, { drafts: DRAFTS });

      await waitFor(() =>
        expect(screen.getByTestId("excluded-row-draft:d-1")).toBeInTheDocument(),
      );
      // Shown — not hidden. A Manager who cannot find an item assumes deletion.
      const row = screen.getByTestId("excluded-row-draft:d-1");
      expect(within(row).getByText("com.x.draft")).toBeInTheDocument();
      // Disabled, with the reason reachable from the control itself.
      const box = within(row).getByRole("checkbox") as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.getAttribute("aria-label")).toMatch(/not on Apple yet/i);
      expect(screen.getByTestId("excluded-group-local_draft")).toBeInTheDocument();
    },
  );

  it("an Apple item with no local link is shown with ITS reason, not the draft's", async () => {
    stubFetch();
    renderModal("set-territories", {
      // apple-c deliberately missing from the map — the `seedMissingIapStubs`
      // silent-catch case, which used to make rows vanish with no trace.
      appleToInternal: { "apple-a": "i-a", "apple-b": "i-b" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("excluded-row-apple-c")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("excluded-group-not_linked")).toBeInTheDocument();
    const box = within(screen.getByTestId("excluded-row-apple-c")).getByRole(
      "checkbox",
    ) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-label")).toMatch(/not linked locally/i);
    // ⚠ Two disabled classes, NOT one bucket: the fixes differ (Refresh from
    // Apple vs. create the draft on Apple).
    expect(
      screen.queryByTestId("excluded-group-local_draft"),
    ).not.toBeInTheDocument();
  });

  it("⚠ a rate-limited row is shown with the RATE LIMIT as its reason, not an availability verdict", async () => {
    stubFetch({ availabilityFor: () => ({ state: null, error: "rate_limited" }) });
    renderModal("set-all");

    await waitFor(() =>
      expect(
        screen.getByTestId("excluded-group-read_rate_limited"),
      ).toBeInTheDocument(),
    );
    const group = screen.getByTestId("excluded-group-read_rate_limited");
    expect(within(group).getByText(/rate-limited/i)).toBeInTheDocument();
    // The old behaviour dropped these rows entirely and blamed availability.
    expect(screen.getByTestId("excluded-row-apple-a")).toBeInTheDocument();
    expect(screen.getByTestId("excluded-row-apple-b")).toBeInTheDocument();
    expect(screen.getByTestId("excluded-row-apple-c")).toBeInTheDocument();
  });
});

describe("⚠ the empty state names the REAL cause", () => {
  it("all reads throttled ⇒ 'could not be read', NOT 'already sells everywhere'", async () => {
    stubFetch({ availabilityFor: () => ({ state: null, error: "rate_limited" }) });
    renderModal("set-all");

    await waitFor(() =>
      expect(
        screen.getByTestId("nothing-selectable-all_excluded_unreadable"),
      ).toBeInTheDocument(),
    );
    // ⚠ MUTATION TARGET: collapse emptyCause's two branches and this flips to
    // the clean-bucket copy — the exact lie the UAT report surfaced.
    expect(
      screen.queryByText(/already sells in all territories/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/could not be read from Apple/i),
    ).toBeInTheDocument();
  });

  it("all reads succeeded but none qualified ⇒ the ordinary 'not eligible' copy", async () => {
    // Every item already available ⇒ set-all has nothing to enable, honestly.
    stubFetch({
      availabilityFor: () => ({
        state: { territoryIds: CATALOGUE, territoryCount: CATALOGUE.length, availableInNewTerritories: true },
      }),
    });
    renderModal("set-all");

    await waitFor(() =>
      expect(
        screen.getByTestId("nothing-selectable-all_excluded_other"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("nothing-selectable-all_excluded_unreadable"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("excluded-group-not_in_bucket")).toBeInTheDocument();
  });
});
