"use client";

/**
 * IAP.p2.d — Q-B "Show all territories" expansion.
 *
 * Default view (summary): one row per "Current Price" bucket + one row per
 * distinct future end-date. Mirrors the mockup's collapsed Prices table.
 *
 * Expanded view: one row per manual-price entry — territory, customer
 * price, currency, start/end dates. Manager toggles via the inline button
 * below the table.
 *
 * The summary count surfaces what Apple actually returned (manual prices
 * only). Apple's auto-equalization layer covers the remaining 175 − N
 * territories implicitly and is NOT enumerated in this view; future work
 * can fetch the equalizations endpoint per the
 * docs/iap-management/sample_flow_create_price.md note.
 */
import { useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/ui/iap";
import { territoryName } from "./territory-name";
import type { PriceScheduleEntry } from "@/lib/iap-management/queries/iap-detail";

export interface PricesTableExpandableProps {
  /** Effective-now entries (already filtered by parent). */
  entries: readonly PriceScheduleEntry[];
  baseTerritory: string;
}

interface SummaryRow {
  key: string;
  dates: string;
  countries: string;
  adjustment: string;
}

interface FullRow {
  key: string;
  territory: string;
  price: string;
  startDate: string;
  endDate: string;
}

function buildSummaryRows(entries: readonly PriceScheduleEntry[]): SummaryRow[] {
  const rows: SummaryRow[] = [];
  // "Current Price" bucket — everything effective-now AND with no endDate.
  const currentBucket = entries.filter((e) => !e.endDate);
  if (currentBucket.length > 0) {
    rows.push({
      key: "current",
      dates: "Current Price",
      countries: `${currentBucket.length} Manual ${
        currentBucket.length === 1 ? "Price" : "Prices"
      } + Auto-Equalized`,
      adjustment: "May Adjust Automatically",
    });
  }
  // One row per distinct future endDate.
  const endBuckets = new Map<string, PriceScheduleEntry[]>();
  for (const e of entries) {
    if (!e.endDate) continue;
    const bucket = endBuckets.get(e.endDate) ?? [];
    bucket.push(e);
    endBuckets.set(e.endDate, bucket);
  }
  for (const [endDate, bucket] of [...endBuckets.entries()].sort()) {
    rows.push({
      key: `end-${endDate}`,
      dates: `Price Ending on ${endDate}`,
      countries: `${bucket.length} Manual ${
        bucket.length === 1 ? "Price" : "Prices"
      }`,
      adjustment: "May Adjust Automatically",
    });
  }
  return rows;
}

function buildFullRows(
  entries: readonly PriceScheduleEntry[],
  baseTerritory: string,
): FullRow[] {
  return entries.map((e) => ({
    key: e.priceId,
    territory: `${territoryName(e.territory)}${
      e.territory === baseTerritory ? " (base)" : ""
    }`,
    price: e.currency
      ? `${e.customerPrice} ${e.currency}`
      : e.customerPrice,
    startDate: e.startDate ?? "—",
    endDate: e.endDate ?? "—",
  }));
}

const SUMMARY_COLUMNS: DataTableColumn<SummaryRow>[] = [
  { key: "dates", header: "Dates", render: (r) => r.dates },
  { key: "countries", header: "Countries or Regions", render: (r) => r.countries },
  { key: "adjustment", header: "Price Adjustment", render: (r) => r.adjustment },
];

const FULL_COLUMNS: DataTableColumn<FullRow>[] = [
  { key: "territory", header: "Country or Region", render: (r) => r.territory },
  { key: "price", header: "Price", render: (r) => r.price },
  { key: "startDate", header: "Effective", render: (r) => r.startDate },
  { key: "endDate", header: "Ends", render: (r) => r.endDate },
];

export function PricesTableExpandable({
  entries,
  baseTerritory,
}: PricesTableExpandableProps) {
  const [expanded, setExpanded] = useState(false);

  if (expanded) {
    return (
      <div>
        <DataTable
          columns={FULL_COLUMNS}
          rows={buildFullRows(entries, baseTerritory)}
          rowKey={(r) => r.key}
          emptyState="No manual prices."
        />
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 text-xs text-[#0071E3] hover:underline"
        >
          ← Show summary
        </button>
      </div>
    );
  }

  const summary = buildSummaryRows(entries);
  return (
    <div>
      <DataTable
        columns={SUMMARY_COLUMNS}
        rows={summary}
        rowKey={(r) => r.key}
        emptyState="No prices set."
      />
      <button
        type="button"
        onClick={() => setExpanded(true)}
        disabled={entries.length === 0}
        className="mt-2 text-xs text-[#0071E3] hover:underline disabled:text-slate-300 disabled:cursor-not-allowed"
      >
        Show all {entries.length} {entries.length === 1 ? "territory" : "territories"} →
      </button>
    </div>
  );
}
