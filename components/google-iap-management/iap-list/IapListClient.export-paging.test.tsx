// @vitest-environment jsdom

/**
 * ⚠ CHUNK 2 — THE ONE TEST THE WHOLE ARC IS RISKIEST WITHOUT.
 *
 * Paging lets a row the operator ALREADY CHANGED scroll off screen. "What I am
 * looking at" and "what I have selected" become independent in BOTH
 * directions, which is the shape of `[GOOGLE-export-intersection-silent-drop]`.
 * Everything else in the arc is a convenience; this is the correctness claim:
 *
 *     a change made on page 1 must still be in the payload after the operator
 *     has walked to page 3 and made another one there.
 *
 * ⚠ AND THE CASE IS *UN*-TICKING, NOT TICKING — G1. Google's picker opens with
 * EVERYTHING ticked (`IapListClient.tsx:199-202`), so the operator's real
 * gesture is subtraction. A test that only ever ticks would pass against an
 * implementation that silently rebuilds "everything" on every page flip, which
 * is precisely the bug worth fearing here.
 *
 * Asserted on the REQUEST BODY, not on component state: the payload is the
 * only artefact the operator actually receives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { IapListClient } from "./IapListClient";
import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";

function iap(sku: string): IapWithDefaultLocale {
  return {
    id: `id-${sku}`,
    app_id: "app-1",
    sku,
    purchase_type: "managed",
    status: "active",
    default_currency: "USD",
    default_price_micros: "990000",
    last_synced_at: null,
    deleted_on_google_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    default_title: `Item ${sku}`,
  };
}

/** 45 rows ⇒ three pages once the operator drops Rows to 20. */
const MANY = Array.from({ length: 45 }, (_, i) =>
  iap(`sku.${String(i).padStart(2, "0")}`),
);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob(["x"]),
    headers: new Headers({ "Content-Disposition": 'attachment; filename="a.xlsx"' }),
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

function exportBody() {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/export"));
  if (!call) throw new Error("no export request was made");
  return JSON.parse((call[1] as RequestInit).body as string);
}

/** Open the picker and drop to 20 rows/page so 45 items span three pages. */
function openPickerAtRows20() {
  fireEvent.click(screen.getByRole("button", { name: /Export list/ }));
  fireEvent.change(screen.getByLabelText("Rows per page"), {
    target: { value: "20" },
  });
}

/** The pager's Next, addressed by its aria-label so it can never be confused
 *  with the dialog footer's "Next — choose countries". */
function nextPage() {
  fireEvent.click(screen.getByLabelText("Next page"));
}

async function confirmExport() {
  fireEvent.click(screen.getByRole("button", { name: /Next — choose countries/ }));
  // Step 2 is the shared country dialog (`components/iap-management/
  // ExportOptionsDialog`, already used by this flow); take its default set.
  const go = await screen.findByRole("button", { name: /^Export \d+ countr/ });
  fireEvent.click(go);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/export")),
    ).toBe(true),
  );
}

describe("⚠ a change on page 1 survives walking to page 3 (the silent-drop class)", () => {
  it("⭐ UN-ticking on page 1 and on page 3 ⇒ payload omits EXACTLY those two", async () => {
    render(
      <IapListClient
        packageName="com.x"
        appDisplayName="X"
        appLastSyncedAt={null}
        initialIaps={MANY}
      />,
    );
    openPickerAtRows20();

    // G1: everything opens ticked. Subtract one here on page 1…
    fireEvent.click(screen.getByLabelText("Select sku.00"));

    // …walk to page 3 …
    nextPage();
    nextPage();
    expect(screen.getByTestId("page-nav-position")).toHaveTextContent("Page 3 of 3");

    // …and subtract another there.
    fireEvent.click(screen.getByLabelText("Select sku.44"));

    // The page-1 row is long gone from the screen; the counter must still own it.
    expect(screen.getByText("43 selected")).toBeInTheDocument();

    await confirmExport();

    const body = exportBody();
    expect(body.selectedSkus).toHaveLength(43);
    expect(body.selectedSkus).not.toContain("sku.00"); // page 1
    expect(body.selectedSkus).not.toContain("sku.44"); // page 3
    expect(body.selectedSkus).toContain("sku.01");
    expect(body.selectedSkus).toContain("sku.20");
  });

  it("⭐ a pick made under a SEARCH survives clearing the search and paging away", async () => {
    // M4 — the selection is independent of the filter. Clearing the box must
    // not quietly re-admit what the operator removed while it was applied.
    render(
      <IapListClient
        packageName="com.x"
        appDisplayName="X"
        appLastSyncedAt={null}
        initialIaps={MANY}
      />,
    );
    openPickerAtRows20();

    const search = screen.getByLabelText("Search items");
    fireEvent.change(search, { target: { value: "sku.3" } }); // sku.30–sku.39
    fireEvent.click(screen.getByLabelText("Select sku.33")); // un-tick
    fireEvent.change(search, { target: { value: "" } }); // clear the search

    nextPage();
    await confirmExport();

    const body = exportBody();
    expect(body.selectedSkus).toHaveLength(44);
    expect(body.selectedSkus).not.toContain("sku.33");
  });

  it("⭐ untouched flow still sends `null`, not a list of all 45", async () => {
    // The pre-X3 request shape. Paging must not turn "I changed nothing" into
    // an explicit 45-SKU list, which would start tripping the route's
    // unknown-SKU 409 on a flow nobody narrowed.
    render(
      <IapListClient
        packageName="com.x"
        appDisplayName="X"
        appLastSyncedAt={null}
        initialIaps={MANY}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Export list/ }));
    await confirmExport();
    expect(exportBody().selectedSkus).toBeNull();
  });
});
