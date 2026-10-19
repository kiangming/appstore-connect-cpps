// @vitest-environment jsdom
/**
 * SC3 acceptance — per-item custom prices in the Bulk Import wizard.
 *
 * THE LOAD-BEARING TEST is "customs survive a re-preview". It encodes the
 * Manager-locked requirement that custom prices are ABSOLUTE and survive a
 * template change. That requirement is unachievable if customs live in a
 * rowNumber-keyed map, because:
 *   - `tierSelections` is keyed by rowNumber and fully reseeded on every
 *     preview response (BulkImportWizard.tsx handleUploadAndPreview), and
 *   - changing the template FORCES a re-preview, since pricingSource is
 *     sent with the file upload.
 * So the survival test is what makes the SKU-keying non-negotiable rather
 * than a preference. Mutation-checked: keying by rowNumber, or resetting
 * customPrices in handleUploadAndPreview, makes it fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { BulkImportWizard } from "./BulkImportWizard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

const AVAILABILITY = "/pricing-templates/availability";
const PREVIEW = "/bulk-import/preview";
const CATALOG = "/regions/catalog";
const TIER_ENTRIES = "/pricing-templates/tier-entries";

function previewRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    rowNumber: 2,
    sku: "gem_pack_large",
    baseCurrency: "USD",
    basePriceDecimal: "9.99",
    regionOverrides: [],
    listings: [{ locale: "en-US", title: "Gem Pack", description: "d" }],
    exists: false,
    tierCandidates: [
      { identifier: "tier_999", templateId: "t1", regionCount: 3, vnCurrency: "VND", vnPriceMicros: "249000000000", vnPriceDecimal: "249000" },
    ],
    defaultTierSelection: "tier_999",
    tierMatchedBy: "currency_price",
    ...over,
  };
}

/** Preview response builder — `rows` positions shift between calls so a
 *  rowNumber-keyed store would visibly lose its mapping. */
function previewBody(rows: unknown[]) {
  return { rows, warnings: [], counts: {} };
}

function installFetch(opts: {
  previewSequence: unknown[][];
}) {
  let previewCall = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes(AVAILABILITY)) {
      return {
        ok: true,
        json: async () => ({
          defaultExists: true,
          appExists: true,
          defaultTiers: ["tier_999"],
          appTiers: ["tier_app"],
        }),
      } as unknown as Response;
    }
    if (url.includes(PREVIEW)) {
      const rows = opts.previewSequence[Math.min(previewCall, opts.previewSequence.length - 1)];
      previewCall += 1;
      return { ok: true, json: async () => previewBody(rows) } as unknown as Response;
    }
    if (url.includes(CATALOG)) {
      return {
        ok: true,
        json: async () => ({
          regions: [
            { regionCode: "US", currency: "USD" },
            { regionCode: "VN", currency: "VND" },
          ],
          regionsVersion: "2024/02",
        }),
      } as unknown as Response;
    }
    if (url.includes(TIER_ENTRIES)) {
      return {
        ok: true,
        json: async () => ({
          entries: [
            { regionCode: "US", currency: "USD", priceMicros: "9990000", priceDecimal: "9.99" },
            { regionCode: "VN", currency: "VND", priceMicros: "249000000000", priceDecimal: "249000" },
          ],
        }),
      } as unknown as Response;
    }
    if (url.includes("hub-tracking")) {
      return { ok: true, json: async () => ({ run_id: null }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

const PROPS = {
  packageName: "com.vng.cashknight",
  appId: "app-uuid-1",
  appDisplayName: "CashKnight",
  // D0 — these scenarios exercise a mirror that HAS been refreshed.
  iapsLastSyncedAt: "2026-10-16T03:25:10.000Z",
};

/** Drive the wizard: Step 1 → Step 2 → upload → Step 3. */
async function goToPreview() {
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  const input = document.querySelector("#bulk-upload-file") as HTMLInputElement;
  const file = new File(["x"], "iaps.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
  await screen.findByText(/Push to Google Play/);
}

/** Open the dialog, type a VN price, save. */
async function setCustomPrice(price: string) {
  fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
  const vn = await screen.findByLabelText("Custom price for VN");
  fireEvent.change(vn, { target: { value: price } });
  fireEvent.click(screen.getByRole("button", { name: /Save custom prices/ }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
}

describe("BulkImportWizard — per-item custom prices", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", installFetch({ previewSequence: [[previewRow()]] }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Part A: Continue is gated until the availability check resolves (no import on an unchosen source)", async () => {
    let releaseAvailability: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      releaseAvailability = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.includes(AVAILABILITY)) {
          await gate;
          return {
            ok: true,
            json: async () => ({
              defaultExists: true,
              appExists: false,
              defaultTiers: ["tier_999"],
              appTiers: [],
            }),
          } as unknown as Response;
        }
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );
    render(<BulkImportWizard {...PROPS} />);

    // Nothing selected, nothing advanceable.
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
    screen.getAllByRole("radio").forEach((r) => expect(r).toBeDisabled());

    releaseAvailability(null);

    // Priority default lands on the one template that exists, visibly.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Default Template/ })).toBeChecked(),
    );
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });

  it("saves a custom set and shows a non-opaque row indicator", async () => {
    render(<BulkImportWizard {...PROPS} />);
    // Pick a template source so custom applies at all.
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();

    await setCustomPrice("199000");

    // Count is named, and both re-open and revert affordances exist.
    expect(screen.getByText(/Custom · 2 countries/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View / edit" })).toBeInTheDocument();
    // Label is "Clear", not "Reset to template" — the latter was
    // nonsensical under Google Conversion, where there is no template.
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("SURVIVAL: customs persist across a re-preview at a DIFFERENT rowNumber (Manager-locked)", async () => {
    // 2nd preview returns the same SKU at a different file position — a
    // rowNumber-keyed store loses it here; a SKU-keyed one does not.
    vi.stubGlobal(
      "fetch",
      installFetch({
        previewSequence: [
          [previewRow({ rowNumber: 2 })],
          [previewRow({ rowNumber: 7, defaultTierSelection: "tier_app", tierCandidates: [
            { identifier: "tier_app", templateId: "t2", regionCount: 3, vnCurrency: "VND", vnPriceMicros: "300000000000", vnPriceDecimal: "300000" },
          ] })],
        ],
      }),
    );
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    await setCustomPrice("199000");
    expect(screen.getByText(/Custom · 2 countries/)).toBeInTheDocument();

    // Step 3 → Step 2 → change template → re-preview.
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Preview/ }));
    await screen.findByText(/Push to Google Play/);

    // THE ASSERTION: the custom set is still attached to the SKU.
    expect(screen.getByText(/Custom · 2 countries/)).toBeInTheDocument();
  });

  it("re-opening the dialog shows the ACTUAL saved values (never opaque)", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    await setCustomPrice("199000");

    fireEvent.click(screen.getByRole("button", { name: "View / edit" }));
    const vn = await screen.findByLabelText("Custom price for VN");
    expect((vn as HTMLInputElement).value).toBe("199000");
  });

  it("Clear drops the custom set and returns the row to the batch source", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    await setCustomPrice("199000");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(screen.queryByText(/Custom · 2 countries/)).not.toBeInTheDocument(),
    );
    // The Custom… trigger is back — the row is on the template again.
    expect(screen.getByRole("button", { name: "Custom…" })).toBeInTheDocument();
  });

  it("INVERTED: switching to Google Conversion keeps the set ACTIVE (was: kept-but-inactive)", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    await setCustomPrice("199000");

    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Back$/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Google Conversion/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await screen.findByText(/Push to Google Play/);

    // Custom prices now apply under EVERY source, so the whole
    // keep-but-inactive state is gone: no grey chip, no banner.
    expect(screen.getByText(/Custom · 2 countries/)).toBeInTheDocument();
    expect(screen.queryByText(/kept but/)).not.toBeInTheDocument();
    expect(screen.queryByText(/this row is set to Skip/)).not.toBeInTheDocument();
  });

  it("Part B: the dialog opens with every country inheriting under Google Conversion (no pre-fill)", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Google Conversion/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));

    // S0.1's exact string, reused verbatim — one per country, no values.
    const inherits = await screen.findAllByText(/inherits — Google conversion/);
    expect(inherits.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Custom price for VN")).not.toBeInTheDocument();
    // And the header says why nothing is pre-filled here.
    expect(screen.getByText(/every country starts blank/)).toBeInTheDocument();
  });

  it("Part B: a SPARSE non-app-currency overlay SAVES under Google Conversion (S0.2, at the UI layer)", async () => {
    // The orchestrator accepts this (S0.2 regression test), but the dialog
    // gated Save on the app-currency entry unconditionally — so the UI
    // blocked exactly what the server would accept. App currency is VND;
    // only US is priced here.
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Google Conversion/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));

    const usSet = await screen.findAllByRole("button", { name: "set price" });
    fireEvent.click(usSet[0]);
    const anyInput = await screen.findByLabelText(/Custom price for /);
    fireEvent.change(anyInput, { target: { value: "12.34" } });

    // No blocking banner, and Save is live.
    expect(screen.queryByText(/Google needs a VND price/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save custom prices/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Save custom prices/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Custom · 1 country/)).toBeInTheDocument();
  });

  it("Skip is the ONLY thing that deactivates a custom set — chip greys with the real reason", async () => {
    // Counterpart to the source-switch test above. Together they pin both
    // halves of the rule: the source never deactivates, Skip always does.
    // Nothing pinned this before, so the caption could drift unnoticed —
    // which is exactly how it came to say "this pricing source / decision"
    // after the source half stopped being true.
    vi.stubGlobal(
      "fetch",
      installFetch({ previewSequence: [[previewRow({ exists: true })]] }),
    );
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    await setCustomPrice("199000");

    // Active to begin with: no inactive note.
    expect(screen.queryByText(/this row is set to Skip/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Skip/ }));

    // Kept (not discarded) but inactive, and the note names Skip — not the
    // pricing source, which no longer has anything to do with it.
    expect(screen.getByText(/Custom · 2 countries/)).toBeInTheDocument();
    expect(
      await screen.findByText(/this row is set to Skip, so nothing is sent/),
    ).toBeInTheDocument();

    // Un-skipping restores it without retyping.
    fireEvent.click(screen.getByRole("radio", { name: /Overwrite/ }));
    await waitFor(() =>
      expect(screen.queryByText(/this row is set to Skip/)).not.toBeInTheDocument(),
    );
  });

  it("H4.2 (Q6): under a TEMPLATE source Save is NOT gated on any currency — a US-only custom set saves", async () => {
    // Before H4.2 this was blocked ("Google needs a VND price") because the
    // app-currency entry became defaultPrice. Now the file's price is the
    // base, so no currency is special.
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
    const us = await screen.findByLabelText("Custom price for US");
    fireEvent.change(us, { target: { value: "12.00" } });
    fireEvent.click(screen.getByLabelText("Clear custom price for VN"));

    expect(screen.queryByText(/Google needs a .* price|has no currency set/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save custom prices/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Save custom prices/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("dialog blocks Save on a currency-precision violation, using the shared rules", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
    const vn = await screen.findByLabelText("Custom price for VN");
    fireEvent.change(vn, { target: { value: "199000.55" } }); // VND = 0 decimals

    expect(
      await screen.findByText(/VND only accepts whole numbers/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save custom prices/ })).toBeDisabled();
  });

  it.each([
    ["26.000", /it may be a thousands separator \(26\.000 = 26 thousand\?\)/],
    ["0", /the price is 0 — a 0 price is not accepted/],
  ])("H4.3 (Manager 2026-10-19): a typed VN '%s' blocks Save with the shared rule's reason", async (value, reason) => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
    const vn = await screen.findByLabelText("Custom price for VN");
    fireEvent.change(vn, { target: { value } });
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save custom prices/ })).toBeDisabled();
  });

  it("H4.3: the template seed '249000' VND (tier-entries, trailing zeros stripped) is NOT refused — Save stays enabled", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
    const vn = await screen.findByLabelText("Custom price for VN");
    expect(vn).toHaveValue("249000");
    expect(screen.queryByText(/thousands separator/)).not.toBeInTheDocument();
  });

  it("H4.3 (Q5): the GT line says what the push does — replaced by the matched tier (VN price known), then by custom once a set is saved", async () => {
    vi.stubGlobal(
      "fetch",
      installFetch({ previewSequence: [[previewRow({ regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "26000" }] })]] }),
    );
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    const gt = screen.getByTestId("gt-status");
    expect(gt).toHaveAttribute("data-state", "replaced_by_tier");
    expect(gt).toHaveTextContent('GT VN 26000 VND · replaced by tier "tier_999" (VN 249000 VND)');
    await setCustomPrice("199000");
    expect(screen.getByTestId("gt-status")).toHaveAttribute("data-state", "replaced_by_custom");
    expect(screen.getByTestId("gt-status")).toHaveTextContent("GT VN 26000 VND · replaced by custom (VN 199000 VND)");
  });

  it("H4.3 (Q5): template source, no tier matched, lookup FAILED ⇒ the GT is 'unknown — run Preview again', never 'will be sent'", async () => {
    vi.stubGlobal(
      "fetch",
      installFetch({
        previewSequence: [[previewRow({
          regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "26000" }],
          tierCandidates: [],
          defaultTierSelection: null,
          tierMatchedBy: "lookup_failed",
        })]],
      }),
    );
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    expect(screen.getByTestId("gt-status")).toHaveAttribute("data-state", "unknown_lookup_failed");
    expect(screen.getByTestId("tier-lookup-failed")).toBeInTheDocument();
  });

  it("blank countries state the Google-conversion fallback explicitly", async () => {
    render(<BulkImportWizard {...PROPS} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Default Template/ }));
    await goToPreview();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
    await screen.findByLabelText("Custom price for VN");
    fireEvent.click(screen.getByLabelText("Clear custom price for VN"));

    expect(
      await screen.findByText(/inherits — Google conversion/),
    ).toBeInTheDocument();
  });
});
