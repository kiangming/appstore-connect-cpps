/**
 * CSV parser for App Registry imports.
 *
 * Wraps papaparse + csvRowSchema. Input is raw CSV text (typically from a
 * `<input type="file">` read by the Server Action). Output separates valid
 * rows from rows that failed zod validation, keeping the raw row attached to
 * each error so the UI can render a row-by-row error table.
 *
 * Column format mirrors templates/app-registry-template.csv — see
 * csvRowSchema in ../schemas/app.ts for normalization rules.
 */

import Papa from 'papaparse';

import { csvRowSchema, type CsvRowInput } from '../schemas/app';

export type RawCsvRow = Record<string, string>;

export type ParsedCsvRow = {
  /** 1-indexed row number after the header (matches what a user sees in Excel). */
  rowNumber: number;
  data: CsvRowInput;
  raw: RawCsvRow;
};

export type CsvFieldError = {
  path: string;
  message: string;
};

export type CsvRowError = {
  rowNumber: number;
  raw: RawCsvRow;
  errors: CsvFieldError[];
};

export type CsvParseResult = {
  valid: ParsedCsvRow[];
  errors: CsvRowError[];
  /** Present only when the input itself is malformed (missing required headers, parse failure). */
  fatal?: string;
};

const REQUIRED_HEADERS = ['name', 'active'] as const;

/**
 * Hard cap on rows processed. Protects against accidentally pasting a massive
 * CSV into the Server Action. Team runs ~200 submissions/month — 5000 is
 * >1 year of churn, generous but bounded.
 */
export const CSV_MAX_ROWS = 5000;

export function parseAppRegistryCsv(input: string): CsvParseResult {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { valid: [], errors: [], fatal: 'CSV is empty' };
  }

  const result = Papa.parse<RawCsvRow>(trimmed, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase(),
    dynamicTyping: false,
  });

  const headers = result.meta.fields ?? [];
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    return {
      valid: [],
      errors: [],
      fatal: `Missing required header(s): ${missing.join(', ')}`,
    };
  }

  const rows = result.data;
  if (rows.length > CSV_MAX_ROWS) {
    return {
      valid: [],
      errors: [],
      fatal: `Too many rows (${rows.length}); max ${CSV_MAX_ROWS}`,
    };
  }

  const valid: ParsedCsvRow[] = [];
  const errors: CsvRowError[] = [];

  rows.forEach((rawRow, i) => {
    const rowNumber = i + 1;
    const parsed = csvRowSchema.safeParse(rawRow);
    if (parsed.success) {
      valid.push({ rowNumber, data: parsed.data, raw: rawRow });
    } else {
      errors.push({
        rowNumber,
        raw: rawRow,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(row)',
          message: issue.message,
        })),
      });
    }
  });

  return { valid, errors };
}
