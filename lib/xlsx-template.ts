/**
 * Shared XLSX template generator — the bulk-import "Download template"
 * button in Apple IAP Management and Google IAP Management.
 *
 * TEMPLATE ≠ EXPORT. This builds a blank form: a headers-only data sheet
 * plus a Notes sheet the parsers ignore. The export builders
 * (lib/iap-management/xlsx-export.ts, lib/google-iap-management/
 * xlsx-export.ts) dump live store data and are a separate feature —
 * untouched by this module.
 *
 * The data sheet ships with 3 PRE-FILLED example rows (Manager decision,
 * August 2026 — reverses the earlier headers-only layout) using the
 * genericized sample Product IDs below. Because those IDs don't exist on
 * any store, an accidental import would silently CREATE them — so both
 * modules' parsers SKIP rows whose Product ID is in
 * TEMPLATE_SAMPLE_PRODUCT_IDS and surface the skip as an explicit
 * outcome. The const lives here so the generator and BOTH parsers read
 * the same list — the skip guard cannot drift from the template.
 *
 * Client-safe: `downloadXlsxTemplate` lazy-loads xlsx (same pattern as
 * the Apple client-side parser, lib/iap-management/parsers/iap-items.ts),
 * so importing this module adds nothing to the initial bundle.
 * `buildTemplateWorkbook` takes the XLSX module as a parameter so tests
 * can import xlsx statically and round-trip the generated workbook
 * through the real parsers in Node.
 *
 * Per-module column specs live next to their parsers
 * (lib/iap-management/parsers/template-spec.ts,
 * lib/google-iap-management/parsers/template-spec.ts) — the parser and
 * the generator consume the same exported consts, so a parser column
 * change that forgets the template fails the anti-drift tests instead of
 * reaching users.
 */

type XlsxModule = typeof import("xlsx");

/** Sample Product IDs used by BOTH modules' example rows. Single source
 *  of truth shared by the template generators (which write these rows)
 *  and the parsers (which skip them on import) — see the module doc
 *  above for why the skip guard exists. Genericized from the Manager's
 *  source files (real test IDs replaced). */
export const TEMPLATE_SAMPLE_PRODUCT_IDS: readonly string[] = [
  "com.vngg.tool.product.sample01",
  "com.vngg.tool.product.sample02",
  "com.vngg.tool.product.sample03",
];

/** Warning placed in the data sheet directly under the example rows, in
 *  a row with an EMPTY Product ID cell — both parsers skip ID-less rows,
 *  so the note is visible in Excel but invisible to the import. */
export const TEMPLATE_SAMPLE_ROWS_NOTE =
  "⚠ The 3 rows above are SAMPLES — delete them or replace them with your real products. Rows keeping the sample Product IDs are skipped automatically on import.";

/** One selectable locale in the download modal. `name` is the KEY the
 *  parser matches in the header (`Display Name (<name>)` / `Title
 *  (<name>)`), so it is also what a selection is expressed in.
 *  `language` / `country` / `code` are DISPLAY-only strings precomputed
 *  into each module's spec — deriving them at runtime would drag a
 *  country library into the client bundle for no functional gain.
 *  `country` is "—" for language-only locales (no region subtag, no
 *  parenthetical): do NOT invent one. */
export interface LocaleOption {
  name: string;
  language: string;
  country: string;
  code: string;
}

/** Resolve a caller's selection against a module's canonical locale
 *  order. `undefined` = FULL set (so pre-picker callers and the
 *  spec-identity tests keep their exact previous output); an empty
 *  array = core-columns-only, a first-class supported output. Selection
 *  order never matters — emission follows the canonical order so a
 *  template's columns are reproducible. */
export function resolveSelectedLocales(
  canonicalNames: readonly string[],
  selected: readonly string[] | undefined,
): string[] {
  if (selected === undefined) return [...canonicalNames];
  const wanted = new Set(selected);
  return canonicalNames.filter((n) => wanted.has(n));
}

/** Download filename for a selection: the full set keeps the module's
 *  base name (byte-for-byte the pre-picker download, so existing docs
 *  and habits stay valid), zero locales gets `-core`, and a partial
 *  selection is tagged with its COUNT. Two different N-locale sets do
 *  share a name — the browser de-dupes with "(1)"; a full locale
 *  manifest in the filename gets unwieldy past ~3. */
export function templateFilenameFor(
  baseFilename: string,
  selectedCount: number,
  totalCount: number,
): string {
  if (selectedCount >= totalCount) return baseFilename;
  const stem = baseFilename.replace(/\.xlsx$/i, "");
  if (selectedCount === 0) return `${stem}-core.xlsx`;
  return `${stem}-${selectedCount}-locale${selectedCount === 1 ? "" : "s"}.xlsx`;
}

export interface XlsxTemplateSpec {
  /** Name of the data sheet — the sheet the module's parser selects BY
   *  NAME (sheet-selection hardening, design §C). */
  dataSheetName: string;
  /** Canonical header row of the data sheet. */
  headers: readonly string[];
  /** Pre-filled rows under the headers: the 3 sample rows, a spacer and
   *  the in-sheet warning note row (empty Product ID cell → parsers
   *  ignore it). */
  dataRows: ReadonlyArray<ReadonlyArray<string | number>>;
  notesSheetName: string;
  notesRows: ReadonlyArray<ReadonlyArray<string | number>>;
  filename: string;
}

/** Pure workbook assembly: data sheet (headers + sample rows) first,
 *  Notes sheet second. Order is cosmetic — the parsers select the data
 *  sheet by name, never by position. */
export function buildTemplateWorkbook(
  XLSX: XlsxModule,
  spec: XlsxTemplateSpec,
) {
  const wb = XLSX.utils.book_new();

  const dataWs = XLSX.utils.aoa_to_sheet([
    [...spec.headers],
    ...spec.dataRows.map((row) => [...row]),
  ]);
  dataWs["!cols"] = spec.headers.map((h) => ({
    wch: Math.min(40, Math.max(14, h.length + 2)),
  }));
  XLSX.utils.book_append_sheet(wb, dataWs, spec.dataSheetName);

  const notesWs = XLSX.utils.aoa_to_sheet(
    spec.notesRows.map((row) => [...row]),
  );
  notesWs["!cols"] = [{ wch: 42 }, { wch: 12 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, notesWs, spec.notesSheetName);

  return wb;
}

/** Browser-only: generate the workbook and trigger a download — the same
 *  blob → anchor-click delivery the export buttons use (see
 *  IapListClient in both modules). */
export async function downloadXlsxTemplate(
  spec: XlsxTemplateSpec,
): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = buildTemplateWorkbook(XLSX, spec);
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = spec.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
