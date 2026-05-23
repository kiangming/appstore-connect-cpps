/**
 * Cycle 38 — CSV export for the Apple IAP pricing-template matrix view.
 *
 * Apple sibling to the Cycle 36 Google `csv-export.ts`. Same RFC 4180
 * quoting + UTF-8 BOM (so Excel auto-detects UTF-8 and country names
 * like Türkiye / Côte d'Ivoire don't mojibake), same "active filter
 * set" download semantic. Apple data is decimal-native so there's no
 * micros conversion to do.
 *
 * Headers:
 *   tier_id, tier_name, territory_code, country_name, currency,
 *   customer_price[, default_customer_price]
 */
import type {
  MatrixCell,
  MatrixData,
  MatrixMarket,
} from "./queries/template-matrix";

export interface CsvExportInput {
  matrix: MatrixData;
  filteredMarkets: ReadonlyArray<MatrixMarket>;
  includeDefaultDiff: boolean;
}

function csvField(value: string): string {
  if (value === "") return "";
  const needsQuote = /[",\r\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

/** Format a customer-price decimal for the CSV cell. Apple stores the
 *  value as NUMERIC so a plain `toString()` already gives Manager's
 *  expected display ("25000" for VND, "0.99" for USD). Use a defensive
 *  Number cast in case Supabase returns a string. */
export function formatPriceForCsv(value: number | string | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  // Strip insignificant trailing zeros — "25000.0000" → "25000" — but
  // preserve a decimal for fractional currencies ("0.99" stays "0.99").
  const fixed = n.toFixed(4);
  return fixed.replace(/\.?0+$/, "");
}

export function buildCsv(input: CsvExportInput): string {
  const { matrix, filteredMarkets, includeDefaultDiff } = input;
  const header = [
    "tier_id",
    "tier_name",
    "territory_code",
    "country_name",
    "currency",
    "customer_price",
  ];
  if (includeDefaultDiff) header.push("default_customer_price");
  const rows: string[] = [header.map(csvField).join(",")];

  for (const tier of matrix.tiers) {
    for (const market of filteredMarkets) {
      const cell: MatrixCell | undefined =
        matrix.cells[`${tier.tier_id}|${market.code}`];
      if (!cell) continue;
      const row = [
        tier.tier_id,
        tier.tier_name,
        market.code,
        market.name,
        cell.currency,
        formatPriceForCsv(cell.customerPrice),
      ];
      if (includeDefaultDiff) {
        row.push(formatPriceForCsv(cell.defaultCustomerPrice));
      }
      rows.push(row.map(csvField).join(","));
    }
  }
  return rows.join("\r\n");
}

/** Filename convention parallels the Google side: scope + optional
 *  bundle-id slug + YYYYMMDD-HHmm stamp. Apple uses `bundle_id` where
 *  Google uses `package_name`; we accept it as `bundleId` here. */
export function csvFilename(args: {
  scope: "default" | "per-app";
  bundleId?: string;
  now?: Date;
}): string {
  const d = args.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  if (args.scope === "per-app") {
    const slug = (args.bundleId ?? "app").replace(/[^a-z0-9._-]+/gi, "_");
    return `apple-pricing-template-per-app-${slug}-${stamp}.csv`;
  }
  return `apple-pricing-template-default-${stamp}.csv`;
}

export function triggerCsvDownload(filename: string, csv: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
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
