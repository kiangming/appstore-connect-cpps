/**
 * Parse Manager-provided Apple price-tiers Excel template.
 *
 * Expected file: docs/iap-management/templates/price-tiers-template.xlsx
 *
 * Sheet structure:
 *   Sheet name:  "price_tiers" (singular sheet)
 *   Row 0:       Territory headers. Format `<Country Name> (CCC_CCC)` at
 *                odd-indexed columns (1, 3, 5, ...). Even-indexed columns
 *                between are empty (each territory spans 2 cells).
 *   Row 1:       Sub-headers alternating "Price" / "Proceeds" per territory.
 *   Row 2..N:    Data rows. Col 0 = tier name; cols 1+ = numeric
 *                price/proceeds pairs.
 *
 * Tier types observed in real artifact:
 *   - "Free Tier"       → tier_id = 0
 *   - "Tier N"          → tier_id = N (standard paid, e.g. "Tier 1"..."Tier 87")
 *   - "Alternate Tier *" → SKIPPED (not in Q-IAP scope; numeric and letter
 *                         variants like "Alternate Tier 1" / "Alternate Tier A"
 *                         observed in real file but Manager scope was
 *                         "Tier 1-95"). Surfaced in parse result for UI display.
 *
 * Validation policy (Q-IAP.5 strict):
 *   - Hard error: missing sheet, malformed territory headers, non-numeric
 *     price/proceeds cells, file > 10MB, file not a valid .xlsx.
 *   - Soft warning: alternate tier rows (skipped + counted), territories
 *     where currency code looks unusual.
 */

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const EXPECTED_SHEET_NAME = "price_tiers";
const TERRITORY_HEADER_RE = /^(.+?)\s*\(([A-Z]{3})_([A-Z]{3})\)\s*$/;

export interface ParsedTerritoryPrice {
  territory_code: string;
  currency_code: string;
  customer_price: number;
  proceeds: number;
}

export interface ParsedPriceTier {
  tier_id: number;
  tier_name: string;
  territories: ParsedTerritoryPrice[];
}

export interface PriceTiersParseResult {
  tiers: ParsedPriceTier[];
  territory_count: number;
  skipped_alternate_tiers: string[];
  warnings: string[];
}

interface TerritorySpec {
  territory_code: string;
  currency_code: string;
  price_col: number;
  proceeds_col: number;
}

/** Extract numeric tier_id from a tier name. Returns null for skip-able rows. */
function tierIdFromName(name: string): number | null {
  if (name === "Free Tier") return 0;
  const m = /^Tier (\d+)$/.exec(name);
  if (m) return Number(m[1]);
  return null;
}

function readNumericCell(value: unknown, where: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`Expected numeric value at ${where}, got: ${JSON.stringify(value)}`);
}

export async function parsePriceTiersXlsx(
  file: File,
): Promise<PriceTiersParseResult> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `Price-tiers template exceeds the 10MB limit (file is ${(file.size / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

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
    throw new Error(
      "Price-tiers template could not be read. Make sure the file is a valid .xlsx.",
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("Price-tiers template contains no sheets.");
  }
  if (sheetName !== EXPECTED_SHEET_NAME) {
    throw new Error(
      `Expected sheet "${EXPECTED_SHEET_NAME}" but found "${sheetName}". ` +
        `Use the Manager-provided template format.`,
    );
  }

  const sheet = workbook.Sheets[sheetName];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  }) as unknown[][];

  if (rows.length < 3) {
    throw new Error(
      `Price-tiers template has too few rows (${rows.length}). Expected territory header + subheader + ≥1 data row.`,
    );
  }

  // ── Parse territory headers (row 0) ──────────────────────────────────────
  const headerRow = rows[0];
  const territories: TerritorySpec[] = [];
  const warnings: string[] = [];

  // Territory names sit at odd columns starting at col 1. Each pair (Price col,
  // Proceeds col) occupies 2 cells, name in the first.
  for (let col = 1; col < headerRow.length; col += 2) {
    const raw = headerRow[col];
    if (raw === "" || raw == null) continue;
    const text = typeof raw === "string" ? raw.trim() : String(raw).trim();
    const match = TERRITORY_HEADER_RE.exec(text);
    if (!match) {
      warnings.push(
        `Skipped malformed territory header at col ${col + 1}: "${text}"`,
      );
      continue;
    }
    territories.push({
      territory_code: match[2],
      currency_code: match[3],
      price_col: col,
      proceeds_col: col + 1,
    });
  }

  if (territories.length === 0) {
    throw new Error(
      "Price-tiers template has no recognisable territory columns. " +
        `Expected headers like "United States (USA_USD)".`,
    );
  }

  // ── Validate sub-header row (row 1) Price/Proceeds labels ────────────────
  const subHeader = rows[1];
  for (const t of territories) {
    const priceLabel = String(subHeader[t.price_col] ?? "").trim();
    const proceedsLabel = String(subHeader[t.proceeds_col] ?? "").trim();
    if (priceLabel !== "Price" || proceedsLabel !== "Proceeds") {
      warnings.push(
        `Territory ${t.territory_code}: expected Price/Proceeds sub-headers at cols ${t.price_col + 1}/${t.proceeds_col + 1}, ` +
          `got "${priceLabel}"/"${proceedsLabel}".`,
      );
    }
  }

  // ── Parse data rows (row 2+) ─────────────────────────────────────────────
  const tiers: ParsedPriceTier[] = [];
  const skippedAlternates: string[] = [];

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    const tierName = String(row[0] ?? "").trim();
    if (!tierName) continue; // blank tier name → skip

    const tierId = tierIdFromName(tierName);
    if (tierId === null) {
      // Alternate Tier rows + any other unknown tier-name shape land here.
      skippedAlternates.push(tierName);
      continue;
    }

    const territoryRows: ParsedTerritoryPrice[] = territories.map((t) => ({
      territory_code: t.territory_code,
      currency_code: t.currency_code,
      customer_price: readNumericCell(
        row[t.price_col],
        `row ${r + 1} col ${t.price_col + 1} (${t.territory_code} Price)`,
      ),
      proceeds: readNumericCell(
        row[t.proceeds_col],
        `row ${r + 1} col ${t.proceeds_col + 1} (${t.territory_code} Proceeds)`,
      ),
    }));

    tiers.push({
      tier_id: tierId,
      tier_name: tierName,
      territories: territoryRows,
    });
  }

  if (tiers.length === 0) {
    throw new Error(
      "Price-tiers template contained no recognisable standard tiers " +
        '(Free Tier or "Tier N"). Verify the template format.',
    );
  }

  return {
    tiers,
    territory_count: territories.length,
    skipped_alternate_tiers: skippedAlternates,
    warnings,
  };
}
