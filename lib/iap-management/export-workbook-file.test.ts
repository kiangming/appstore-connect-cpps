/**
 * E3.5 — DON'T TRUST THE API, READ THE FILE.
 *
 * Every other test in this area asserts against exceljs's object model. That
 * model can hold a fill the writer never serialises — which is exactly how
 * `xlsx@0.18.5` behaves: it ACCEPTS `cell.s = { fill: … }` and silently drops
 * it at write time, leaving `xl/styles.xml` with nothing but the two default
 * patterns. A suite that only asked the object model would have passed on
 * xlsx and shipped a file with no colour in it at all.
 *
 * So these tests write a real .xlsx, unzip it, and read the XML.
 *
 * MUTATION (f): remove the fill and `styles.xml` loses the colour → FAIL.
 * MUTATION (i): shade from the column group instead of the cell attribute and
 * the mixed-column case shades a manual cell → FAIL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportPlan,
  buildExportWorkbook,
  type ExportSource,
} from "./xlsx-export";
import type { PriceScheduleEntry } from "./queries/iap-detail";

const entry = (over: Partial<PriceScheduleEntry>): PriceScheduleEntry => ({
  priceId: "p",
  startDate: null,
  endDate: null,
  territory: "USA",
  customerPrice: "0.99",
  currency: "USD",
  manual: true,
  ...over,
});

const source = (over: Partial<ExportSource>): ExportSource =>
  ({
    productId: "sku-1",
    skuName: "Item",
    status: "APPROVED",
    localizations: [],
    priceReadFailure: null,
    ...over,
  }) as unknown as ExportSource;

const sched = (entries: PriceScheduleEntry[], base = "USA") => ({
  baseTerritory: base,
  basePrice: null,
  entries,
});

/** ⚠ The whole point: bytes on disk, not the in-memory workbook. */
async function writeAndUnzip(wb: Awaited<ReturnType<typeof buildExportWorkbook>>) {
  const dir = mkdtempSync(join(tmpdir(), "iap-export-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));
  const part = (name: string) =>
    execFileSync("unzip", ["-p", file, name], { encoding: "utf8" });
  return { file, part };
}

const AMBER = "FFFFF2CC";

describe("⚠ MUTATION (f) — the AUTO fill really lands in the file", () => {
  let styles: string;
  let sheet: string;

  beforeAll(async () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: sched([
          entry({ territory: "USA", customerPrice: "0.99", manual: true }),
          entry({ priceId: "p2", territory: "THA", customerPrice: "35", currency: "THB", manual: false }),
        ]),
      }),
    ]);
    const out = await writeAndUnzip(buildExportWorkbook(plan));
    styles = out.part("xl/styles.xml");
    sheet = out.part("xl/worksheets/sheet1.xml");
  });

  it("xl/styles.xml carries the amber, not just the two default patterns", () => {
    // This is the assertion xlsx@0.18.5 fails. It wrote patternType="none"
    // and patternType="gray125" and nothing else, whatever the object model
    // had been told.
    expect(styles).toContain(AMBER);
    expect(styles).toMatch(/<patternFill[^>]*patternType="solid"/);
  });

  it("the sheet references a styled cell — the fill is applied, not merely defined", () => {
    // A colour defined in styles.xml but referenced by no cell is a file with
    // an unused palette entry. `s="n"` on a cell is the reference.
    expect(sheet).toMatch(/<c r="[A-Z]+\d+" s="\d+"/);
  });

  it("freeze panes survive the write — 4 fixed columns + both header rows", () => {
    // E3.3. xSplit=4 (the FIXED_COLUMNS block, NOT 5 — a 5-split would pin the
    // first territory's Price and let its Currency scroll away).
    expect(sheet).toMatch(/<pane[^>]*xSplit="4"/);
    expect(sheet).toMatch(/<pane[^>]*ySplit="2"/);
    expect(sheet).toMatch(/state="frozen"/);
  });
});

describe("⚠ MUTATION (i) — the fill follows the CELL, not the column", () => {
  it("in a mixed column, the manual cell is unshaded and the auto cell is shaded", async () => {
    // THE CASE THAT DECIDED THE DESIGN. TH is manual on item A and automatic
    // on item B. Anything that shades per column — from the group, from a
    // header, from a majority — paints one of these two rows a lie.
    const plan = buildExportPlan([
      source({
        productId: "a",
        priceSchedule: sched([
          entry({ territory: "USA", manual: true }),
          entry({ priceId: "p2", territory: "THA", customerPrice: "35", currency: "THB", manual: true }),
        ]),
      }),
      source({
        productId: "b",
        priceSchedule: sched([
          entry({ territory: "USA", manual: true }),
          entry({ priceId: "p3", territory: "THA", customerPrice: "35", currency: "THB", manual: false }),
        ]),
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.worksheets[0];

    // Columns: US (base, manual) then TH (manual by rule α). Rows 3 and 4 are
    // the two data rows; TH's Price sits in column 7 (4 fixed + US pair).
    const fillOf = (r: number, c: number) => {
      const f = ws.getCell(r, c).fill as { fgColor?: { argb?: string } } | undefined;
      return f?.fgColor?.argb ?? null;
    };
    expect(fillOf(3, 7)).toBeNull(); // item a — manual → white
    expect(fillOf(4, 7)).toBe(AMBER); // item b — auto → amber
    // …and the currency half moves with its price, so a shaded pair never
    // renders half-lit.
    expect(fillOf(4, 8)).toBe(AMBER);
  });

  it("⚠ `null` (Apple said nothing) is NOT shaded", async () => {
    // Amber asserts "Apple derived this". Shading an unknown would assert it
    // without evidence; white merely declines to claim.
    const plan = buildExportPlan([
      source({
        priceSchedule: sched([
          entry({ territory: "USA", manual: true }),
          entry({ priceId: "p2", territory: "VNM", customerPrice: "24000", currency: "VND", manual: null }),
        ]),
      }),
    ]);
    const ws = buildExportWorkbook(plan).worksheets[0];
    const f = ws.getCell(3, 7).fill as { fgColor?: { argb?: string } } | undefined;
    expect(f?.fgColor?.argb ?? null).toBeNull();
  });

  it("a clean all-manual export writes NO solid fill at all", async () => {
    // The negative control: if the writer shaded unconditionally, every test
    // above would still pass.
    const plan = buildExportPlan([
      source({ priceSchedule: sched([entry({ territory: "USA", manual: true })]) }),
    ]);
    const { part } = await writeAndUnzip(buildExportWorkbook(plan));
    expect(part("xl/styles.xml")).not.toContain(AMBER);
  });
});

// ─── E4.4 — the header got longer; the geometry must not have moved ────────

describe("⚠ long headers do not shift the merges or the columns", () => {
  it("a 2-wide territory merge still spans exactly its own pair", () => {
    // THE FRAGILE PART OF E4. Merge rectangles are computed from column
    // INDEXES (`FIXED_COLUMNS.length + g * 2`), never from header text — but
    // "Price in United States (US)" is three times the width of the old
    // "Price in US", and a builder that measured text instead of counting
    // columns would drift silently, producing a file that opens fine and is
    // subtly wrong.
    const plan = buildExportPlan([
      source({
        priceSchedule: sched([
          entry({ territory: "USA", manual: true }),
          entry({ priceId: "p2", territory: "THA", customerPrice: "35", currency: "THB", manual: false }),
        ]),
      }),
    ]);
    const ws = buildExportWorkbook(plan).worksheets[0];
    const merges = (ws as unknown as { model: { merges: string[] } }).model.merges;

    // 4 fixed columns merged vertically across both header rows.
    expect(merges).toContain("A1:A2");
    expect(merges).toContain("D1:D2");
    // US pair = E1:F1, TH pair = G1:H1 — unchanged by the longer labels.
    expect(merges).toContain("E1:F1");
    expect(merges).toContain("G1:H1");
  });

  it("the two header rows still line up: long label above Price/Currency", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: sched([entry({ territory: "USA", manual: true })]) }),
    ]);
    const ws = buildExportWorkbook(plan).worksheets[0];
    expect(ws.getCell(1, 5).value).toBe("Price in United States (US)");
    // Row 2 under it is still the sub-header pair, in the same two columns.
    expect(ws.getCell(2, 5).value).toBe("Price");
    expect(ws.getCell(2, 6).value).toBe("Currency");
  });

  it("column widths are still one per column, not one per character", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: sched([entry({ territory: "USA", manual: true })]) }),
    ]);
    const ws = buildExportWorkbook(plan).worksheets[0];
    // 4 fixed + 2 for the single territory. A width array keyed off header
    // text length would have produced a different count.
    expect(ws.getColumn(5).width).toBe(10);
    expect(ws.getColumn(6).width).toBe(10);
  });
});


// ─── E5.1 — the em dash has to survive the write, not just the object model ──

describe("⚠ `—` reaches the bytes on disk, correctly encoded", () => {
  it("the em dash is in the archive as U+2014, not as mojibake or an entity", async () => {
    // THE REASON THIS IS A FILE TEST AND NOT AN OBJECT-MODEL ONE. `—` is the
    // first non-ASCII character this writer emits. A workbook part written
    // latin-1 would round-trip through exceljs's own reader looking fine and
    // open in Excel as "â€"". Only the bytes can say.
    const plan = buildExportPlan([
      source({
        productId: "com.x.us-only",
        priceSchedule: sched([entry({ territory: "USA", manual: true })]),
      }),
      source({
        productId: "com.x.th-only",
        priceSchedule: sched(
          [entry({ priceId: "p2", territory: "THA", customerPrice: "35", currency: "THB", manual: true })],
          "THA",
        ),
      }),
    ]);
    const { part } = await writeAndUnzip(buildExportWorkbook(plan));
    // exceljs writes text cells into the shared-string table.
    const strings = part("xl/sharedStrings.xml");
    expect(strings).toContain("\u2014");
    // …and not as the HTML entity, which Excel renders literally.
    expect(strings).not.toContain("&mdash;");
  });

  it("a `—` cell carries no fill — the amber is reserved for a real auto price", () => {
    // Both territories here are `manual: true`, so nothing at all should be
    // shaded: if the writer shaded the not-sold cells, `styles.xml` would gain
    // the amber and this negative control would catch it.
    const plan = buildExportPlan([
      source({ productId: "a", priceSchedule: sched([entry({ territory: "USA", manual: true })]) }),
      source({
        productId: "b",
        priceSchedule: sched(
          [entry({ priceId: "p2", territory: "THA", customerPrice: "35", currency: "THB", manual: true })],
          "THA",
        ),
      }),
    ]);
    const ws = buildExportWorkbook(plan).worksheets[0];
    // ⚠ Column order re-derived, not assumed: both territories are some row's
    // BASE (a's is USA, b's is THA), so both take rank 0 and sort by name —
    // Thailand at columns 5/6, United States at 7/8. Guessing here is how a
    // cell assertion ends up reading a neighbour and passing for the wrong
    // reason.
    expect(ws.getCell(1, 5).value).toBe("Price in Thailand (TH)");
    expect(ws.getCell(1, 7).value).toBe("Price in United States (US)");
    const fillOf = (r: number, c: number) => {
      const f = ws.getCell(r, c).fill as { fgColor?: { argb?: string } } | undefined;
      return f?.fgColor?.argb ?? null;
    };
    // item a: no TH price → `—`, unshaded. item b: no US price → `—`, unshaded.
    expect(ws.getCell(3, 5).value).toBe("\u2014");
    expect(fillOf(3, 5)).toBeNull();
    expect(ws.getCell(4, 7).value).toBe("\u2014");
    expect(fillOf(4, 7)).toBeNull();
  });
});
