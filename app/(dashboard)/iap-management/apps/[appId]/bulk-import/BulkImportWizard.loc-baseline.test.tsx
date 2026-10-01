// @vitest-environment jsdom
/**
 * `[BULKIMPORT-loc-compare-apple]` C3 — reading Apple at the Localization step.
 *
 * ⚠ THE GATE OF THIS CHUNK IS THE **EXPLICIT SEED**, and it is a wizard-level
 * property by nature. `isTicked` (client) and `applyLocalizationSelection`
 * (server) both read "item absent from `selected`" as *process everything*.
 * That rule was written when the default was tick-all. Now that the default is
 * computed, an item merely ABSENT renders unticked while the server writes all
 * of it — and the only place that divergence is observable is the POST body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const parseIapItemsXlsx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/parsers/iap-items", () => ({ parseIapItemsXlsx }));

import { BulkImportWizard } from "./BulkImportWizard";
import { __resetQueueForTests } from "@/lib/iap-management/client-fetch-queue";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";

/**
 * ⚠ THESE TESTS DRIVE THE WHOLE WIZARD — file drop → 3 × Next → a gated Apple
 * read → confirm dialog → Territories → execute — inside jsdom. Vitest's 5s
 * default is comfortable alone and marginal when another heavy DOM file runs
 * beside it, which is a property of the HARNESS, not of the product. Stating a
 * budget is honest; leaving a known-marginal test to fail sometimes is how a
 * suite stops meaning anything.
 */
const SLOW = 20_000;

const EMPTY_TIERS: Record<PricingSourceKind, UsdTierEntry[]> = {
  APPLE: [], DEFAULT_TEMPLATE: [], APP_TEMPLATE: [],
};

const PID = "com.vng.nikki.pack199ak";
const APPLE_ID = "apple-iap-1";

const loc = (locale: string, locale_name: string, display_name: string, description: string) =>
  ({ locale, locale_name, display_name, description });

function parsed(localizations = [
  loc("vi", "Vietnamese", "188 Vàng", "Gói 188 Vàng"),
  loc("en-US", "English (U.S.)", "188 Gold", "188 Gold pack"),
]) {
  return {
    items: [{
      row_index: 1, product_id: PID, reference_name: "Item box ingame",
      type: "CONSUMABLE" as const, type_source: "DEFAULT" as const,
      price_usd: 0, base_price: 0, base_currency: "USD",
      localizations, warnings: [],
    }],
    skipped_locales: [], locale_pair_count: localizations.length,
    warnings: [], sample_rows_skipped: [],
  };
}

interface Harness {
  posted: Array<Record<string, unknown>>;
  baselineCalls: string[];
}

/** `baseline` decides what the baseline route answers. */
function installFetch(baseline: () => unknown): Harness {
  const posted: Array<Record<string, unknown>> = [];
  const baselineCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/localization-baseline")) {
        baselineCalls.push(u);
        const body = baseline();
        if (body === null) throw new Error("network down");
        return { ok: true, status: 200, json: async () => body } as Response;
      }
      if (u.includes("/api/iap-management/territories")) {
        return { ok: true, status: 200, json: async () => ({ territoryIds: ["USA"] }) } as Response;
      }
      if (u.includes("/bulk-import/execute")) {
        const raw = (init?.body as FormData)?.get?.("config");
        if (typeof raw === "string") posted.push(JSON.parse(raw));
        return {
          ok: true, status: 200,
          json: async () => ({ batch_id: "b", counts: { created: 0, overwritten: 1, skipped: 0, errored: 0 }, results: [] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    }),
  );
  return { posted, baselineCalls };
}

const READABLE = (approved: ReturnType<typeof row>[], draft: ReturnType<typeof row>[] = [], hasDraft = draft.length > 0) =>
  ({ readable: true, approved, draft, hasApproved: true, hasDraft });
const row = (id: string, locale: string, name: string, description: string) =>
  ({ id, locale, name, description });

function renderWizard(opts: { existing?: string[]; map?: Record<string, string> } = {}) {
  return render(
    <BulkImportWizard
      appId="123"
      appName="App"
      existingProductIds={opts.existing ?? [PID]}
      appleIapIdByProductId={opts.map ?? { [PID]: APPLE_ID }}
      usdTiersBySource={EMPTY_TIERS}
    />,
  ).container;
}

async function dropExcel(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [new File(["x"], "items.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
  });
  fireEvent.change(input);
  await waitFor(() => expect(parseIapItemsXlsx).toHaveBeenCalled());
}

async function next() {
  await waitFor(() => expect(screen.getByRole("button", { name: /Next/ })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
}

async function goToLocalization(container: HTMLElement) {
  await dropExcel(container);
  for (let i = 0; i < 3; i++) await next();
  await waitFor(() => expect(screen.getByTestId("localization-step")).toBeInTheDocument());
}

/** Walk out of step 4 through the confirm dialog, then execute, and read the POST. */
async function executeAndReadConfig(h: Harness) {
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  const ok = screen.queryByTestId("localization-confirm-ok");
  if (ok) fireEvent.click(ok);
  await waitFor(() =>
    expect(screen.getByTestId("territory-picker-footer")).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /Execute|Import/i }));
  await waitFor(() => expect(h.posted.length).toBeGreaterThan(0));
  return h.posted[0].localization_selection as { ignore_all: boolean; selected: Record<string, string[]> };
}

beforeEach(() => {
  __resetQueueForTests();
  parseIapItemsXlsx.mockReset().mockResolvedValue(parsed());
});
afterEach(() => vi.unstubAllGlobals());

describe("⭐⭐ GATE — the selection is seeded EXPLICITLY, never left to 'absent means all'", () => {
  it("every processed item with localizations gets an explicit entry in `selected`", async () => {
    // The gate assertion. Without it an item whose cells all compute to
    // UNTICK would be absent, render unticked, and be written in full.
    const h = installFetch(() =>
      READABLE([row("a-vi", "vi", "188 Vàng", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")]),
    );
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls.length).toBe(1));

    const sel = await executeAndReadConfig(h);
    expect(Object.keys(sel.selected)).toContain(PID);
    // both locales match Apple exactly ⇒ nothing to write ⇒ EMPTY, explicitly
    expect(sel.selected[PID]).toEqual([]);
  }, SLOW);

  it("⭐ the Manager's case: import 88-style file that matches Apple ⇒ zero cells ticked", async () => {
    const h = installFetch(() =>
      READABLE([row("a-vi", "vi", "188 Vàng", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")]),
    );
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls.length).toBe(1));
    const boxes = Array.from(c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    await waitFor(() => {
      const cells = boxes.filter((b) => b.checked);
      expect(cells.length).toBe(0);
    });
  }, SLOW);

  it("a locale that genuinely differs stays TICKED", async () => {
    const h = installFetch(() =>
      READABLE([row("a-vi", "vi", "CŨ", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")]),
    );
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls.length).toBe(1));
    const sel = await executeAndReadConfig(h);
    expect(sel.selected[PID]).toEqual(["vi"]);
  }, SLOW);
});

describe("⚠⚠ an unreadable item UNTICKS — it is not 'chưa có trên Apple'", () => {
  it("readable:false ⇒ no cell ticked, and the item is NAMED", async () => {
    const h = installFetch(() => ({
      readable: false, approved: [], draft: [], hasApproved: false, hasDraft: false,
    }));
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls.length).toBe(1));
    await screen.findByTestId("localization-baseline-unreadable");
    const sel = await executeAndReadConfig(h);
    // ⚠ EMPTY, not both locales. "Apple has nothing" would have ticked both.
    expect(sel.selected[PID]).toEqual([]);
  }, SLOW);

  it("a thrown fetch lands on the same UNTICK, and the step is still navigable", async () => {
    const h = installFetch(() => null); // throws
    const c = renderWizard();
    await goToLocalization(c);
    await screen.findByTestId("localization-baseline-unreadable");
    const sel = await executeAndReadConfig(h);
    expect(sel.selected[PID]).toEqual([]);
  }, SLOW);

  it("an item with NO appleIapId is unreadable — never a guessed id", async () => {
    const h = installFetch(() => READABLE([]));
    const c = renderWizard({ map: {} });
    await goToLocalization(c);
    await screen.findByTestId("localization-baseline-unreadable");
    expect(h.baselineCalls).toHaveLength(0);
  }, SLOW);
});

describe("item CREATE — nothing is asked of Apple", () => {
  it("⚠ 0 baseline requests, and every cell ticked", async () => {
    const h = installFetch(() => READABLE([]));
    const c = renderWizard({ existing: [] }); // not on Apple ⇒ CREATE
    await goToLocalization(c);
    const sel = await executeAndReadConfig(h);
    expect(h.baselineCalls).toHaveLength(0);
    expect(sel.selected[PID]?.sort()).toEqual(["en-US", "vi"]);
  }, SLOW);
});

describe("progress", () => {
  it("⑤ the reading counter is rendered while the pass is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = installFetch(() => READABLE([]));
    const origFetch = globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/localization-baseline")) await gate;
      return origFetch(url, init);
    }));
    const c = renderWizard();
    await goToLocalization(c);
    await screen.findByTestId("localization-baseline-progress");
    expect(screen.getByTestId("localization-baseline-progress").textContent).toMatch(/0\/1/);
    release();
    await waitFor(() => expect(h.baselineCalls.length).toBe(1));
  }, SLOW);
});

describe("⑦ a hand edit is never overwritten by a later seed", () => {
  it("⚠⚠ an edit made WHILE the read is in flight survives the seed that lands after it", async () => {
    // THE WINDOW IS REAL AND IT IS ABOUT A MINUTE LONG. Cells are interactive
    // from the moment the step renders, but a batch of 88 takes ~60s to read.
    // `seededRef` latches when the REQUEST goes out, so it cannot help here —
    // the seed for this very item is still on its way. Without `touchedRef`
    // the arriving baseline overwrites what the Manager just did, and it does
    // so SILENTLY: no error, no toast, the checkbox simply changes back.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Both locales match Apple ⇒ the seed would compute [] (nothing ticked).
    const h = installFetch(() =>
      READABLE([
        row("a-vi", "vi", "188 Vàng", "Gói 188 Vàng"),
        row("a-en", "en-US", "188 Gold", "188 Gold pack"),
      ]),
    );
    const origFetch = globalThis.fetch as unknown as (...a: unknown[]) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/localization-baseline")) await gate;
      return origFetch(url, init);
    }));

    const c = renderWizard();
    await goToLocalization(c);
    await screen.findByTestId("localization-baseline-progress");

    // Before the baseline lands every cell renders ticked (absent ⇒ all).
    // The Manager unticks exactly one of the two.
    const target = screen.getByTestId(`localization-cell-${PID}-vi`) as HTMLInputElement;
    expect(target.checked).toBe(true);
    fireEvent.click(target);

    release();
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));

    const sel = await executeAndReadConfig(h);
    // ⚠ ONE locale, not zero. Zero is what the seed would have written, and
    // it is indistinguishable from the Manager having unticked both.
    expect(sel.selected[PID]).toHaveLength(1);
  }, SLOW);

  it("an item the Manager never touched IS seeded normally", async () => {
    // The other half: `touchedRef` must not become a blanket "never seed".
    const h = installFetch(() =>
      READABLE([
        row("a-vi", "vi", "188 Vàng", "Gói 188 Vàng"),
        row("a-en", "en-US", "188 Gold", "188 Gold pack"),
      ]),
    );
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    const sel = await executeAndReadConfig(h);
    expect(sel.selected[PID]).toEqual([]);
  }, SLOW);
});

describe("② the read set follows step 3 — `resolved` is in the deps", () => {
  it("⭐ an item flipped SKIP→OVERWRITE is read on the next pass", async () => {
    // The requirement this test exists for: the set of items worth reading is
    // a RESULT of step 3, not of the file. An effect keyed only on `step`
    // would read the SKIP set and never notice the Manager changed its mind —
    // and the item would reach execute wearing a default nobody computed.
    const h = installFetch(() =>
      READABLE([row("a-vi", "vi", "188 Vàng", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")]),
    );
    const c = renderWizard(); // PID is in existingProductIds ⇒ a conflict row
    await dropExcel(c);
    await next(); // → Screenshots
    await next(); // → Preview (step 3)

    // Batch default becomes SKIP ⇒ the row is not processed ⇒ not read.
    const modeSelect = c.querySelector("select") as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: "SKIP" } });

    await next(); // → Localization
    await waitFor(() =>
      expect(screen.getByTestId("localization-step")).toBeInTheDocument(),
    );
    expect(h.baselineCalls).toHaveLength(0);

    // Back to step 3, flip THIS row to OVERWRITE, forward again.
    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    await waitFor(() => expect(c.querySelector("select")).toBeTruthy());
    // The per-row control is labelled with its CURRENT mode; clicking toggles.
    fireEvent.click(screen.getByRole("button", { name: /^SKIP$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^OVERWRITE$/i })).toBeInTheDocument(),
    );
    await next();

    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    expect(h.baselineCalls[0]).toContain(APPLE_ID);
  }, SLOW);

  it("⚠ an item already read is NOT re-read when step 3 changes something else", async () => {
    // The latch. Without it every pass re-seeds every item, silently undoing
    // hand edits made in between.
    const h = installFetch(() => READABLE([row("a-vi", "vi", "x", "y")]));
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    await waitFor(() => expect(c.querySelector("select")).toBeTruthy());
    await next();
    await waitFor(() =>
      expect(screen.getByTestId("localization-step")).toBeInTheDocument(),
    );
    expect(h.baselineCalls).toHaveLength(1);
  }, SLOW);
});

describe("④ Q-F — the confirm dialog warns about VERSIONS, counted per ITEM", () => {
  async function toConfirm(c: HTMLElement) {
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(screen.getByTestId("localization-confirm")).toBeInTheDocument(),
    );
    return c;
  }

  it("⭐ a live item with no draft and a real change ⇒ the line appears, saying 1", async () => {
    const h = installFetch(() => ({
      readable: true, hasApproved: true, hasDraft: false,
      approved: [row("a-vi", "vi", "CŨ", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")],
      draft: [],
    }));
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    await toConfirm(c);
    expect(screen.getByTestId("localization-confirm-new-version").textContent).toBe("1");
    const dialog = screen.getByTestId("localization-confirm").textContent ?? "";
    expect(dialog).toMatch(/1 item/);
    expect(dialog).toMatch(/sẽ tạo version mới trên App Store Connect/);
    expect(dialog).toMatch(/phải duyệt lại/);
  }, SLOW);

  it("⭐⭐ THREE changed locales on ONE item is still 1 — counting cells would say 3", async () => {
    parseIapItemsXlsx.mockResolvedValue(
      parsed([
        loc("vi", "Vietnamese", "A", "B"),
        loc("en-US", "English (U.S.)", "C", "D"),
        loc("th", "Thai", "E", "F"),
      ]),
    );
    const h = installFetch(() => ({
      readable: true, hasApproved: true, hasDraft: false,
      approved: [
        row("a-vi", "vi", "x", "y"),
        row("a-en", "en-US", "x", "y"),
        row("a-th", "th", "x", "y"),
      ],
      draft: [],
    }));
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    await toConfirm(c);
    expect(screen.getByTestId("localization-confirm-new-version").textContent).toBe("1");
  }, SLOW);

  it("⚠ an item that ALREADY has a draft is not counted — CA 2 creates nothing", async () => {
    const h = installFetch(() => ({
      readable: true, hasApproved: true, hasDraft: true,
      approved: [row("a-vi", "vi", "CŨ", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")],
      draft: [row("d-vi", "vi", "KHÁC NỮA", "x"), row("d-en", "en-US", "188 Gold", "188 Gold pack")],
    }));
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    await toConfirm(c);
    expect(screen.queryByTestId("localization-confirm-new-version")).toBeNull();
  }, SLOW);

  it("⚠ N = 0 ⇒ the line is HIDDEN, not rendered as '0 item'", async () => {
    // "0 item sẽ tạo version mới" occupies the place a real warning would, and
    // a reader who sees it every run stops reading it on the run it says 7.
    const h = installFetch(() =>
      READABLE([row("a-vi", "vi", "188 Vàng", "Gói 188 Vàng"), row("a-en", "en-US", "188 Gold", "188 Gold pack")]),
    );
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    await toConfirm(c);
    expect(screen.queryByTestId("localization-confirm-new-version")).toBeNull();
    expect(screen.getByTestId("localization-confirm").textContent).not.toMatch(/0 item/);
  }, SLOW);

  it("⚠ an item NOT live is not counted, however much it changes", async () => {
    const h = installFetch(() => ({
      readable: true, hasApproved: false, hasDraft: true, approved: [], draft: [],
    }));
    const c = renderWizard();
    await goToLocalization(c);
    await waitFor(() => expect(h.baselineCalls).toHaveLength(1));
    await toConfirm(c);
    expect(screen.queryByTestId("localization-confirm-new-version")).toBeNull();
  }, SLOW);
});
