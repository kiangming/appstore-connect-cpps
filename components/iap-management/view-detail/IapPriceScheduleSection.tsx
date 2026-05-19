/**
 * IAP.p2.d — Price Schedule section.
 *
 * Composes p2.b primitives + the new sub-tables (UpcomingChangesTable,
 * PricesTableExpandable) into the mockup-defined layout:
 *
 *   SectionShell (Price Schedule, helper line, trailing "All Prices…" link)
 *   └─ ExpandablePanel "In-App Purchase Pricing" (defaultOpen)
 *      ├─ Base Country/Region row
 *      ├─ Upcoming Changes table
 *      └─ Prices table (summary / show-all toggle)
 *
 * Three render branches:
 *   - `priceScheduleError` set → amber inline notice (degraded — IAP and
 *     other sections still render).
 *   - `priceSchedule === null` → empty-state placeholder ("Push via Edit
 *     to set one").
 *   - schedule present → full layout.
 *
 * Future / current splitting uses the page-load `now()`; entries whose
 * startDate is in the future move into Upcoming Changes.
 */
import { Plus } from "lucide-react";
import {
  SectionShell,
  ExpandablePanel,
  LabeledField,
} from "@/components/ui/iap";
import { tooltipFor } from "@/lib/iap-management/tooltips";
import { territoryName } from "./territory-name";
import { UpcomingChangesTable } from "./UpcomingChangesTable";
import { PricesTableExpandable } from "./PricesTableExpandable";
import type {
  PriceScheduleView,
  PriceScheduleEntry,
} from "@/lib/iap-management/queries/iap-detail";

export interface IapPriceScheduleSectionProps {
  priceSchedule: PriceScheduleView | null;
  priceScheduleError?: string | null;
  /** Optional injection seam for tests — defaults to `new Date()`. */
  now?: Date;
}

function partition(
  entries: readonly PriceScheduleEntry[],
  now: Date,
): { current: PriceScheduleEntry[]; upcoming: PriceScheduleEntry[] } {
  const current: PriceScheduleEntry[] = [];
  const upcoming: PriceScheduleEntry[] = [];
  const ts = now.getTime();
  for (const e of entries) {
    const startTs = e.startDate ? new Date(e.startDate).getTime() : null;
    if (startTs !== null && startTs > ts) {
      upcoming.push(e);
    } else {
      current.push(e);
    }
  }
  return { current, upcoming };
}

export function IapPriceScheduleSection({
  priceSchedule,
  priceScheduleError,
  now = new Date(),
}: IapPriceScheduleSectionProps) {
  if (priceScheduleError) {
    return (
      <SectionShell
        title="Price Schedule"
        description="Couldn't fetch the latest pricing from Apple."
      >
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"
        >
          The rest of this page still reflects the latest IAP data. Try
          refreshing; if the error persists, check the ASC credentials.
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-amber-700">
            {priceScheduleError}
          </pre>
        </div>
      </SectionShell>
    );
  }

  if (!priceSchedule) {
    return (
      <SectionShell
        title="Price Schedule"
        description="No pricing has been set on Apple yet."
      >
        <div className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-xs italic text-slate-400">
          Use Edit to set a price; Apple will equalize the rest of the
          territories from the base price.
        </div>
      </SectionShell>
    );
  }

  const { current, upcoming } = partition(priceSchedule.entries, now);

  return (
    <SectionShell
      title="Price Schedule"
      description="Below is a summary of your current pricing and any upcoming changes."
      titleAdornment={
        <span
          aria-label="Add price change via Edit"
          title="Edit to add a price change"
          className="text-slate-300"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </span>
      }
      trailing={
        <span className="text-xs font-medium text-slate-400 shrink-0">
          All Prices and Currencies →
        </span>
      }
      flushBody
    >
      <ExpandablePanel title="In-App Purchase Pricing" defaultOpen>
        <div className="pt-4 border-t border-slate-100">
          <LabeledField
            label="Base Country or Region"
            tip={tooltipFor("base-territory")}
          >
            {/* IAP.p2.k: base price is resolved via Stage 3 (automaticPrices
                filtered by base territory) — Apple stores the base in
                automaticPrices, NOT manualPrices. `basePrice` may be null
                when Stage 3 fails or returns no row; we still render the
                territory name so Manager sees the base location. */}
            <p>
              <span className="font-medium">
                {territoryName(priceSchedule.baseTerritory)}
              </span>
              {priceSchedule.basePrice?.currency && (
                <span className="text-slate-400">
                  {" "}
                  ({priceSchedule.basePrice.currency})
                </span>
              )}
              {priceSchedule.basePrice && (
                <>
                  <span className="text-slate-400 mx-2">·</span>
                  <span className="font-mono text-slate-600">
                    {priceSchedule.basePrice.customerPrice}
                  </span>
                </>
              )}
            </p>
          </LabeledField>
        </div>

        <UpcomingChangesTable entries={upcoming} />

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Prices
            </h3>
          </div>
          <PricesTableExpandable
            entries={current}
            baseTerritory={priceSchedule.baseTerritory}
          />
        </div>
      </ExpandablePanel>
    </SectionShell>
  );
}
