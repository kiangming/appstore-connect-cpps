// @vitest-environment jsdom
/**
 * PA2.3 — WIRING of "Export for editing" + "Import edited file" on BOTH
 * matrix screens (KB P26: render the real screen, click the real button, read
 * the request `fetch` actually got). Manager 2026-10-19: Q-B, Q-E, Q-F.
 *
 * SEAM: `fetch` is a spy answering like the routes; everything above it runs
 * for real (filter state, the shared filter bar, the import component and its
 * dialog). `sonner`, `next/navigation` and `URL.createObjectURL` are mocked —
 * jsdom has none of them. The file picker is the one thing jsdom cannot open:
 * the real button's click is followed to the real hidden input (I0), then
 * the file is put on that input.
 *
 * The fixtures make every number that could be swapped DIFFERENT (before ≠
 * after, cleared ≠ column-absent ≠ row-absent, commit ≠ preview, server
 * counts ≠ the page's matrix) — equal fixtures hide swapped wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import { composeMatrix, type TemplateEntryRow } from "@/lib/iap-management/queries/template-matrix";
import { MATRIX_EXPORT_ENDPOINT } from "@/lib/iap-management/matrix-export-download";
import { MATRIX_IMPORT_ENDPOINT } from "@/lib/iap-management/matrix-import-client";
import type { MatrixImportPreviewResponse } from "@/lib/iap-management/template-reimport/types";

vi.mock("sonner", () => ({ toast: { loading: vi.fn(() => "t"), success: vi.fn(), error: vi.fn() } }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { toast } from "sonner";
import { DefaultMatrixView } from "./DefaultMatrixView";
import { PerAppMatrixView } from "./PerAppMatrixView";
import { MAX_ROWS_SHOWN } from "./MatrixImport";

const row = (tier_id: string, territory_code: string, currency_code: string, customer_price: number): TemplateEntryRow => ({
  tier_id,
  territory_code,
  currency_code,
  customer_price,
  proceeds: null,
});
const MATRIX = composeMatrix({
  entries: [row("TIER_2", "VNM", "VND", 49000), row("TIER_2", "USA", "USD", 1.99), row("TIER_10", "VNM", "VND", 490000)],
  tierNames: new Map([
    ["TIER_2", "Tier 2"],
    ["TIER_10", "Tier 10"],
  ]),
});
const ACCOUNT = { id: "acct-1", name: "Account One" };

type Change = MatrixImportPreviewResponse["changes"][number];
const removed = (tier_id: string, territory_code: string, price: number, currency: string, removedBecause: Change["removedBecause"]): Change => ({
  kind: "removed",
  tier_id,
  territory_code,
  before: { price, currency },
  after: null,
  removedBecause,
  flags: [],
});
// Server order (diff.ts): added/changed in file order, removed after.
const PREVIEW: MatrixImportPreviewResponse = {
  kind: "preview",
  target: { kind: "ACCOUNT", accountId: "acct-1", accountName: "Account One" },
  file: { name: "f.xlsx", exportedAt: "2026-10-20T03:00:00.000Z", exportedBy: "m@example.test" },
  totals: {
    before: 8, after: 3, added: 1, changed: 1, removed: 6,
    removedCleared: 1, removedColumnAbsent: 2, removedRowAbsent: 3, unchanged: 1, proceedsCleared: 2,
  },
  warnings: { usaChanges: 1, usaColumnMissing: false, usaCurrencyNotUsd: false, magnitude: 0, ladder: 0 },
  changes: [
    { kind: "changed", tier_id: "TIER_2", territory_code: "VNM", before: { price: 49000, currency: "VND" }, after: { price: 25000, currency: "VND" }, flags: [] },
    { kind: "added", tier_id: "TIER_10", territory_code: "USA", before: null, after: { price: 9.99, currency: "USD" }, flags: ["usa"] },
    removed("TIER_10", "VNM", 490000, "VND", "cleared"),
    removed("TIER_2", "THA", 35, "THB", "column-absent"),
    removed("TIER_10", "THA", 349, "THB", "column-absent"),
    removed("TIER_3", "VNM", 79000, "VND", "row-absent"),
    removed("TIER_3", "USA", 2.99, "USD", "row-absent"),
    removed("TIER_3", "THA", 99, "THB", "row-absent"),
  ],
};
const ZERO: MatrixImportPreviewResponse = {
  ...PREVIEW,
  totals: { ...PREVIEW.totals, before: 3, after: 3, added: 0, changed: 0, removed: 0, removedCleared: 0, removedColumnAbsent: 0, removedRowAbsent: 0, unchanged: 3 },
  warnings: { ...PREVIEW.warnings, usaChanges: 0 },
  changes: [],
};
// Commit totals are counted again at COMMIT time (KB P5) — deliberately not the preview's.
const COMMIT = {
  kind: "commit",
  template_id: "t2",
  inserted_entry_count: 7,
  audit_batch_id: "b",
  totals: { ...PREVIEW.totals, added: 2, changed: 0, removed: 1, after: 7 },
};

let fetchSpy: ReturnType<typeof vi.fn>;
/** A reply, a pending reply, or a thunk — a thunk for a REJECTION, so the
 *  rejected promise only exists once fetch is called (no unhandled rejection). */
type Reply =
  | { status: number; body: unknown }
  | Promise<{ status: number; body: unknown }>
  | (() => Promise<{ status: number; body: unknown }>);
let importReplies: Reply[] = [];
/** What the export route says it put in the file — NOT the page's 2 × 2. */
const EXPORT_HEADERS = { "Content-Disposition": 'attachment; filename="f.xlsx"', "X-Export-Tier-Count": "95", "X-Export-Territory-Count": "175" };
let inputClicks: HTMLInputElement[] = [];

/** `body: undefined` = no JSON at all (a proxy's HTML page): `json()` rejects, as real fetch does. */
function jsonResponse(status: number, body: unknown) {
  const json = body === undefined ? async () => Promise.reject(new SyntaxError("Unexpected token <")) : async () => body;
  return { ok: status < 400, status, json, blob: async () => new Blob(["x"]), headers: new Headers() };
}

beforeEach(() => {
  importReplies = [];
  inputClicks = [];
  fetchSpy = vi.fn(async (url: string) => {
    if (url === MATRIX_IMPORT_ENDPOINT) {
      const r = importReplies.shift() ?? { status: 500, body: { error: "unexpected call" } };
      const next = await (typeof r === "function" ? r() : r);
      return jsonResponse(next.status, next.body);
    }
    return { ok: true, status: 200, blob: async () => new Blob(["x"]), headers: new Headers(EXPORT_HEADERS) };
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
  // jsdom opens no file picker: record which input the button clicked.
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    inputClicks.push(this);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const renderDefault = (canImport = true) =>
  render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} account={ACCOUNT} canImport={canImport} />);
const renderPerApp = () =>
  render(
    <PerAppMatrixView matrix={MATRIX} appId="app-uuid-1" appName="Demo" bundleId="com.vng.demo" uploadedAt={null} uploadedBy={null} defaultTemplateExists={false} />,
  );

const importCalls = () => fetchSpy.mock.calls.filter(([url]) => url === MATRIX_IMPORT_ENDPOINT) as Array<[string, RequestInit]>;
const formOf = (call: [string, RequestInit]) => {
  const fd = call[1].body as FormData;
  return { intent: fd.get("intent"), scope: fd.get("scope"), account_id: fd.get("account_id"), app_id: fd.get("app_id"), file: (fd.get("file") as File).name };
};
/** Click the REAL "Import edited file" button, prove it opened the real
 *  hidden input, then put the file on that input (what the picker does). */
function importFile(name = "edited.xlsx") {
  const input = screen.getByTestId("matrix-import-input");
  fireEvent.click(screen.getByRole("button", { name: /Import edited file/ }));
  expect(inputClicks).toEqual([input]);
  inputClicks = [];
  fireEvent.change(input, { target: { files: [new File(["x"], name)] } });
}
const cellsOf = (tr: HTMLElement) => within(tr).getAllByRole("cell").map((c) => c.textContent);
const bodyRows = (dialog: HTMLElement) => within(within(dialog).getByRole("table", { name: "Changes" })).getAllByRole("row").slice(1);
const lastToast = (kind: "success" | "error") => {
  const calls = (toast[kind] as ReturnType<typeof vi.fn>).mock.calls;
  return String(calls[calls.length - 1]?.[0]);
};

describe("PA2.3 — who may import, on which screen", () => {
  it("W1 Default, admin: both buttons; the heading names the account", () => {
    renderDefault(true);
    expect(screen.getByRole("heading", { name: /Default Pricing Template — Account One/ })).toBeInTheDocument();
    expect(screen.getByText("acct-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export for editing/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import edited file/ })).toBeEnabled();
  });

  it("W2 Default, member: can export for editing, has no import button (admin-only, like uploading a Default)", () => {
    renderDefault(false);
    expect(screen.getByRole("button", { name: /Export for editing/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import edited file/ })).toBeNull();
    expect(screen.queryByTestId("matrix-import-input")).toBeNull();
  });

  it("W2b Per-App: the import button is there for EVERYONE — the view takes no role (open to members, like a Per-App upload)", () => {
    renderPerApp();
    expect(screen.getByRole("button", { name: /Import edited file/ })).toBeEnabled();
    expect(screen.getByTestId("matrix-import-input")).toBeInTheDocument();
  });
});

describe("PA2.3 — Export for editing never sends the screen's territories (Q-B)", () => {
  it("W3 Default, even with a filter on: {scope, the PAGE's account, mode: edit} and nothing else; the toast says what the SERVER put in the file", async () => {
    renderDefault();
    fireEvent.change(screen.getByPlaceholderText(/Search territory/i), { target: { value: "viet" } });
    fireEvent.click(screen.getByRole("button", { name: /Export for editing/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MATRIX_EXPORT_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({ scope: "default", accountId: "acct-1", mode: "edit" });
    expect(lastToast("success")).toBe("Exported for editing: 95 tiers × 175 territories — the whole template.");
  });

  it("W3b a filter that matches NOTHING disables Export XLSX, never Export for editing", async () => {
    renderDefault();
    fireEvent.change(screen.getByPlaceholderText(/Search territory/i), { target: { value: "zzzz-no-such-territory" } });
    expect(screen.getByRole("button", { name: /Export XLSX/ })).toBeDisabled();
    const edit = screen.getByRole("button", { name: /Export for editing/ });
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ scope: "default", accountId: "acct-1", mode: "edit" });
  });

  it("W4 Per-App: {scope, appId, mode: edit}; same server-count toast", async () => {
    renderPerApp();
    fireEvent.click(screen.getByRole("button", { name: /Export for editing/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      scope: "per-app",
      appId: "app-uuid-1",
      mode: "edit",
    });
    expect(lastToast("success")).toBe("Exported for editing: 95 tiers × 175 territories — the whole template.");
  });
});

describe("PA2.3 — Import edited file: preview, then write exactly the file", () => {
  it("W5 Default: the real button → preview names the account; totals, warnings and every row read as they should; Write sends ONE commit; the toast is the COMMIT's", async () => {
    importReplies = [{ status: 200, body: PREVIEW }, { status: 200, body: COMMIT }];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    expect(formOf(importCalls()[0])).toEqual({ intent: "preview", scope: "ACCOUNT", account_id: "acct-1", app_id: null, file: "edited.xlsx" });
    expect(within(dialog).getByRole("heading", { name: "Import edited file — Default template · Account One (acct-1)" })).toBeInTheDocument();

    const totals = within(dialog).getByRole("list", { name: "Totals" });
    expect(totals).toHaveTextContent("+1 new overrides");
    expect(totals).toHaveTextContent("~1 price changes");
    expect(totals).toHaveTextContent(
      "−6 overrides removed — back to Apple's price (cleared in the file: 1 · territory not in the file: 2 · tier not in the file: 3)",
    );
    expect(totals).toHaveTextContent("=1 unchanged · 3 overrides after writing (now 8)");
    expect(totals).not.toHaveTextContent("not the Default");
    const warnings = within(dialog).getByRole("list", { name: "Warnings" });
    expect(warnings).toHaveTextContent(/1 change\(s\) in the USA column/);
    expect(warnings).toHaveTextContent(/2 cells hold proceeds today/);

    // Flagged rows first, then removed, then changed (orderChangesForDisplay).
    expect(bodyRows(dialog).map(cellsOf)).toEqual([
      ["Tier 10", "United States", "·", "9.99 USD", "new override· USA"],
      ["Tier 10", "Vietnam", "490000 VND", "·", "back to Apple's price"],
      ["Tier 2", "Thailand", "35 THB", "·", "back to Apple's price"],
      ["Tier 10", "Thailand", "349 THB", "·", "back to Apple's price"],
      ["TIER_3", "Vietnam", "79000 VND", "·", "back to Apple's price"],
      ["TIER_3", "United States", "2.99 USD", "·", "back to Apple's price"],
      ["TIER_3", "Thailand", "99 THB", "·", "back to Apple's price"],
      ["Tier 2", "Vietnam", "49000 VND", "25000 VND", "price change"],
    ]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Write 8 changes" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(importCalls()).toHaveLength(2);
    expect(formOf(importCalls()[1])).toEqual({ intent: "commit", scope: "ACCOUNT", account_id: "acct-1", app_id: null, file: "edited.xlsx" });
    expect(lastToast("success")).toBe("Template written: 2 new · 0 changed · 1 removed — 7 overrides.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("W6 Per-App: the real button → the target is the app; title, totals AND rows say back to Apple's price — NOT the Default", async () => {
    importReplies = [{ status: 200, body: { ...PREVIEW, target: { kind: "APP", appId: "app-uuid-1", bundleId: "com.vng.demo", appName: "Demo" } } }];
    renderPerApp();
    importFile();
    const dialog = await screen.findByRole("dialog");
    expect(formOf(importCalls()[0])).toEqual({ intent: "preview", scope: "APP", account_id: null, app_id: "app-uuid-1", file: "edited.xlsx" });
    expect(within(dialog).getByRole("heading", { name: "Import edited file — Per-App template · Demo (com.vng.demo)" })).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "Totals" })).toHaveTextContent("back to Apple's price — not the Default");
    const removedRows = bodyRows(dialog).filter((r) => cellsOf(r)[3] === "·");
    expect(removedRows).toHaveLength(6);
    for (const r of removedRows) expect(cellsOf(r)[4]).toBe("back to Apple's price — not the Default");
  });

  it("W6b every warning and every row badge is shown when the server reports it (×10, tier ladder, USA)", async () => {
    importReplies = [
      {
        status: 200,
        body: {
          ...PREVIEW,
          warnings: { usaChanges: 1, usaColumnMissing: true, usaCurrencyNotUsd: true, magnitude: 1, ladder: 1 },
          changes: [
            { kind: "changed", tier_id: "TIER_2", territory_code: "VNM", before: { price: 49000, currency: "VND" }, after: { price: 49, currency: "VND" }, flags: ["magnitude"] },
            { kind: "added", tier_id: "TIER_10", territory_code: "VNM", before: null, after: { price: 5, currency: "VND" }, flags: ["ladder"] },
            { kind: "added", tier_id: "TIER_10", territory_code: "USA", before: null, after: { price: 9.99, currency: "USD" }, flags: ["usa"] },
          ],
        },
      },
    ];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    const warnings = within(dialog).getByRole("list", { name: "Warnings" });
    expect(warnings).toHaveTextContent("1 price(s) changed more than ×10 — check for a typo such as 49,000 typed as 49.");
    expect(warnings).toHaveTextContent("1 new override(s) sit outside their neighbouring tiers in the same column.");
    expect(warnings).toHaveTextContent("The file has no USA column — bulk import from this template will find no tier.");
    expect(warnings).toHaveTextContent("The USA column is not in USD — bulk import only reads USD prices from it.");
    expect(bodyRows(dialog).map((r) => cellsOf(r)[4])).toEqual(["price change· ×10", "new override· tier ladder", "new override· USA"]);
  });

  it("W6c more rows than the table shows: the flagged and the removed rows are the ones shown", async () => {
    const many: Change[] = Array.from({ length: MAX_ROWS_SHOWN + 40 }, (_, i) => ({
      kind: "changed",
      tier_id: `TIER_${i + 100}`,
      territory_code: "VNM",
      before: { price: 1000 + i, currency: "VND" },
      after: { price: 2000 + i, currency: "VND" },
      flags: [],
    }));
    many.splice(230, 0, { kind: "changed", tier_id: "TIER_TYPO", territory_code: "VNM", before: { price: 49000, currency: "VND" }, after: { price: 49, currency: "VND" }, flags: ["magnitude"] });
    many.push(removed("TIER_GONE", "VNM", 79000, "VND", "cleared"));
    importReplies = [{ status: 200, body: { ...PREVIEW, changes: many } }];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    const rows = bodyRows(dialog);
    expect(rows).toHaveLength(MAX_ROWS_SHOWN);
    expect(cellsOf(rows[0]).slice(0, 1)).toEqual(["TIER_TYPO"]);
    expect(cellsOf(rows[1]).slice(0, 1)).toEqual(["TIER_GONE"]);
    expect(dialog).toHaveTextContent(`…and 42 more changes (flagged and removed rows are listed first).`);
  });

  it("W7 a refused file: every problem with its cell, and NO write button", async () => {
    importReplies = [
      {
        status: 422,
        body: {
          error: "The file cannot be imported: 2 problems. Nothing was written.",
          code: "INVALID_FILE",
          problems: [
            { cell: "A3", message: '"Tier 05" — there is no such tier.' },
            { cell: "E3", message: 'Currency says "USD" but the column is VNM_VND' },
          ],
        },
      },
    ];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("2 problems. Nothing was written.");
    expect(within(dialog).getByRole("list", { name: "Problems" })).toHaveTextContent('A3 — "Tier 05" — there is no such tier.');
    expect(within(dialog).queryByRole("button", { name: /Write/ })).toBeNull();
  });

  it("W8 a file of another account (409): the message names both sides, and NO write button", async () => {
    importReplies = [{ status: 409, body: { error: "This file is the Default template of account B (acct-b); this page is … Nothing was written.", code: "SCOPE_MISMATCH" } }];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This file is the Default template of account B (acct-b)");
    expect(within(dialog).queryByRole("button", { name: /Write/ })).toBeNull();
  });

  it("W9 0 changes: says so, still offers to write (Q-F) — and Write anyway really COMMITS, then closes and reloads", async () => {
    importReplies = [{ status: 200, body: ZERO }, { status: 200, body: { ...COMMIT, totals: ZERO.totals, inserted_entry_count: 3 } }];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("No changes — the file matches the template.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Write anyway" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(importCalls()).toHaveLength(2);
    expect(formOf(importCalls()[1])).toEqual({ intent: "commit", scope: "ACCOUNT", account_id: "acct-1", app_id: null, file: "edited.xlsx" });
    expect(lastToast("success")).toBe("Template written: 0 new · 0 changed · 0 removed — 3 overrides.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("W10 KB P12: a write that FAILED leaves Write disabled — a second click sends nothing; the failure is toasted and the matrix reloaded (it may be partial)", async () => {
    importReplies = [
      { status: 200, body: PREVIEW },
      { status: 500, body: { error: "The template may be partially written — import the same file again. (x)", code: "WRITE_FAILED" } },
    ];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    const write = within(dialog).getByRole("button", { name: "Write 8 changes" });
    fireEvent.click(write);
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/may be partially written/));
    expect(write).toBeDisabled();
    fireEvent.click(write);
    expect(importCalls()).toHaveLength(2);
    expect(lastToast("error")).toMatch(/may be partially written — import the same file again/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("W10b a commit with NO answer (a bodiless 504, or the connection drops) says the outcome is UNKNOWN — never 'failed'", async () => {
    importReplies = [{ status: 200, body: PREVIEW }, { status: 504, body: undefined }];
    renderDefault();
    importFile();
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Write 8 changes" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The server gave no clear answer (status 504) — the template may or may not have been written. The matrix has been reloaded; import the same file again to be sure.",
    ));
    expect(refresh).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    importReplies = [{ status: 200, body: PREVIEW }, () => Promise.reject(new TypeError("Failed to fetch"))];
    importFile("again.xlsx");
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Write 8 changes" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/no clear answer \(Failed to fetch\) — the template may or may not have been written/));
    expect(lastToast("error")).toMatch(/may or may not have been written/);
  });
});

describe("PA2.3 — one file at a time; the dialog is a real modal (review: in-flight write + keyboard)", () => {
  it("W11 while a dialog is open — and while its write is in flight — the import button is disabled", async () => {
    let finish!: (r: { status: number; body: unknown }) => void;
    importReplies = [{ status: 200, body: PREVIEW }, new Promise((r) => (finish = r))];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: /Importing…/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Write 8 changes" }));
    expect(screen.getByRole("button", { name: /Importing…/ })).toBeDisabled();
    finish({ status: 200, body: COMMIT });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: /Import edited file/ })).toBeEnabled();
  });

  it("W12 focus starts on Cancel (the safe button); Escape closes it; Tab stays inside", async () => {
    importReplies = [{ status: 200, body: PREVIEW }];
    renderDefault();
    importFile();
    const dialog = await screen.findByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    const write = within(dialog).getByRole("button", { name: "Write 8 changes" });
    write.focus();
    fireEvent.keyDown(write, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("W13 the bytes are read ONCE at selection: preview and write send the same bytes", async () => {
    importReplies = [{ status: 200, body: PREVIEW }, { status: 200, body: COMMIT }];
    renderDefault();
    const chosen = new File(["ORIGINAL"], "f.xlsx");
    const read = vi.spyOn(chosen, "arrayBuffer");
    fireEvent.change(screen.getByTestId("matrix-import-input"), { target: { files: [chosen] } });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Write 8 changes" }));
    await waitFor(() => expect(importCalls()).toHaveLength(2));
    const sentFiles = importCalls().map(([, init]) => (init.body as FormData).get("file") as File);
    // Neither request sends the picked file handle itself (the browser would
    // re-read it from disk) — both send the copy made from ONE read.
    expect(read).toHaveBeenCalledTimes(1);
    for (const f of sentFiles) expect(f).not.toBe(chosen);
    expect(await Promise.all(sentFiles.map((f) => f.text()))).toEqual(["ORIGINAL", "ORIGINAL"]);
    expect(sentFiles.map((f) => f.name)).toEqual(["f.xlsx", "f.xlsx"]);
  });
});
