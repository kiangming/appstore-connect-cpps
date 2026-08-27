/**
 * ─── F-C — THE MISSING TEST LAYER ──────────────────────────────────────────
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE EXPORT'S MAIN FEATURE SHIPPED DEAD AND 4 396
 * TESTS STAYED GREEN.
 *
 * E1 taught `getPriceScheduleForIap` to read Apple's `automaticPrices` behind
 * an opt-in flag. Nothing ever passed the flag — `includeAutomatic: true` had
 * zero occurrences in the repo — so the export kept reading only the ~10
 * manually-priced territories while E2…E5 built column ordering, shading,
 * headers and `—`/blank semantics on top of data that was never fetched. The
 * Manager's file after E5: exactly 10 columns, zero amber.
 *
 * THE REASON THE SUITE MISSED IT IS STRUCTURAL, NOT AN OVERSIGHT IN ANY ONE
 * TEST. Every export test fakes Apple AT OR ABOVE the broken link:
 *
 *   route.headers.test.ts       fakes `fetchExportSources`      ← above it
 *   route.selected-ids.test.ts  fakes `getPriceScheduleForIap`  ← AT it
 *   export-fetch.test.ts        injects a `vi.fn()` through deps ← AT it
 *   xlsx-export.test.ts         starts from `ExportSource` fixtures
 *   price-source-attribute      hand-written response that ALREADY contains
 *                               the auto rows (P27 — a fixture is a claim
 *                               about the fetch, not evidence of it)
 *
 * A defect at the link itself is therefore outside every seam at once. No
 * individual test was wrong; the LAYER was missing.
 *
 * So this file fakes Apple at the HTTP boundary — `appleFetch`, the deepest
 * seam there is — and runs everything above it FOR REAL: `iapFetch`,
 * `listAllInAppPurchases`, `getInAppPurchase`, `getIapDetailFromApple`,
 * `getPriceScheduleForIap` (both stages AND the 2b auto walk),
 * `unpackPriceSchedule`, `fetchExportSources`, `buildExportPlan`,
 * `buildExportWorkbook`, and exceljs's real write. Then it unzips the bytes
 * the route actually returned.
 *
 * The only stubs are the two things that are not Apple: the session and the
 * credential lookup.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

// ── The two non-Apple stubs ─────────────────────────────────────────────────
const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/auth")>(
    "@/lib/iap-management/auth",
  );
  return { ...actual, requireIapSession };
});

const getActiveAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));

// ── THE SEAM. Everything Apple-shaped above this line is the real code. ─────
const appleFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shared/apple-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shared/apple-fetch")>(
    "@/lib/shared/apple-fetch",
  );
  // ⚠ `withRetry`, `AppleApiError` and the rate-limit parsing stay REAL —
  // only the network call is replaced. Stubbing the whole module would take
  // the retry composition out of the test along with the transport.
  return { ...actual, appleFetch };
});

import { POST } from "./route";

// ─── THE FIXTURE — Apple's real numbers, from the 2026-08-27 probe ──────────
//
// com.vnggames.aoiaf.0.99 (app 6738648909): manualPrices = 10,
// automaticPrices = 165, total 175 = Apple's whole territory list.
// customerPrice + currency arrive inline via `?include`.

/** The ten the Manager's broken file actually contained, in Apple alpha-3. */
const MANUAL_TERRITORIES = [
  "USA", "HKG", "IDN", "MAC", "MYS", "PHL", "SGP", "TWN", "THA", "VNM",
] as const;

/**
 * 165 automatic territories. Real ISO alpha-3 codes so `toCatalogCode` and
 * `territoryName` behave exactly as they do in production — a made-up code
 * would fall back to the raw string and quietly dodge the conversion this
 * test is partly here to exercise.
 */
const AUTO_TERRITORIES: string[] = (() => {
  countries.registerLocale(enLocale);
  const all: string[] = Object.values(
    countries.getAlpha3Codes() as Record<string, string>,
  ) as string[];
  const manual = new Set<string>(MANUAL_TERRITORIES);
  const picked = all.filter((c) => !manual.has(c)).sort().slice(0, 165);
  if (picked.length !== 165) {
    throw new Error(`fixture needs 165 auto territories, got ${picked.length}`);
  }
  return picked;
})();

/** A few auto markets asserted BY NAME below — recognisable, and spread
 *  across the alphabet so a truncation at either end would show. */
const AUTO_SPOT_CHECKS = [
  { alpha3: "DEU", alpha2: "DE", name: "Germany" },
  { alpha3: "JPN", alpha2: "JP", name: "Japan" },
  { alpha3: "BRA", alpha2: "BR", name: "Brazil" },
] as const;

const SCHEDULE_ID = "sched-1";
const APPLE_IAP_ID = "iap-aoiaf-099";
const APP_ID = "6738648909";

function priceRows(territories: readonly string[], manual: boolean) {
  const data = territories.map((t) => ({
    type: "inAppPurchasePrices",
    id: `price-${t}`,
    attributes: { startDate: null, endDate: null, manual },
    relationships: {
      inAppPurchasePricePoint: { data: { id: `pp-${t}`, type: "inAppPurchasePricePoints" } },
      territory: { data: { id: t, type: "territories" } },
    },
  }));
  // customerPrice + currency INLINE, via the same ?include the real walk uses.
  const included = territories.flatMap((t) => [
    {
      type: "inAppPurchasePricePoints",
      id: `pp-${t}`,
      attributes: { customerPrice: manual ? "0.99" : "1.09", proceeds: "0.70" },
    },
    { type: "territories", id: t, attributes: { currency: manual ? "USD" : "EUR" } },
  ]);
  return { data, included, meta: { paging: { total: territories.length } } };
}

/** Routes an Apple path to a canned response. Throws on anything unexpected —
 *  a silently-answered wrong path is how a fake stops testing the caller. */
function appleRouter(_creds: unknown, _method: string, endpoint: string): unknown {
  if (endpoint.startsWith(`/v1/apps/${APP_ID}/inAppPurchasesV2`)) {
    return {
      data: [
        {
          type: "inAppPurchases",
          id: APPLE_IAP_ID,
          attributes: {
            name: "AoIaF 0.99",
            productId: "com.vnggames.aoiaf.0.99",
            inAppPurchaseType: "CONSUMABLE",
            state: "APPROVED",
          },
        },
      ],
    };
  }
  if (endpoint.startsWith(`/v2/inAppPurchases/${APPLE_IAP_ID}?include=`)) {
    return {
      data: {
        type: "inAppPurchases",
        id: APPLE_IAP_ID,
        attributes: {
          name: "AoIaF 0.99",
          productId: "com.vnggames.aoiaf.0.99",
          inAppPurchaseType: "CONSUMABLE",
          state: "APPROVED",
        },
      },
      included: [
        {
          type: "inAppPurchaseLocalizations",
          id: "loc-en",
          attributes: { locale: "en-US", name: "AoIaF 0.99", description: "Coins" },
        },
      ],
    };
  }
  if (endpoint.startsWith(`/v2/inAppPurchases/${APPLE_IAP_ID}/iapPriceSchedule`)) {
    return {
      data: {
        type: "inAppPurchasePriceSchedules",
        id: SCHEDULE_ID,
        relationships: {
          baseTerritory: { data: { id: "USA", type: "territories" } },
          // ⚠ Stage 1 advertises the ten manual refs and NOTHING about the
          // 165 automatic ones — exactly like Apple. An implementation that
          // hoped to find auto prices here would find none, which is the
          // whole reason a second sub-resource walk exists.
          manualPrices: {
            data: MANUAL_TERRITORIES.map((t) => ({ id: `price-${t}`, type: "inAppPurchasePrices" })),
          },
        },
      },
      included: [],
    };
  }
  if (endpoint.startsWith(`/v1/inAppPurchasePriceSchedules/${SCHEDULE_ID}/manualPrices`)) {
    return priceRows(MANUAL_TERRITORIES, true);
  }
  if (endpoint.startsWith(`/v1/inAppPurchasePriceSchedules/${SCHEDULE_ID}/automaticPrices`)) {
    return priceRows(AUTO_TERRITORIES, false);
  }
  throw new Error(`fixture has no route for: ${endpoint}`);
}

async function runExport(body: unknown) {
  const req = new Request(`http://localhost/api/iap-management/apps/${APP_ID}/export`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return POST(req, { params: { appId: APP_ID } });
}

/** ⚠ Bytes on disk, not the in-memory workbook — same discipline as E3.5. */
async function unzipResponse(res: Response) {
  const dir = mkdtempSync(join(tmpdir(), "iap-export-e2e-"));
  const file = join(dir, "out.xlsx");
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, bytes);
  const part = (name: string) =>
    execFileSync("unzip", ["-p", file, name], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return { part, wb };
}

const AMBER = "FFFFF2CC";

/**
 * Row 1, 1-INDEXED, with merged cells NULLED except at their anchor.
 *
 * ⚠ BOTH HALVES OF THAT SENTENCE ARE LOAD-BEARING. exceljs mirrors a merged
 * range's value across every cell in it, so a naive read reports each
 * 2-wide territory header TWICE and `filter(...).length` says 350 columns
 * where the file stores 175. And `row.values` is 1-based with a hole at [0],
 * which is what makes `indexOf` return a usable exceljs column number — so
 * the hole is kept, not trimmed.
 */
function headerRow(wb: ExcelJS.Workbook): string[] {
  const ws = wb.worksheets[0];
  const out: string[] = [""];
  for (let c = 1; c <= ws.columnCount; c += 1) {
    const cell = ws.getCell(1, c);
    const mirrored = cell.isMerged && cell.master.address !== cell.address;
    out[c] = mirrored || cell.value == null ? "" : String(cell.value);
  }
  return out;
}

describe("⚠ F-C — POST → Apple (faked at the HTTP boundary) → .xlsx bytes", () => {
  let res: Response;
  let part: (name: string) => string;
  let wb: ExcelJS.Workbook;
  let header: string[];

  beforeAll(async () => {
    requireIapSession.mockResolvedValue({ email: "manager@vng.com.vn" });
    getActiveAccount.mockResolvedValue({
      key_id: "K", issuer_id: "I", private_key: "P", id: "acct-1",
    });
    appleFetch.mockReset();
    appleFetch.mockImplementation(async (c: unknown, m: string, e: string) =>
      appleRouter(c, m, e),
    );

    res = await runExport({ territories: null });
    expect(res.status).toBe(200);
    ({ part, wb } = await unzipResponse(res));
    header = headerRow(wb);
  });

  it("⚠ the AUTO sub-resource is actually requested — the request Apple never saw", () => {
    // The most direct statement of the bug: before F-A this call is absent.
    const paths = appleFetch.mock.calls.map((c) => String(c[2]));
    expect(paths.some((p) => p.includes("/automaticPrices"))).toBe(true);
    // …and the manual walk still happens, so this is an addition, not a swap.
    expect(paths.some((p) => p.includes("/manualPrices"))).toBe(true);
  });

  it("⚠ (1) the sheet has AUTO territory columns — not just the 10 manual ones", () => {
    for (const t of AUTO_SPOT_CHECKS) {
      expect(header).toContain(`Price in ${t.name} (${t.alpha2})`);
    }
    // The manual ten are still there — auto is added, nothing displaced.
    expect(header).toContain("Price in United States (US)");
    expect(header).toContain("Price in Thailand (TH)");
  });

  it("⚠ all 175 markets get a column — 10 manual + 165 automatic", () => {
    const priceCols = header.filter((h) => h.startsWith("Price in "));
    expect(priceCols).toHaveLength(175);
  });

  it("⚠ (2) xl/styles.xml carries the amber — at least one cell is shaded AUTO", () => {
    // The Manager's post-E5 file had `<fills count="2">`: none + gray125 and
    // nothing else, because no row was ever `manual: false`.
    const styles = part("xl/styles.xml");
    expect(styles).toContain(AMBER);
    expect(styles).toMatch(/<patternFill[^>]*patternType="solid"/);
  });

  it("⚠ (3) an AUTO cell references that fill, and its MANUAL neighbour does not", () => {
    const ws = wb.worksheets[0];
    const argb = (col: number) => {
      const f = ws.getCell(3, col).fill as { fgColor?: { argb?: string } } | undefined;
      return f?.fgColor?.argb ?? null;
    };
    const colOf = (label: string) => header.indexOf(label);
    // Row 3 = the single data row (2 header rows, no note row: nothing failed).
    const jp = colOf("Price in Japan (JP)");
    const us = colOf("Price in United States (US)");
    expect(jp).toBeGreaterThan(0);
    expect(us).toBeGreaterThan(0);
    expect(argb(jp)).toBe(AMBER); // Apple derived it
    expect(argb(jp + 1)).toBe(AMBER); // …and the currency half moves with it
    expect(argb(us)).toBeNull(); // a human set it
  });

  it("the auto price/currency reach the cells verbatim — the read is not cosmetic", () => {
    const ws = wb.worksheets[0];
    const jp = header.indexOf("Price in Japan (JP)");
    expect(ws.getCell(3, jp).value).toBe("1.09");
    expect(ws.getCell(3, jp + 1).value).toBe("EUR");
  });

  it("manual columns still lead, base territory first — E3's ordering survives", () => {
    const priceCols = header.filter((h) => h.startsWith("Price in "));
    // US is the base territory and manual ⇒ rank 0 ⇒ first of all 175.
    expect(priceCols[0]).toBe("Price in United States (US)");
    // The other nine manual markets occupy ranks 1..9, before any auto one.
    expect(priceCols.slice(0, 10).sort()).toEqual(
      [
        "Price in Hong Kong (HK)", "Price in Indonesia (ID)", "Price in Macau (MO)",
        "Price in Malaysia (MY)", "Price in Philippines (PH)", "Price in Singapore (SG)",
        "Price in Taiwan (TW)", "Price in Thailand (TH)", "Price in United States (US)",
        "Price in Vietnam (VN)",
      ].sort(),
    );
  });

  it("one clean item ⇒ one sheet, no failure sheet, no note row", () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Apple IAP Export"]);
    expect(String(wb.worksheets[0].getCell(1, 1).value)).toBe("Product ID");
    expect(res.headers.get("X-Export-Item-Count")).toBe("1");
    expect(res.headers.get("X-Export-Partial-Count")).toBe("0");
  });
});
