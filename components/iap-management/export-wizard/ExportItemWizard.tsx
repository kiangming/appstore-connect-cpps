"use client";

/**
 * "Export list" — a TWO-STEP wizard: choose items, then choose countries.
 *
 * Design: docs/iap-management/design-export-list-item-selection.md §2.A/2.E/2.G.
 *
 * ⚠ BOTH STEPS COST ZERO APPLE REQUESTS, and that is the primary acceptance
 * criterion of this feature (§2.I.1), not a side benefit. Step 1 filters
 * `iaps` — already a prop on the page — with pure client-side predicates.
 * Step 2's territory list is `TERRITORY_CATALOG`, 183 entries computed at
 * module load from a hardcoded table. Nothing here may ever grow a fetch:
 * the whole point is that the Manager narrows the batch BEFORE paying for it.
 *
 * ⚠ THE APPLE STATUS FILTER SHOWS APPLE'S RAW VALUE — `DEVELOPER_REMOVED_FROM_SALE`,
 * not "Removed". U3 measured `state` against real availability and found them
 * in agreement on 35/35 items across 6 apps and 4 ASC teams, which is why this
 * free filter is usable as an availability proxy at all. But agreement measured
 * is not agreement guaranteed, and the residual case is untested (U3-residual:
 * whether an API-driven removal also flips `state`). Rendering "Removed" would
 * present Apple's status as this tool's verdict on availability, so the day the
 * two axes disagree the Manager would see nothing at all. Showing the raw token
 * keeps a divergence VISIBLE — the surprise stays a surprise.
 *
 * ⚠ Deliberately NOT `stateLabel()` from the list page, which title-cases to
 * "Developer Removed From Sale". That is only cosmetic, but it is the first
 * step toward a friendly word, and this control is the one place the raw value
 * is load-bearing.
 *
 * ⚠ `ExportOptionsDialog` IS NOT MODIFIED. It is shared with the Google IAP
 * module (P8) and has exactly three props; the wizard composes around it from
 * the OUTSIDE, mapping its `onCancel` to "back to step 1, selection intact"
 * because a wizard step's cancel is a wizard decision, not the dialog's.
 *
 * ─── [EXPORT-availability-filter] C6 — the availability axis ───────────────
 *
 * A THIRD facet, "Availability", reading the local mirror
 * (`iap_mgmt.iaps.availability_*`) — still zero Apple requests, because the
 * page already had the map before this dialog opened.
 *
 * ⚠ IT DOES NOT REPLACE THE APPLE STATUS FILTER, AND THAT IS THE POINT.
 * Both facets stay, side by side, showing two different questions about the
 * same item: Apple's review lifecycle (`state`, raw) and Apple's territory
 * reach (availability). U3 measured them in agreement on 35/35 items and it
 * remains an agreement MEASURED, not guaranteed — the tool's own API-driven
 * removal is still untested. Collapsing them into one control would make the
 * day they disagree invisible; keeping both means the Manager can SEE it.
 *
 * ⚠ THREE VALUES, AND "UNKNOWN" IS ONE OF THEM. An item the mirror has never
 * synced is Unknown — never quietly counted as Available. That is the U3
 * defect restated as a filter rule: the earlier "items with an availability
 * relationship are available" idea would have marked every removed item
 * Available, and "no record yet ⇒ available" is the same mistake wearing a
 * different hat.
 *
 * ⚠ AND THE FILTER IS DATED. `asOfLabel` renders how old the mirror is for
 * the items on screen, computed from the OLDEST record, plus how many have
 * never synced at all. A filter over cached data that does not say how stale
 * it is invites the Manager to act on a week-old answer as if it were live.
 */

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import {
  buildExportItemRows,
  partitionExportRows,
  type ExportSelectableRow,
} from "@/lib/iap-management/apple/export-item-rows";
import { ROW_WINDOW_STEP } from "@/lib/iap-management/apple/bulk-item-search";
import type { DraftItemInput } from "@/lib/iap-management/apple/bulk-item-rows";
import { BulkItemPicker } from "@/components/iap-management/item-picker/BulkItemPicker";
import { ExportOptionsDialog } from "@/components/iap-management/ExportOptionsDialog";
import {
  asOfLabel,
  asOfSummary,
  matchesAvailabilityFilter,
  mirrorBucket,
  type AvailabilityFilterValue,
  type AvailabilityMirrorByAppleId,
} from "@/lib/iap-management/apple/availability-as-of";
import type {
  InAppPurchase,
  InAppPurchaseType,
} from "@/types/iap-management/apple";

/** §2.E — the estimate is `3 × selected`, and the copy says "about" because
 *  an item with no price schedule costs 2. Rounding up is the safe direction:
 *  under-promising the cost is what leaves a Manager surprised by a stop. */
const REQUESTS_PER_ITEM = 3;
/** §2.E — the conservative of the two §4.9 rate-limit figures (250 vs 3,600).
 *  A caution, never a block: the Manager asked for stop-and-preserve, not
 *  prevention. Raise if U1 resolves to 3,600. */
const CAUTION_REQUEST_THRESHOLD = 250;

const TYPE_OPTIONS: readonly InAppPurchaseType[] = [
  "CONSUMABLE",
  "NON_CONSUMABLE",
  "NON_RENEWING_SUBSCRIPTION",
];

export interface ExportItemWizardProps {
  open: boolean;
  iaps: readonly InAppPurchase[];
  drafts?: readonly DraftItemInput[];
  appleToInternal?: Readonly<Record<string, string>>;
  /**
   * C6 — the availability mirror, keyed by Apple id. Items absent from it have
   * never been synced and filter as UNKNOWN.
   *
   * ⚠ Optional, and an empty map is a valid state that must render honestly:
   * every item Unknown, the label saying "never synced". It must NOT degrade
   * to "everything is available".
   */
  availabilityByAppleId?: AvailabilityMirrorByAppleId;
  onCancel: () => void;
  /** ⚠ `selectedIds` are APPLE ids. Export never needs the internal UUID —
   *  that is the whole reason this picker's exclusion set differs from the
   *  availability modal's (design §2.G). */
  onExport: (args: {
    selectedIds: string[];
    territories: string[] | null;
  }) => void;
  exporting?: boolean;
}

export function ExportItemWizard({
  open,
  iaps,
  drafts,
  appleToInternal,
  availabilityByAppleId = {},
  onCancel,
  onExport,
  exporting = false,
}: ExportItemWizardProps) {
  const [step, setStep] = useState<"items" | "countries">("items");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [windowSize, setWindowSize] = useState(ROW_WINDOW_STEP);
  const [typeFilter, setTypeFilter] = useState<InAppPurchaseType | "ALL">("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [availabilityFilter, setAvailabilityFilter] =
    useState<AvailabilityFilterValue>("ALL");

  /** Apple's raw status values, as they actually occur in THIS app. Derived
   *  rather than hardcoded so a state Apple adds shows up without a release. */
  const allStatuses = useMemo(() => {
    const s = new Set<string>();
    for (const iap of iaps) s.add(iap.attributes.state);
    return [...s].sort();
  }, [iaps]);

  /** ⚠ Built from EVERY item, never from the filtered set. `rows.length` is
   *  the picker's denominator — "12 of 38" must mean 38 items in the app, not
   *  38 that happen to survive the current facets. */
  const rows = useMemo(
    () => buildExportItemRows({ iaps, drafts, appleToInternal }),
    [iaps, drafts, appleToInternal],
  );
  const { selectable, excluded } = useMemo(
    () => partitionExportRows(rows),
    [rows],
  );

  const typeById = useMemo(() => {
    const m = new Map<string, InAppPurchaseType>();
    for (const iap of iaps) m.set(iap.id, iap.attributes.inAppPurchaseType);
    return m;
  }, [iaps]);
  const statusById = useMemo(() => {
    const m = new Map<string, string>();
    for (const iap of iaps) m.set(iap.id, iap.attributes.state);
    return m;
  }, [iaps]);

  /** Type + Apple status + Availability. The picker's own search runs on top
   *  of this. ⚠ All three are pure predicates over data already in this
   *  component — no fetch, on any of them, ever (§2.I.1). */
  const facetSelectable = useMemo(
    () =>
      selectable.filter((r) => {
        if (typeFilter !== "ALL" && typeById.get(r.appleIapId) !== typeFilter) {
          return false;
        }
        if (statusFilter !== "ALL" && statusById.get(r.appleIapId) !== statusFilter) {
          return false;
        }
        // ⚠ Absence of a mirror record is UNKNOWN, decided inside
        //   `matchesAvailabilityFilter` — not by a `?? "AVAILABLE"` here.
        if (
          !matchesAvailabilityFilter(
            availabilityByAppleId[r.appleIapId],
            availabilityFilter,
          )
        ) {
          return false;
        }
        return true;
      }),
    [
      selectable,
      typeFilter,
      statusFilter,
      availabilityFilter,
      typeById,
      statusById,
      availabilityByAppleId,
    ],
  );

  /** C6 — how old the availability data behind the filter is, over the items
   *  this picker can select. Shown beside the facets. */
  const availabilityAsOf = useMemo(
    () =>
      asOfSummary(
        selectable.map((r) => r.appleIapId),
        availabilityByAppleId,
      ),
    [selectable, availabilityByAppleId],
  );

  /**
   * ⚠ THE SAME GUARANTEE THE SEARCH BOX GETS, ON THE FACET AXIS.
   *
   * `selectionCounts` can only account for the rows it is handed, so a row
   * ticked under "All types" and then hidden by a Type change would leave the
   * selection silently — still in the batch, absent from every number on
   * screen. The search axis solves this with `selectedHidden`; the facets need
   * their own count for exactly the same reason, or narrowing a filter looks
   * like the tool discarding picks.
   *
   * ⚠ C6 — THIS COVERS THE AVAILABILITY AXIS TOO, and it does so because it
   * derives from `facetSelectable` rather than re-listing the facets. Adding a
   * third dropdown did not need a line here, and a future fourth one will not
   * either. Do NOT "fix" this by enumerating the filters: that is how one axis
   * ends up uncounted and a Manager watching their selection number drop
   * concludes the tool threw picks away.
   */
  const selectedHiddenByFacets = useMemo(() => {
    const visible = new Set(facetSelectable.map((r) => r.appleIapId));
    let n = 0;
    for (const r of selectable) {
      if (selected.has(r.appleIapId) && !visible.has(r.appleIapId)) n += 1;
    }
    return n;
  }, [facetSelectable, selectable, selected]);

  if (!open) return null;

  const selectedCount = selected.size;
  const estimatedRequests = selectedCount * REQUESTS_PER_ITEM;

  function toggleOne(appleIapId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appleIapId)) next.delete(appleIapId);
      else next.add(appleIapId);
      return next;
    });
  }

  /** ⚠ Scoped to the CURRENTLY VISIBLE matching set — the facets and the
   *  search both narrow it — so one click can neither under-select the rows
   *  the Manager can see nor wipe picks the filters are hiding. */
  function toggleAll() {
    const visible = facetSelectable.filter((r) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        r.productId.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
      );
    });
    const ids = visible.map((r) => r.appleIapId);
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }

  function reset() {
    setStep("items");
    setSelected(new Set());
    setQuery("");
    setWindowSize(ROW_WINDOW_STEP);
    setTypeFilter("ALL");
    setStatusFilter("ALL");
    setAvailabilityFilter("ALL");
  }

  function handleCancel() {
    reset();
    onCancel();
  }

  // ── Step 2 — the SHARED dialog, untouched, composed from outside. ────────
  if (step === "countries") {
    return (
      <ExportOptionsDialog
        open
        // ⚠ In a wizard, cancelling step 2 means "go back", not "give up" —
        // and the selection is still in this component's state, so returning
        // to step 1 preserves it for free. The dialog is not told any of this.
        onCancel={() => setStep("items")}
        onExport={(territories) =>
          onExport({ selectedIds: [...selected], territories })
        }
      />
    );
  }

  // ── Step 1 — choose items. Zero requests. ────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4">
      <div
        data-testid="export-wizard-items"
        className="w-full max-w-2xl max-h-[86vh] flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
      >
        {/* Header */}
        <div className="px-5 pt-[18px] pb-3.5 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Export list — choose items
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Step 1 of 2. Nothing is read from Apple until you export.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              aria-label="Close"
              className="flex-shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Facets — Type + Apple status. Free: pure predicates over `iaps`. */}
        <div className="px-5 pt-3 pb-2 flex items-center gap-2 flex-wrap">
          <select
            value={typeFilter}
            onChange={(e) =>
              setTypeFilter(e.target.value as InAppPurchaseType | "ALL")
            }
            aria-label="Type"
            data-testid="wizard-type-filter"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm px-3 py-2"
          >
            <option value="ALL">All types</option>
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Apple status"
            data-testid="wizard-status-filter"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm px-3 py-2 font-mono text-[12px]"
          >
            <option value="ALL">All Apple statuses</option>
            {/* ⚠ RAW. See the header note — no title-casing, no "Available". */}
            {allStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {/* ⚠ A SEPARATE CONTROL FROM "Apple status", permanently. The two
              answer different questions and the header explains why collapsing
              them would hide the day they disagree. */}
          <select
            value={availabilityFilter}
            onChange={(e) =>
              setAvailabilityFilter(e.target.value as AvailabilityFilterValue)
            }
            aria-label="Availability"
            data-testid="wizard-availability-filter"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm px-3 py-2"
          >
            <option value="ALL">All availability</option>
            <option value="AVAILABLE">Available</option>
            <option value="REMOVED">Removed</option>
            {/* ⚠ A FIRST-CLASS CHOICE, not a leftover bucket. Never synced is
                a real thing to want to look at, and the only alternative to
                offering it is silently folding those items somewhere they do
                not belong. */}
            <option value="UNKNOWN">Unknown</option>
          </select>
          <span className="text-[11px] text-slate-400 dark:text-slate-500 inline-flex items-center gap-1">
            <Search className="h-3 w-3" />
            Filters are local — they cost no Apple requests.
          </span>
        </div>

        {/* ⚠ The availability facet filters CACHED data, so the age of that
            cache is part of the answer. Same `asOfLabel` the IAP list renders
            — one function, so the two surfaces cannot describe the same mirror
            differently. */}
        <div className="px-5 pb-2">
          <p
            data-testid="wizard-availability-as-of"
            className="text-[11px] text-slate-400 dark:text-slate-500"
          >
            {asOfLabel(availabilityAsOf)}
            {availabilityAsOf.unknownCount > 0 && (
              <>
                {" — "}
                <span className="text-amber-700 dark:text-amber-300">
                  Unknown items are excluded from Available and Removed. Use
                  Refresh from Apple to sync them.
                </span>
              </>
            )}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pb-4">
          {selectedHiddenByFacets > 0 && (
            <p
              data-testid="facet-hidden-notice"
              className="text-[11px] text-amber-700 dark:text-amber-300 mb-2"
            >
              {/* ⚠ "the current filters", NOT a list of them. C6 added a third
                  facet and this sentence named only two — a wording that goes
                  stale silently, and reads as a claim about WHICH filter hid
                  the pick. The count is the fact worth carrying. */}
              + {selectedHiddenByFacets} more selected{" "}
              {selectedHiddenByFacets === 1 ? "item is" : "items are"} hidden by
              the current filters — still selected, and still part of the
              export.
            </p>
          )}

          <BulkItemPicker<ExportSelectableRow, (typeof excluded)[number]>
            rows={rows}
            selectableRows={facetSelectable}
            excludedRows={excluded}
            selected={selected}
            query={query}
            onQueryChange={(next) => {
              setQuery(next);
              setWindowSize(ROW_WINDOW_STEP);
            }}
            windowSize={windowSize}
            onShowMore={() => setWindowSize((n) => n + ROW_WINDOW_STEP)}
            onToggleOne={toggleOne}
            onToggleAll={toggleAll}
            renderRowTrailing={(row) => (
              // ⚠ BOTH AXES ON EVERY ROW, side by side and visibly distinct.
              //   That is the whole reason the availability filter was allowed
              //   to exist: a row where Apple's raw status and the mirror's
              //   verdict disagree shows both, so the divergence is something
              //   the Manager can see rather than something the tool resolves
              //   on their behalf. `BulkItemPicker` is NOT modified for this —
              //   `renderRowTrailing` was already its extension point.
              <span className="inline-flex items-center gap-2">
                <AvailabilityBadge
                  appleIapId={row.appleIapId}
                  bucket={mirrorBucket(availabilityByAppleId[row.appleIapId])}
                />
                <span
                  data-testid={`row-status-${row.appleIapId}`}
                  className="font-mono text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-[10rem]"
                >
                  {statusById.get(row.appleIapId) ?? ""}
                </span>
              </span>
            )}
            nothingSelectableSlot={
              <p
                data-testid="wizard-nothing-selectable"
                className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-6 text-center text-xs text-slate-500"
              >
                No item matches this Type / Apple status / Availability filter.
              </p>
            }
            renderExcluded={(excludedMatching) => (
              <div
                data-testid="wizard-excluded"
                className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 p-3"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
                  Cannot be exported ({excludedMatching.length})
                </p>
                <ul className="space-y-1">
                  {excludedMatching.map((r) => (
                    <li key={r.key} className="text-[11px] text-slate-500">
                      <span className="font-mono">{r.productId}</span> —{" "}
                      {r.exclusion.reason}
                      {r.exclusion.hint ? ` ${r.exclusion.hint}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          />
        </div>

        {/* ⚠ §2.E — the scale, live, BEFORE the run. A caution above the
            threshold, never a block: stop-and-preserve was the Manager's
            answer to scale, not prevention. */}
        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
          <p
            data-testid="export-scale-line"
            className="text-[11px] text-slate-600 dark:text-slate-300"
          >
            Export {selectedCount} {selectedCount === 1 ? "item" : "items"} ·
            about {estimatedRequests} Apple requests
          </p>
          {estimatedRequests > CAUTION_REQUEST_THRESHOLD && (
            <p
              data-testid="export-scale-caution"
              className="text-[11px] text-amber-700 dark:text-amber-300 mt-1"
            >
              ⚠ About {estimatedRequests} Apple requests. Large exports can
              reach Apple&apos;s hourly limit. If that happens the export stops,
              you still get the file with everything that succeeded, and the
              items it missed are listed inside it.
            </p>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setStep("countries")}
              disabled={selectedCount === 0 || exporting}
              data-testid="wizard-continue"
              className="px-4 py-2 text-sm font-medium bg-[#0c447c] hover:bg-[#0d4f8f] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {selectedCount === 0
                ? "Select at least 1 item"
                : `Continue to countries →`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One row's availability, from the mirror.
 *
 * ⚠ THREE VISUALLY DISTINCT OUTCOMES, and Unknown is not styled as a lesser
 * version of Available. It reads "Unknown" in muted type with a tooltip that
 * says why — an item nobody has asked Apple about looks different from one
 * Apple confirmed, at a glance, without reading the word.
 */
function AvailabilityBadge({
  appleIapId,
  bucket,
}: {
  appleIapId: string;
  bucket: "AVAILABLE" | "REMOVED" | "UNKNOWN";
}) {
  if (bucket === "AVAILABLE") {
    return (
      <span
        data-testid={`row-availability-${appleIapId}`}
        className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
      >
        Available
      </span>
    );
  }
  if (bucket === "REMOVED") {
    return (
      <span
        data-testid={`row-availability-${appleIapId}`}
        className="text-[10px] font-semibold text-red-600 dark:text-red-400"
      >
        Removed
      </span>
    );
  }
  return (
    <span
      data-testid={`row-availability-${appleIapId}`}
      title="Never synced from Apple. Use Refresh from Apple on the list page to read it."
      className="text-[10px] text-slate-400 dark:text-slate-500 italic"
    >
      Unknown
    </span>
  );
}
