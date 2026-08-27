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
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
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
  // ⚠ KEYS, NOT VALUES. `getAlpha3Codes()` maps alpha3 → alpha2
  // (`{ AFG: "AF", … }`), so `Object.values` hands back ALPHA-2 — and this
  // fixture stands in for Apple, which speaks alpha-3. The first draft got
  // this backwards and the test still looked plausible: `toCatalogCode("AF")`
  // finds no alpha-3 match and falls through to the raw string, so the
  // columns came out as "AF" and the names still resolved. What gave it away
  // was the COUNT — 171 instead of 175, because HK/ID/MO/MY collided with the
  // manual HKG/IDN/MAC/MYS after conversion. A fixture is a claim about
  // Apple (P27); this one was quietly claiming the wrong alphabet.
  const all: string[] = Object.keys(
    countries.getAlpha3Codes() as Record<string, string>,
  );
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

  /**
   * ⚠ THIS NUMBER HAS MOVED TWICE, AND NEITHER MOVE WAS A REBASELINE.
   *
   *   F-C  175  — "every territory Apple priced gets a column", correct while
   *               `null` meant the union of what happened to have a price.
   *   F-B  194  — [Q-EXPORT.union-columns]: catalog(183) ∪ Apple(175), so a
   *               market nobody priced still gets asked. Correct while the
   *               picker offered all 183.
   *   G4   175  — [Q-EXPORT.apple-only-picker]: G3 made the picker Apple's
   *               175, so the 19 catalog-only markets cannot be ticked, and a
   *               column for an unaskable question is not an answer.
   *
   * One rule throughout — *answer every question that can be asked, and only
   * those*. What moved each time is which questions the picker permits. That
   * is why the assertion is edited with the reason each time instead of being
   * deleted, and why a sibling test proves coverage rather than just a count.
   */
  it("⚠ all 175 columns — exactly the markets Apple sells to", () => {
    const priceCols = header.filter((h) => h.startsWith("Price in "));
    expect(priceCols).toHaveLength(175);
  });

  it("⚠ and the 19 markets Apple does not sell to are GONE from the file", () => {
    // The picker cannot offer them since G3; the file must not carry them
    // either, or it answers a question nobody was allowed to ask.
    expect(header).not.toContain("Price in Andorra (AD)");
    expect(header).not.toContain("Price in Monaco (MC)");
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


/**
 * ─── F-B — "ALL COUNTRIES" MEANS EVERY COUNTRY, NOT EVERY PRICED COUNTRY ────
 *
 * The fixture below is the case the union exists for: Apple prices this item
 * in a handful of markets and NOT in Germany, while Germany is a market the
 * operator can tick. Before F-B, ticking "all" produced no German column at
 * all — the question was deleted rather than answered.
 *
 * MUTATIONS, all three red:
 *   route falls back to the priced union   → DE and RU columns vanish
 *   expand from the catalog only           → RU vanishes (not in the catalog)
 *   expand from Apple's list only          → the 19 tickable markets vanish
 */
describe("⚠ F-B — a market nobody priced still gets a column, with `—` in it", () => {
  const SOLD_IN = ["USA", "VNM", "THA"] as const;

  let header: string[];
  let wb2: ExcelJS.Workbook;

  beforeAll(async () => {
    requireIapSession.mockResolvedValue({ email: "manager@vng.com.vn" });
    getActiveAccount.mockResolvedValue({
      key_id: "K", issuer_id: "I", private_key: "P", id: "acct-1",
    });
    appleFetch.mockReset();
    appleFetch.mockImplementation(async (c: unknown, m: string, e: string) => {
      // ⚠ Only three territories priced, and NO automaticPrices beyond them:
      // this item genuinely is not sold in most of the world.
      if (e.startsWith(`/v1/inAppPurchasePriceSchedules/${SCHEDULE_ID}/manualPrices`)) {
        return priceRows(SOLD_IN, true);
      }
      if (e.startsWith(`/v1/inAppPurchasePriceSchedules/${SCHEDULE_ID}/automaticPrices`)) {
        return priceRows([], false);
      }
      return appleRouter(c, m, e);
    });

    const res2 = await runExport({ territories: null });
    expect(res2.status).toBe(200);
    ({ wb: wb2 } = await unzipResponse(res2));
    header = headerRow(wb2);
  });

  it("still 175 columns — the ask does not shrink to fit the data", () => {
    // ⚠ G4: was 194. Same reasoning as the header block above — the picker
    // changed, so the set of askable questions changed. The property under
    // test is unchanged: the column set does NOT shrink to whatever happened
    // to have a price, which for this fixture is three markets.
    expect(header.filter((h) => h.startsWith("Price in "))).toHaveLength(175);
  });

  it("⚠ Germany is priced NOWHERE on this item, and still has a column reading `—`", () => {
    const de = header.indexOf("Price in Germany (DE)");
    expect(de).toBeGreaterThan(0);
    // Row 3 = the single data row. `—` in BOTH halves of the pair.
    expect(wb2.worksheets[0].getCell(3, de).value).toBe("\u2014");
    expect(wb2.worksheets[0].getCell(3, de + 1).value).toBe("\u2014");
  });

  it("⚠ RUSSIA has a column — the market the shared catalog cannot reach", () => {
    // The point of unioning Apple's list in: RU is absent from
    // TERRITORY_CATALOG, so a catalog-only expansion silently omits it.
    const ru = header.indexOf("Price in Russia (RU)");
    expect(ru).toBeGreaterThan(0);
    expect(wb2.worksheets[0].getCell(3, ru).value).toBe("\u2014");
  });

  it("⚠ G4 INVERTED THIS — Andorra has NO column, because it is no longer tickable", () => {
    // F-B asserted the opposite, and was right then: the dialog offered
    // Andorra, so dropping its column would have been a silent drop. G3
    // removed it from the picker, so carrying the column would now be the
    // defect instead. Inverted rather than deleted — the pair records a rule
    // holding while its input moved.
    expect(header.indexOf("Price in Andorra (AD)")).toBe(-1);
  });

  it("the three real prices are still real — expansion adds columns, it does not blank them", () => {
    const us = header.indexOf("Price in United States (US)");
    expect(wb2.worksheets[0].getCell(3, us).value).toBe("0.99");
    expect(wb2.worksheets[0].getCell(3, us + 1).value).toBe("USD");
  });

  it("⚠ and the file does NOT lie: no failure sheet, so every blank-looking cell is `—`", () => {
    // The E5 cross-constraint, re-checked at route level now that 191 of the
    // 172 of the 175 columns have no price. If any rendered BLANK instead of `—`
    // the file would be claiming a failed read that never happened.
    expect(wb2.worksheets.map((w) => w.name)).toEqual(["Apple IAP Export"]);
    const ws = wb2.worksheets[0];
    const firstPriceCol = header.findIndex((h) => h.startsWith("Price in "));
    let blanks = 0;
    for (let c = firstPriceCol; c < firstPriceCol + 175 * 2; c += 1) {
      if (ws.getCell(3, c).value == null) blanks += 1;
    }
    expect(blanks).toBe(0);
  });
});


/**
 * ─── G4.5 — WHAT `—` MEANS AFTER THE PICKER BECAME APPLE'S 175 ─────────────
 *
 * ⚠ THIS TEST EXISTS TO KEEP A SENTENCE IN THE USER GUIDE TRUE.
 *
 * E5 introduced `—` with the meaning "Apple does not sell here", and that was
 * accurate while the picker offered 19 markets Apple does not sell in. G3
 * removed those from the picker and G4 removed their columns, so that reading
 * is now almost never the reason a cell is `—`.
 *
 * The census asked whether `—` had therefore become dead code. It has not,
 * and this is the path that keeps it alive: an IAP with **no price schedule
 * at all** — a freshly created product, `MISSING_METADATA`, nobody has priced
 * it yet. `getPriceScheduleForIap` throws `NoPriceScheduleError`, export-fetch
 * maps that to `priceSchedule: null` with `priceReadFailure: null`
 * (export-fetch.ts:283-286), and every one of the 175 columns renders `—`.
 *
 * The export scope is ALL IAPs in ALL states (route.ts:9), so these rows are
 * not hypothetical — they are in most real files.
 *
 * ⇒ `—` now means "**this IAP has no price for that market**", which is what
 * G6 must write into the guide. Without this test that sentence would rest on
 * a code reading rather than on observed behaviour.
 */
describe("⚠ G4.5 — an IAP with no price schedule reads `—` across all 175", () => {
  let header: string[];
  let wb3: ExcelJS.Workbook;
  let sheetNames: string[];

  beforeAll(async () => {
    requireIapSession.mockResolvedValue({ email: "manager@vng.com.vn" });
    getActiveAccount.mockResolvedValue({
      key_id: "K", issuer_id: "I", private_key: "P", id: "acct-1",
    });
    appleFetch.mockReset();
    appleFetch.mockImplementation(async (c: unknown, m: string, e: string) => {
      // Apple's way of saying "this IAP has no price schedule": 404 on the
      // schedule sub-resource. Stage 1, so it becomes NoPriceScheduleError.
      if (e.startsWith(`/v2/inAppPurchases/${APPLE_IAP_ID}/iapPriceSchedule`)) {
        throw new AppleApiError(404, "GET", e, "NOT_FOUND");
      }
      return appleRouter(c, m, e);
    });

    const res3 = await runExport({ territories: null });
    expect(res3.status).toBe(200);
    ({ wb: wb3 } = await unzipResponse(res3));
    header = headerRow(wb3);
    sheetNames = wb3.worksheets.map((w) => w.name);
  });

  it("the row still exports — a priceless IAP is not a failed IAP", () => {
    expect(String(wb3.worksheets[0].getCell(3, 1).value)).toBe("com.vnggames.aoiaf.0.99");
    expect(header.filter((h) => h.startsWith("Price in "))).toHaveLength(175);
  });

  it("⚠ EVERY price cell reads `—`, and not one is blank", () => {
    const ws = wb3.worksheets[0];
    const first = header.findIndex((h) => h.startsWith("Price in "));
    let dashes = 0;
    let blanks = 0;
    for (let c = first; c < first + 175 * 2; c += 1) {
      const v = ws.getCell(3, c).value;
      if (v === "\u2014") dashes += 1;
      else if (v == null) blanks += 1;
    }
    // 175 columns × (Price, Currency) = 350 cells, all answered.
    expect(dashes).toBe(350);
    expect(blanks).toBe(0);
  });

  it("⚠ and there is NO failure sheet — nothing failed, so nothing is owed one", () => {
    // The E5 cross-constraint from the other side: `—` must never imply a
    // failure row, and a missing schedule is not a failed read.
    expect(sheetNames).toEqual(["Apple IAP Export"]);
    expect(String(wb3.worksheets[0].getCell(1, 1).value)).toBe("Product ID");
  });

  it("Base Country is blank too — there is no schedule to have a base", () => {
    // ⚠ BLANK, not `—`. The `—`/blank rule is about PRICE cells answering
    // "does this item have a price here". Base Country is a fixed column
    // asking something else, and it has no answer to give.
    expect(wb3.worksheets[0].getCell(3, 4).value).toBeNull();
  });
});


/**
 * ─── G5 — SNAPSHOT DRIFT REACHES THE MANAGER, NOT JUST RAILWAY ─────────────
 *
 * ⚠ WHY THIS BECAME URGENT AT G3. Before it, a stale snapshot meant the export
 * had a wrong number of columns — annoying, self-correcting, visible in the
 * file. Since G3 the snapshot decides what the PICKER OFFERS, so a stale one
 * means **a market Apple sells in that the Manager cannot select at all**.
 * That is a different severity and it needs a different surface: the existing
 * `unknownAppleTerritories` warning goes to a server log nobody reading the
 * export screen can see.
 */
describe("⚠ G5 — the export reports territories the snapshot has never heard of", () => {
  const UNKNOWN = ["ZZA", "ZZB"];

  async function exportWith(territories: readonly string[]) {
    requireIapSession.mockResolvedValue({ email: "manager@vng.com.vn" });
    getActiveAccount.mockResolvedValue({
      key_id: "K", issuer_id: "I", private_key: "P", id: "acct-1",
    });
    appleFetch.mockReset();
    appleFetch.mockImplementation(async (c: unknown, m: string, e: string) => {
      if (e.startsWith(`/v1/inAppPurchasePriceSchedules/${SCHEDULE_ID}/manualPrices`)) {
        return priceRows(territories, true);
      }
      if (e.startsWith(`/v1/inAppPurchasePriceSchedules/${SCHEDULE_ID}/automaticPrices`)) {
        return priceRows([], false);
      }
      return appleRouter(c, m, e);
    });
    return runExport({ territories: null });
  }

  it("⚠ names the CODES in a header — not a count", () => {
    // A count is unactionable: "2 unknown territories" cannot tell a Manager
    // whether to care. Seeing the codes can.
    return exportWith([...MANUAL_TERRITORIES, ...UNKNOWN]).then((res) => {
      expect(res.status).toBe(200);
      const header = res.headers.get("X-Export-Unknown-Territories");
      expect(header).toBe("ZZA ZZB");
      // ⚠ MUTATION (c): emit a count and this fails — the value must not be
      // parseable as a bare number.
      expect(header).not.toMatch(/^\d+$/);
    });
  });

  it("⚠ MUTATION (b) — WARNS, never blocks: the file still downloads in full", () => {
    // F-B's rule, still standing: a stale snapshot must never withhold real
    // data. The unknown markets export too — they simply cannot be ticked.
    return exportWith([...MANUAL_TERRITORIES, ...UNKNOWN]).then(async (res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
      const { wb } = await unzipResponse(res);
      // the row is there, and so are the prices we did know about
      expect(String(wb.worksheets[0].getCell(3, 1).value)).toBe("com.vnggames.aoiaf.0.99");
      expect(headerRow(wb)).toContain("Price in United States (US)");
    });
  });

  it("⚠ VACUITY GUARD — a clean export emits NO drift header at all", () => {
    // 5.6. Without this, every assertion above could pass while the header
    // was emitted unconditionally, and the Manager would see a warning on
    // every single export until they stopped reading it.
    return exportWith(MANUAL_TERRITORIES).then((res) => {
      expect(res.headers.has("X-Export-Unknown-Territories")).toBe(false);
    });
  });

  it("⚠ THE BLIND SPOT, NAMED: a territory Apple REMOVED raises nothing here", () => {
    // NOT A BUG, AND NOT FIXABLE AT THIS LAYER. The input is "territories
    // Apple priced", so a market Apple dropped simply stops appearing and
    // there is nothing for this mechanism to notice. Only the probe's
    // whole-list diff (step 2.7) compares both directions.
    //
    // Named as a test so the limitation cannot quietly become an assumption —
    // the F-B S2 lesson: (a) is complete and forgettable, (b) is automatic and
    // half-blind, and neither alone is enough.
    const appleDroppedNine = MANUAL_TERRITORIES.slice(0, 1);
    return exportWith(appleDroppedNine).then((res) => {
      expect(res.headers.has("X-Export-Unknown-Territories")).toBe(false);
    });
  });

  it("the five pinned headers keep their meanings alongside the new one", () => {
    // Parity, asserted rather than assumed: G5 adds a SIXTH header and
    // redefines none of the five from b171eeb.
    return exportWith([...MANUAL_TERRITORIES, ...UNKNOWN]).then((res) => {
      expect(res.headers.get("X-Export-Item-Count")).toBe("1");
      expect(res.headers.get("X-Export-Failed-Count")).toBe("0");
      expect(res.headers.get("X-Export-Partial-Count")).toBe("0");
      expect(res.headers.get("X-Export-Not-Attempted-Count")).toBe("0");
      expect(res.headers.has("X-Export-Stopped")).toBe(false);
    });
  });
});
