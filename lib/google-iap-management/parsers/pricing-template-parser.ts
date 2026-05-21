/**
 * Parse Manager-provided Google pricing-template Excel file (g1.j).
 *
 * Expected file: docs/google-iap-management/templates/pricing-template-google.xlsx
 *
 * Sheet structure:
 *   Sheet name:  "price_tiers"
 *   Col A row 0: empty (tier-identifier column has no header)
 *   Col B+ row 0: "<CC> - <CUR> - <CountryName>" (e.g. "VN - VND - Vietnam")
 *   Rows 1..N:   Col A = tier identifier (e.g. "Tier 1"); Cols B+ = decimal
 *                price in that territory's currency.
 *
 * Sparse: missing (tier, region) cells fall back to Google's auto-equalization
 * at IAP-application time; we only store populated cells.
 *
 * Decimal → micros conversion happens here so the repository only ever sees
 * Google's wire format.
 */
import * as XLSX from "xlsx";

import { decimalToMicros } from "../google/price-conversion";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const EXPECTED_SHEET = "price_tiers";
const TERRITORY_HEADER_RE = /^\s*([A-Z]{2})\s*-\s*([A-Z]{3})\s*-\s*(.+?)\s*$/;

export interface ParsedPricingEntry {
  identifier: string;
  regionCode: string;
  currency: string;
  /** Google wire format (digits-only string). */
  priceMicros: string;
}

export interface PricingTemplateParseResult {
  entries: ParsedPricingEntry[];
  tierCount: number;
  territoryCount: number;
  warnings: string[];
  errors: string[];
}

interface TerritorySpec {
  col: number;
  region: string;
  currency: string;
}

function parseTerritoryHeader(
  raw: string,
): { region: string; currency: string } | null {
  const m = raw.match(TERRITORY_HEADER_RE);
  if (!m) return null;
  return { region: m[1], currency: m[2] };
}

function cellValue(
  ws: XLSX.WorkSheet,
  r: number,
  c: number,
): string | number | null {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return null;
  if (cell.v === null || cell.v === undefined) return null;
  return cell.v as string | number;
}

export function parsePricingTemplate(
  buffer: ArrayBuffer | Buffer,
  byteLength: number,
): PricingTemplateParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (byteLength > MAX_FILE_SIZE) {
    errors.push(`File too large (${byteLength} bytes); cap is ${MAX_FILE_SIZE}.`);
    return { entries: [], tierCount: 0, territoryCount: 0, warnings, errors };
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (err) {
    errors.push(
      `Failed to open workbook: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { entries: [], tierCount: 0, territoryCount: 0, warnings, errors };
  }

  const sheetName = wb.SheetNames.includes(EXPECTED_SHEET)
    ? EXPECTED_SHEET
    : wb.SheetNames[0];
  if (!sheetName) {
    errors.push("Workbook has no sheets.");
    return { entries: [], tierCount: 0, territoryCount: 0, warnings, errors };
  }
  if (sheetName !== EXPECTED_SHEET) {
    warnings.push(
      `Expected sheet "${EXPECTED_SHEET}", using "${sheetName}" instead.`,
    );
  }
  const ws = wb.Sheets[sheetName];
  if (!ws["!ref"]) {
    errors.push(`Sheet "${sheetName}" is empty.`);
    return { entries: [], tierCount: 0, territoryCount: 0, warnings, errors };
  }

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const territorySpecs: TerritorySpec[] = [];

  // Header row scan. Col 0 is tier identifier (no header). Cols 1+ are
  // territory headers we must match.
  for (let c = range.s.c + 1; c <= range.e.c; c += 1) {
    const raw = cellValue(ws, range.s.r, c);
    if (raw === null || String(raw).trim() === "") continue;
    const parsed = parseTerritoryHeader(String(raw));
    if (!parsed) {
      warnings.push(
        `Unrecognised territory header at column ${c + 1}: "${raw}". Skipped.`,
      );
      continue;
    }
    territorySpecs.push({
      col: c,
      region: parsed.region,
      currency: parsed.currency,
    });
  }

  if (territorySpecs.length === 0) {
    errors.push(
      "No valid territory columns found. Expected headers like \"US - USD - United States\".",
    );
    return { entries: [], tierCount: 0, territoryCount: 0, warnings, errors };
  }

  // Data rows.
  const entries: ParsedPricingEntry[] = [];
  const seenTiers = new Set<string>();

  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const idCell = cellValue(ws, r, range.s.c);
    if (idCell === null) continue;
    const identifier = String(idCell).trim();
    if (identifier === "") continue;

    if (seenTiers.has(identifier)) {
      warnings.push(`Duplicate identifier "${identifier}" at row ${r + 1}; ignored.`);
      continue;
    }
    seenTiers.add(identifier);

    for (const spec of territorySpecs) {
      const v = cellValue(ws, r, spec.col);
      if (v === null) continue;
      const decimal =
        typeof v === "number"
          ? Number.isInteger(v)
            ? String(v)
            : v.toFixed(6).replace(/\.?0+$/, "")
          : String(v).trim();
      if (decimal === "") continue;
      try {
        const priceMicros = decimalToMicros(decimal);
        entries.push({
          identifier,
          regionCode: spec.region,
          currency: spec.currency,
          priceMicros,
        });
      } catch (err) {
        warnings.push(
          `Row ${r + 1} ("${identifier}") col ${spec.region}: "${decimal}" rejected (${
            err instanceof Error ? err.message : "invalid"
          }).`,
        );
      }
    }
  }

  if (entries.length === 0) {
    warnings.push("No populated cells found.");
  }

  return {
    entries,
    tierCount: seenTiers.size,
    territoryCount: territorySpecs.length,
    warnings,
    errors,
  };
}
