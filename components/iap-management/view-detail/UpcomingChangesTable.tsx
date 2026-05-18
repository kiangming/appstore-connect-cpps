/**
 * IAP.p2.d — Upcoming Changes table for the Price Schedule section.
 *
 * Renders future-dated price entries (entries whose startDate or endDate
 * is in the future). Empty state shows the Q-C placeholder so Manager can
 * tell the fetch succeeded but Apple has no scheduled changes.
 *
 * Server-renderable. Date grouping is identity per row — one row per
 * manualPrice that's flagged future. Sorting comes from p2.a's
 * `unpackPriceSchedule` which orders entries startDate-ASC.
 */
import { Download } from "lucide-react";
import { DataTable, type DataTableColumn } from "@/components/ui/iap";
import { territoryName } from "./territory-name";
import type { PriceScheduleEntry } from "@/lib/iap-management/queries/iap-detail";

export interface UpcomingChangesTableProps {
  entries: readonly PriceScheduleEntry[];
}

interface UpcomingRow {
  key: string;
  dates: string;
  countries: string;
  adjustment: string;
}

function buildRows(entries: readonly PriceScheduleEntry[]): UpcomingRow[] {
  return entries.map((e) => {
    const dates = e.startDate
      ? `From ${e.startDate}`
      : e.endDate
      ? `Until ${e.endDate}`
      : "";
    return {
      key: e.priceId,
      dates,
      countries: `${territoryName(e.territory)} (${e.territory})`,
      adjustment: e.currency
        ? `${e.customerPrice} ${e.currency}`
        : e.customerPrice,
    };
  });
}

const COLUMNS: DataTableColumn<UpcomingRow>[] = [
  { key: "dates", header: "Dates", render: (r) => r.dates },
  { key: "countries", header: "Countries or Regions", render: (r) => r.countries },
  { key: "adjustment", header: "Price Adjustment", render: (r) => r.adjustment },
];

export function UpcomingChangesTable({ entries }: UpcomingChangesTableProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Upcoming Changes
        </h3>
        {/* Q-C placeholder — non-functional in v1; CSV export lands in p3. */}
        <button
          type="button"
          disabled
          className="text-slate-300 cursor-not-allowed"
          aria-label="Download upcoming changes (coming soon)"
          title="Download CSV (coming soon)"
        >
          <Download className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <DataTable
        columns={COLUMNS}
        rows={buildRows(entries)}
        rowKey={(r) => r.key}
        emptyState="No upcoming changes."
      />
    </div>
  );
}
