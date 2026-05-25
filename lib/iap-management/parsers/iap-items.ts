/**
 * Parse Manager-provided Apple IAP-item Excel template.
 *
 * Expected file: docs/iap-management/templates/item-iap-template.xlsx
 *
 * Header schema (Hotfix 27 — restored §3.3 Cycle 29 IAP.h2 institutional
 * lock: name-based column lookup, NOT positional). Only two headers are
 * required; everything else is optional with a documented fallback.
 *
 *   "Product ID"           REQUIRED — string, immutable (Apple regex: [A-Za-z0-9_.-]+)
 *   "Reference Name"       REQUIRED — string, max 64 chars (Apple constraint)
 *   "Type"                 optional — enum CONSUMABLE / NON_CONSUMABLE /
 *                                     NON_RENEWING_SUBSCRIPTION. Empty cell
 *                                     OR column absent → CONSUMABLE default
 *                                     (§3.3 institutional lock). Invalid
 *                                     value with column present → row error.
 *   "Price (USD)"          optional — numeric, drives tier inference downstream.
 *                                     Empty / column absent → 0 (pricing stage
 *                                     skips with `skipped-no-tier`).
 *   "GT Price"             optional — numeric, base-territory price. Empty /
 *                                     column absent → 0.
 *   "GT Currency"          optional — string, base-territory currency code.
 *                                     Empty / column absent → "" (pricing
 *                                     stage skips on missing base currency).
 *
 *   Locale pair columns (any position after the lead columns):
 *           [Display Name (<Locale Name>), Description (<Locale Name>)]
 *           Locale names are Apple user-friendly format (e.g. "English (U.S.)").
 *           Mapped to BCP-47 codes via lib/locale-utils.localeCodeFromName.
 *           Display Name must be immediately followed by its matching
 *           Description column — the pair is the unit of locale data.
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

/** Only these two columns are REQUIRED. Everything else has a safe default
 *  per the §3.3 institutional lock (Hotfix 27 restoration). The other lead
 *  headers the parser recognises are "Type" / "Price (USD)" / "GT Price" /
 *  "GT Currency" — all optional. */
const REQUIRED_LEAD_HEADERS = ["Product ID", "Reference Name"] as const;

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

/** Hotfix 27 — only invoked when the column EXISTS in the template. A
 *  missing column resolves to col=-1 and the caller short-circuits to
 *  the documented default (0). Empty cells under a present column still
 *  short-circuit to 0 here. Invalid contents (e.g. "abc") remain a
 *  row-level error because the institutional lock distinguishes
 *  "absent/empty → default" from "invalid → row error". */
function readOptionalCellNumber(
  value: unknown,
  label: string,
  rowIdx: number,
): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return 0;
    const n = Number(trimmed.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  throw new Error(
    `Row ${rowIdx + 1}: expected numeric ${label}, got "${String(value)}"`,
  );
}

/** Hotfix 27 — name-based lookup. Trims + matches case-insensitively so
 *  Manager templates with stylistic variations ("product id", "PRODUCT ID")
 *  still resolve. Returns -1 when the header is absent. */
function findHeaderIndex(headers: readonly string[], name: string): number {
  const target = name.trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] ?? "").trim().toLowerCase() === target) return i;
  }
  return -1;
}

interface LeadColumnIndex {
  productId: number;
  referenceName: number;
  type: number;
  priceUsd: number;
  gtPrice: number;
  gtCurrency: number;
}

/** Read a known column by its resolved index; returns "" when the column
 *  was absent (idx === -1) so callers don't need separate branches. */
function readCol(row: unknown[], idx: number): string {
  if (idx < 0) return "";
  return readCellString(row[idx]);
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

  // ── Name-based header resolution (Hotfix 27 — §3.3 IAP.h2 institutional
  //    lock restoration). Required columns: Product ID + Reference Name.
  //    Every other lead column is optional; missing columns surface as a
  //    resolved index of -1 and the per-row reader falls back to a
  //    documented default.
  const header = rows[0].map((c) =>
    typeof c === "string" ? c.trim() : String(c ?? "").trim(),
  );

  for (const required of REQUIRED_LEAD_HEADERS) {
    if (findHeaderIndex(header, required) < 0) {
      throw new Error(
        `IAP-item template is missing the required "${required}" column. ` +
          `Required columns: ${REQUIRED_LEAD_HEADERS.join(", ")}.`,
      );
    }
  }

  const leadIdx: LeadColumnIndex = {
    productId: findHeaderIndex(header, "Product ID"),
    referenceName: findHeaderIndex(header, "Reference Name"),
    type: findHeaderIndex(header, "Type"),
    priceUsd: findHeaderIndex(header, "Price (USD)"),
    gtPrice: findHeaderIndex(header, "GT Price"),
    gtCurrency: findHeaderIndex(header, "GT Currency"),
  };

  /** The set of column indices already claimed by lead headers. Used below
   *  so the locale-pair scan doesn't try to interpret a lead column as a
   *  locale-header. */
  const leadClaimed = new Set<number>(
    Object.values(leadIdx).filter((i) => i >= 0),
  );

  // ── Discover locale pair columns ─────────────────────────────────────────
  // Locale columns can appear in any position outside the lead set. We scan
  // for Display Name headers, skip lead columns + previously-claimed pair
  // columns, and verify each Display Name is immediately followed by its
  // matching Description column.
  const pairs: LocalePairSpec[] = [];
  const skippedLocales: string[] = [];
  const warnings: string[] = [];

  let col = 0;
  while (col < header.length) {
    if (leadClaimed.has(col)) {
      col++;
      continue;
    }
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
    const productId = readCol(row, leadIdx.productId);
    if (!productId) continue; // blank product ID → skip silently (likely empty row)

    const referenceName = readCol(row, leadIdx.referenceName);
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

    // Type (§3.3 IAP.h2 institutional lock):
    //   - column absent OR empty cell → CONSUMABLE default (DEFAULT source).
    //   - column present + valid enum value → use the value (COLUMN source).
    //   - column present + invalid value → row error (NOT silent default).
    const typeRaw = readCol(row, leadIdx.type);
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

    // Price (USD) / GT Price / GT Currency — all optional per §3.3 lock.
    // Missing column OR empty cell → safe default (0 / 0 / ""). Downstream
    // pricing-orchestration treats price_usd=0 or empty base_currency as
    // "no tier to resolve" and skips the pricing stage gracefully.
    const priceUsd =
      leadIdx.priceUsd < 0
        ? 0
        : readOptionalCellNumber(row[leadIdx.priceUsd], "Price (USD)", r);
    const basePrice =
      leadIdx.gtPrice < 0
        ? 0
        : readOptionalCellNumber(row[leadIdx.gtPrice], "GT Price", r);
    const baseCurrency = readCol(row, leadIdx.gtCurrency);

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
