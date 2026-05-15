/**
 * Parse Manager-provided Apple IAP-item Excel template.
 *
 * Expected file: docs/iap-management/templates/item-iap-template.xlsx
 *
 * Header schema (Manager Q-IAP.5 strict validation):
 *   Col 0: "Product ID"          — string, immutable (Apple regex: [A-Za-z0-9_.-]+)
 *   Col 1: "Reference Name"      — string, max 64 chars (Apple constraint)
 *   Col 2: "Type"                — enum CONSUMABLE / NON_CONSUMABLE /
 *                                  NON_RENEWING_SUBSCRIPTION. Empty cell →
 *                                  default CONSUMABLE (Manager IAP.h2 lock).
 *                                  Invalid value → row error.
 *   Col 3: "Price (USD)"         — numeric, base price (drives tier inference)
 *   Col 4: "GT Price"            — numeric, base-territory price
 *   Col 5: "GT Currency"         — string, base-territory currency code
 *   Col 6..: locale pairs in this exact order per template:
 *           [Display Name (<Locale Name>), Description (<Locale Name>)]
 *           Locale names are Apple user-friendly format (e.g. "English (U.S.)").
 *           Mapped to BCP-47 codes via lib/locale-utils.localeCodeFromName.
 *           Unrecognised locale names are skipped + surfaced as warnings.
 *
 * Empty-cell policy (Manager directive "có cái nào import cái đó"):
 *   - If BOTH Display Name + Description are empty for a locale → locale not
 *     imported for that row (silent skip — expected behaviour).
 *   - If ONE is empty + ONE filled → validation warning (partial fill),
 *     locale still skipped (paired data integrity preserved).
 *
 * Tier inference (Manager IAP.h2 lock) does NOT live in this parser — it
 * needs DB access to price_tier_territories. Callers run
 * `resolveTierByUsdPrice(item.price_usd, usdTiers)` (queries/price-tiers.ts)
 * after parsing.
 */

import { localeCodeFromName } from "@/lib/locale-utils";
import type { InAppPurchaseType } from "@/types/iap-management/apple";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const LEAD_HEADERS = [
  "Product ID",
  "Reference Name",
  "Type",
  "Price (USD)",
  "GT Price",
  "GT Currency",
] as const;

const TYPE_VALUES: readonly InAppPurchaseType[] = [
  "CONSUMABLE",
  "NON_CONSUMABLE",
  "NON_RENEWING_SUBSCRIPTION",
] as const;

const LOCALE_HEADER_RE = /^(Display Name|Description) \((.+)\)$/;

export interface ParsedIapLocalization {
  locale: string;       // BCP-47 short-code, e.g. "en-US"
  locale_name: string;  // friendly name, e.g. "English (U.S.)"
  display_name: string;
  description: string;
}

export interface ParsedIapItem {
  row_index: number;        // 1-based row number in source spreadsheet
  product_id: string;
  reference_name: string;
  type: InAppPurchaseType;
  type_source: "COLUMN" | "DEFAULT";  // for audit log (IAP.h2)
  price_usd: number;
  base_price: number;
  base_currency: string;
  localizations: ParsedIapLocalization[];
  warnings: string[];       // row-specific warnings (e.g. partial locale fill)
}

export interface IapItemsParseResult {
  items: ParsedIapItem[];
  /** Locale header names not found in lib/locale-utils — silently skipped. */
  skipped_locales: string[];
  /** Detected locale pair count in the header (informational; spec ≈ 39). */
  locale_pair_count: number;
  warnings: string[];
}

interface LocalePairSpec {
  display_col: number;
  description_col: number;
  locale: string;
  locale_name: string;
}

function readCellString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

function readCellNumber(value: unknown, label: string, rowIdx: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  throw new Error(
    `Row ${rowIdx + 1}: expected numeric ${label}, got "${String(value)}"`,
  );
}

export async function parseIapItemsXlsx(
  file: File,
): Promise<IapItemsParseResult> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `IAP-item template exceeds the 10MB limit (file is ${(file.size / 1024 / 1024).toFixed(1)}MB)`,
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
      "IAP-item template could not be read. Make sure the file is a valid .xlsx.",
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("IAP-item template contains no sheets.");
  }

  const sheet = workbook.Sheets[sheetName];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  }) as unknown[][];

  if (rows.length < 2) {
    throw new Error(
      `IAP-item template has too few rows (${rows.length}). Expected header + ≥1 data row.`,
    );
  }

  // ── Strict header validation (Q-IAP.5) ───────────────────────────────────
  const header = rows[0].map((c) =>
    typeof c === "string" ? c.trim() : String(c ?? "").trim(),
  );

  for (let i = 0; i < LEAD_HEADERS.length; i++) {
    if (header[i] !== LEAD_HEADERS[i]) {
      throw new Error(
        `IAP-item template header mismatch at column ${i + 1}: ` +
          `expected "${LEAD_HEADERS[i]}", got "${header[i] ?? "(empty)"}". ` +
          `Use the Manager-provided template format.`,
      );
    }
  }

  // ── Discover locale pair columns (cols 5+) ───────────────────────────────
  // Templates pair them as [Display Name (X), Description (X)] in order. We
  // scan for Display Name headers and verify each is immediately followed by
  // a matching Description column.
  const pairs: LocalePairSpec[] = [];
  const skippedLocales: string[] = [];
  const warnings: string[] = [];

  let col = LEAD_HEADERS.length;
  while (col < header.length) {
    const cell = header[col];
    if (!cell) {
      col++;
      continue;
    }
    const displayMatch = LOCALE_HEADER_RE.exec(cell);
    if (!displayMatch || displayMatch[1] !== "Display Name") {
      warnings.push(
        `Skipped unexpected header at column ${col + 1}: "${cell}" (expected "Display Name (Locale)")`,
      );
      col++;
      continue;
    }
    const localeName = displayMatch[2];
    const nextCell = header[col + 1] ?? "";
    const descMatch = LOCALE_HEADER_RE.exec(nextCell);
    if (!descMatch || descMatch[1] !== "Description" || descMatch[2] !== localeName) {
      throw new Error(
        `IAP-item template: "Display Name (${localeName})" at column ${col + 1} ` +
          `is not followed by a matching "Description (${localeName})" column.`,
      );
    }
    const code = localeCodeFromName(localeName);
    if (!code) {
      skippedLocales.push(localeName);
    } else {
      pairs.push({
        display_col: col,
        description_col: col + 1,
        locale: code,
        locale_name: localeName,
      });
    }
    col += 2;
  }

  // ── Parse data rows (1+) ─────────────────────────────────────────────────
  const items: ParsedIapItem[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const productId = readCellString(row[0]);
    if (!productId) continue; // blank product ID → skip silently (likely empty row)

    const referenceName = readCellString(row[1]);
    if (!referenceName) {
      throw new Error(
        `Row ${r + 1}: Reference Name is required for product "${productId}".`,
      );
    }
    if (referenceName.length > 64) {
      throw new Error(
        `Row ${r + 1}: Reference Name "${referenceName}" exceeds Apple's 64-character limit.`,
      );
    }

    // Col 2: Type (Manager IAP.h2 lock). Empty → default CONSUMABLE.
    // Invalid value → row error (not silent default).
    const typeRaw = readCellString(row[2]);
    let type: InAppPurchaseType;
    let typeSource: "COLUMN" | "DEFAULT";
    if (typeRaw === "") {
      type = "CONSUMABLE";
      typeSource = "DEFAULT";
    } else if ((TYPE_VALUES as readonly string[]).includes(typeRaw)) {
      type = typeRaw as InAppPurchaseType;
      typeSource = "COLUMN";
    } else {
      throw new Error(
        `Row ${r + 1}: Invalid Type value "${typeRaw}". Expected ${TYPE_VALUES.join(" / ")}.`,
      );
    }

    const priceUsd = readCellNumber(row[3], "Price (USD)", r);
    const basePrice = readCellNumber(row[4], "GT Price", r);
    const baseCurrency = readCellString(row[5]);
    if (!baseCurrency) {
      throw new Error(
        `Row ${r + 1}: GT Currency is required for product "${productId}".`,
      );
    }

    const itemWarnings: string[] = [];
    const localizations: ParsedIapLocalization[] = [];

    for (const pair of pairs) {
      const displayName = readCellString(row[pair.display_col]);
      const description = readCellString(row[pair.description_col]);

      // Both empty → skip silently (Manager "có cái nào import cái đó")
      if (!displayName && !description) continue;

      // Partial fill → warn + skip (preserve paired integrity)
      if (!displayName || !description) {
        itemWarnings.push(
          `Locale "${pair.locale_name}": partial fill (${displayName ? "Display Name only" : "Description only"}) — skipped.`,
        );
        continue;
      }

      localizations.push({
        locale: pair.locale,
        locale_name: pair.locale_name,
        display_name: displayName,
        description,
      });
    }

    items.push({
      row_index: r + 1,
      product_id: productId,
      reference_name: referenceName,
      type,
      type_source: typeSource,
      price_usd: priceUsd,
      base_price: basePrice,
      base_currency: baseCurrency,
      localizations,
      warnings: itemWarnings,
    });
  }

  if (items.length === 0) {
    throw new Error(
      "IAP-item template contained no data rows with Product ID. Verify the template.",
    );
  }

  return {
    items,
    skipped_locales: skippedLocales,
    locale_pair_count: pairs.length,
    warnings,
  };
}
