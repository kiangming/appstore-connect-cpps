/**
 * Cycle 36 — CSV export for the pricing-template matrix view.
 *
 * Manager Q6 (locked 2026-05-23): include a CSV-download button next to
 * "Replace .xlsx" that emits the **active filter set** (not the entire
 * template) so Manager can hand-review a subset offline. Filename
 * convention encodes the scope + timestamp.
 *
 * The format is intentionally lossless at the entry level — one row per
 * cell — so the file round-trips through Excel/Google Sheets without
 * pivot-table magic. Header columns:
 *   tier_identifier, region_code, country_name, currency, price
 *
 * For the Per-App view, when a Default-Template comparison is available
 * the writer also surfaces a `default_price` column so the diff
 * Manager sees on-screen survives the download.
 */
import { microsToDecimal } from "./google/price-conversion";
import { getCurrencyDecimals } from "./google/currency-precision";
import type { MatrixCell, MatrixData, MatrixMarket } from "./queries/template-matrix";

export interface CsvExportInput {
  matrix: MatrixData;
  /** Subset of `matrix.markets` that survive the active filter set.
   *  Caller computes this in the same memo it uses for rendering. */
  filteredMarkets: ReadonlyArray<MatrixMarket>;
  /** When true, include a `default_price` column derived from
   *  `MatrixCell.defaultPriceMicros` (Per-App view). */
  includeDefaultDiff: boolean;
}

/** Format priceMicros for CSV cells — uses the currency's natural
 *  precision (VND → 0 decimals, USD → 2, BHD → 3) so the file matches
 *  what Manager sees on screen. */
export function formatPriceForCsv(
  priceMicros: string | undefined,
  currency: string | undefined,
): string {
  if (!priceMicros || !currency) return "";
  try {
    const decimals = getCurrencyDecimals(currency);
    return microsToDecimal(priceMicros, decimals);
  } catch {
    return priceMicros;
  }
}

/** RFC 4180-style quote escaping — wrap in `"` whenever the field
 *  contains a `,`, a `"`, or a line break; double-up embedded quotes. */
function csvField(value: string): string {
  if (value === "") return "";
  const needsQuote = /[",\r\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

/** Compose the CSV body. Pure string — caller decides how to deliver
 *  it (Blob download in the browser, file write in a test). */
export function buildCsv(input: CsvExportInput): string {
  const { matrix, filteredMarkets, includeDefaultDiff } = input;
  const header = ["tier_identifier", "region_code", "country_name", "currency", "price"];
  if (includeDefaultDiff) header.push("default_price");
  const rows: string[] = [header.map(csvField).join(",")];

  for (const tier of matrix.tiers) {
    for (const market of filteredMarkets) {
      const cell: MatrixCell | undefined =
        matrix.cells[`${tier}|${market.code}`];
      if (!cell) continue; // skip empty cells — keeps CSV row count tight
      const row = [
        tier,
        market.code,
        market.name,
        cell.currency,
        formatPriceForCsv(cell.priceMicros, cell.currency),
      ];
      if (includeDefaultDiff) {
        row.push(
          formatPriceForCsv(cell.defaultPriceMicros, cell.defaultCurrency),
        );
      }
      rows.push(row.map(csvField).join(","));
    }
  }
  return rows.join("\r\n");
}

/** Manager filename convention: `pricing-template-<scope>-<YYYYMMDD-HHmm>.csv`.
 *  Per-App variant tucks in the package name so multiple downloads in
 *  one session don't overwrite. */
export function csvFilename(args: {
  scope: "default" | "per-app";
  packageName?: string;
  now?: Date;
}): string {
  const d = args.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  if (args.scope === "per-app") {
    const slug = (args.packageName ?? "app").replace(/[^a-z0-9._-]+/gi, "_");
    return `pricing-template-per-app-${slug}-${stamp}.csv`;
  }
  return `pricing-template-default-${stamp}.csv`;
}

/** Browser-side download helper. Wraps the Blob URL juggling so the
 *  client component stays declarative. Safe-noop on SSR. */
export function triggerCsvDownload(filename: string, csv: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Prepend BOM so Excel auto-detects UTF-8 (otherwise Excel mangles
  // non-ASCII country names — e.g. Türkiye, Côte d'Ivoire).
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
