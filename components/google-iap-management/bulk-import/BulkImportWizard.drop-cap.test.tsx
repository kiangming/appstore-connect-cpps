// @vitest-environment jsdom
/**
 * H4.3 — the wizard and the execute route share ONE limit on the rows a push
 * may leave out (MAX_DROPPED_ROWS, bulk-import-contract.ts). Above it the
 * wizard disables Push and says why, so the Manager never meets a server 400
 * they cannot act on. The limit is mocked down to 2 here (the real one,
 * 20000, is far too many rows to render in jsdom).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/google-iap-management/bulk-import-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-iap-management/bulk-import-contract")>();
  return { ...actual, MAX_DROPPED_ROWS: 2 };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

import { BulkImportWizard } from "./BulkImportWizard";

function installFetch(refusedCount: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/pricing-templates/availability")) return { ok: false, json: async () => ({}) } as unknown as Response;
    if (url.includes("/bulk-import/preview")) {
      return {
        ok: true,
        json: async () => ({
          rows: [
            {
              rowNumber: 1, sku: "sku1", baseCurrency: "USD", basePriceDecimal: "0.99", listings: [],
              exists: false, tierCandidates: [], defaultTierSelection: null, tierMatchedBy: "none",
            },
          ],
          refusedRows: Array.from({ length: refusedCount }, (_, i) => ({ rowNumber: 10 + i, sku: `r${i}`, reason: "x." })),
          warnings: [],
        }),
      } as unknown as Response;
    }
    if (url.includes("hub-tracking")) return { ok: true, json: async () => ({ run_id: null }) } as unknown as Response;
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

async function goToPreview() {
  // Continue is gated until the availability check resolves (Part A) — wait
  // for it to be ENABLED, not merely present (a click on the disabled button
  // does nothing, which made this flaky under load).
  await waitFor(() => expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled(), { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  const input = (await waitFor(() => {
    const el = document.querySelector("#bulk-upload-file");
    if (!el) throw new Error("upload input not rendered yet");
    return el;
  })) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "iaps.xlsx")] } });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Preview/ })).toBeEnabled(), { timeout: 5000 });
  fireEvent.click(screen.getByRole("button", { name: /^Preview/ }));
  await screen.findByText(/Push to Google Play/, {}, { timeout: 5000 });
}

const PROPS = { packageName: "com.vng.cap", appId: "app-1", appDisplayName: "Cap", iapsLastSyncedAt: "2026-10-16T03:25:10.000Z" };

afterEach(() => vi.unstubAllGlobals());

describe("H4.3 — Push is disabled above the shared left-out limit", () => {
  it("at the limit (2): Push enabled", async () => {
    vi.stubGlobal("fetch", installFetch(2));
    render(<BulkImportWizard {...PROPS} />);
    await goToPreview();
    expect(screen.getByRole("button", { name: /Push to Google Play/ })).toBeEnabled();
  });

  it("above it (3): Push disabled, and the title says why and what to do", async () => {
    vi.stubGlobal("fetch", installFetch(3));
    render(<BulkImportWizard {...PROPS} />);
    await goToPreview();
    const push = screen.getByRole("button", { name: /Push to Google Play/ });
    expect(push).toBeDisabled();
    expect(push).toHaveAttribute("title", "3 rows cannot be imported — more than 2 in one push; clean the file");
  });
});
