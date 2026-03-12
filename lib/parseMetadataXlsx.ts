import { localeCodeFromName } from "@/lib/locale-utils";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export interface ExcelCppRow {
  cppName: string;
  deepLink: string | null;
  /** locale short-code (e.g. "vi", "en-US") → promo text */
  promoTexts: Record<string, string>;
}

export interface ExcelMetadata {
  /** Rows indexed by cppName (exact, case-sensitive) */
  rows: ExcelCppRow[];
  /** Map for O(1) lookup: cppName → ExcelCppRow */
  byName: Map<string, ExcelCppRow>;
}

/**
 * Parse metadata.xlsx (root-level file in CPP bulk import folder).
 *
 * Expected sheet structure (first sheet):
 *   Row 0 (header): CPP Name | Deep Link | <Locale Name> | <Locale Name> | ...
 *   Row 1..N:        <name>  | <url>     | <promo text>  | ...
 *
 * Locale column headers must be Apple user-friendly names ("Vietnamese",
 * "English (U.S.)") — mapped to BCP-47 short-codes via localeCodeFromName().
 * Unrecognised locale headers are silently skipped.
 *
 * Throws an Error with a user-readable message on:
 * - File > 5MB
 * - File cannot be read / is corrupt
 * - Missing required header columns "CPP Name" or "Deep Link"
 */
export async function parseMetadataXlsx(file: File): Promise<ExcelMetadata> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `metadata.xlsx exceeds the 5MB size limit (file is ${(file.size / 1024 / 1024).toFixed(1)}MB)`
    );
  }

  // Dynamic import — only loaded when needed
  const XLSX = await import("xlsx");

  let workbook: ReturnType<typeof XLSX.read>;
  try {
    const buffer = await file.arrayBuffer();
    workbook = XLSX.read(buffer, {
      type: "array",
      cellFormula: false,
      cellHTML: false,
    });
  } catch {
    throw new Error("metadata.xlsx could not be read. Make sure the file is a valid .xlsx file.");
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("metadata.xlsx contains no sheets.");
  }
  const sheet = workbook.Sheets[sheetName];

  // Convert to 2D array (header + rows)
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  }) as unknown[][];

  if (raw.length === 0) {
    throw new Error("metadata.xlsx is empty.");
  }

  // ── Validate header row ────────────────────────────────────────────────────
  const headers = (raw[0] as unknown[]).map((h) =>
    typeof h === "string" ? h.trim() : String(h ?? "").trim()
  );

  const nameColIdx = headers.indexOf("CPP Name");
  const deepLinkColIdx = headers.indexOf("Deep Link");

  if (nameColIdx === -1) {
    throw new Error('metadata.xlsx: Missing required column "CPP Name".');
  }
  if (deepLinkColIdx === -1) {
    throw new Error('metadata.xlsx: Missing required column "Deep Link".');
  }

  // ── Map locale columns: header index → BCP-47 short-code ──────────────────
  const localeColMap: Array<{ colIdx: number; localeCode: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    if (i === nameColIdx || i === deepLinkColIdx) continue;
    const header = headers[i];
    if (!header) continue;
    const code = localeCodeFromName(header);
    if (code) {
      localeColMap.push({ colIdx: i, localeCode: code });
    }
    // Unrecognised locale column headers are silently ignored
  }

  // ── Parse data rows ────────────────────────────────────────────────────────
  const rows: ExcelCppRow[] = [];
  const byName = new Map<string, ExcelCppRow>();

  for (let rowIdx = 1; rowIdx < raw.length; rowIdx++) {
    const row = raw[rowIdx] as unknown[];

    const cppName = String(row[nameColIdx] ?? "").trim();
    if (!cppName) continue; // skip empty rows

    const deepLinkRaw = String(row[deepLinkColIdx] ?? "").trim();
    const deepLink = deepLinkRaw || null;

    const promoTexts: Record<string, string> = {};
    for (const { colIdx, localeCode } of localeColMap) {
      const text = String(row[colIdx] ?? "").trim();
      if (text) {
        promoTexts[localeCode] = text;
      }
    }

    const entry: ExcelCppRow = { cppName, deepLink, promoTexts };
    rows.push(entry);
    byName.set(cppName, entry);
  }

  return { rows, byName };
}
