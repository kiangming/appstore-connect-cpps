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
 * The data sheet carries NO example rows by design: example rows left in
 * a data sheet import as real store IAPs with no error (both legacy
 * Manager artifacts shipped 3 such rows — the failure this layout
 * removes). Illustrative examples belong in the Notes sheet, which the
 * parsers never read.
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

export interface XlsxTemplateSpec {
  /** Name of the data sheet — the sheet the module's parser selects BY
   *  NAME (sheet-selection hardening, design §C). */
  dataSheetName: string;
  /** Canonical header row — the ONLY content of the data sheet. */
  headers: readonly string[];
  notesSheetName: string;
  notesRows: ReadonlyArray<ReadonlyArray<string | number>>;
  filename: string;
}

/** Pure workbook assembly: data sheet (headers only) first, Notes sheet
 *  second. Order is cosmetic — the parsers select the data sheet by
 *  name, never by position. */
export function buildTemplateWorkbook(
  XLSX: XlsxModule,
  spec: XlsxTemplateSpec,
) {
  const wb = XLSX.utils.book_new();

  const dataWs = XLSX.utils.aoa_to_sheet([[...spec.headers]]);
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
