/**
 * The EXPORT picker's item-list model. PURE.
 *
 * Design: docs/iap-management/design-export-list-item-selection.md §2.G.
 *
 * ─── WHY THIS IS A SEPARATE MODULE AND NOT A FOURTH `BulkItemMode` ─────────
 *
 * `bulk-item-rows.ts` is A′'s (availability's) row model. It looks reusable —
 * same list, same rows, and it even ships an escape hatch (`eligibleAppleIds:
 * null`) that reads like it was built for exactly this. It was not, and taking
 * it would have shipped a defect that is indistinguishable from a bug report.
 *
 * ⚠ THE ONE ROW THAT DIFFERS. An Apple item with **no local UUID**:
 *
 *     A′       → EXCLUDED (`not_linked`). Correct: its write route is keyed on
 *                the internal id — `/api/iap-management/iaps/{internalId}/
 *                availability`. Without one there is nothing to call.
 *     EXPORT   → SELECTABLE. The export route never touches the local DB. It
 *                takes `appleIapId` and calls Apple only (route.ts:60-78, no
 *                `iapDb` import).
 *
 * Copying A′'s table would hide a perfectly exportable item behind the reason
 * "Not linked locally" — an item visible on Apple, present in the list the
 * Manager just looked at, silently absent from the picker. That is the exact
 * silent-drop class `bulk-item-rows.ts` itself was written to kill, reproduced
 * through the other door.
 *
 * ⚠ AND IT IS NOT ONE LINE TO REMOVE — the requirement is in FOUR places
 * (Phase-0 census, chunk 2):
 *
 *     ① bulk-item-rows.ts:143-153  Guard 1, `if (!internalId)`. Runs
 *                                  UNCONDITIONALLY, BEFORE the
 *                                  `eligibleAppleIds === null` hatch at :158.
 *                                  Passing `null` does not skip it.
 *     ② bulk-item-rows.ts:252-256  `isSelectable` re-checks
 *                                  `internalId !== null`.
 *     ③ bulk-item-rows.ts:266-278  `partitionRows`' "unreachable" fallback
 *                                  RE-INJECTS the same `not_linked` wording.
 *     ④ bulk-item-rows.ts:233-237  `SelectableRow` declares
 *                                  `internalId: string` — the requirement is
 *                                  in the TYPE, not only the logic.
 *
 * Three of the four are downstream of the builder, so a flag on the builder
 * could not have reached them. `bulk-item-rows.ts` is left completely
 * untouched: A′ keeps the guard it needs, export never inherits it.
 *
 * ─── WHAT *IS* SHARED ──────────────────────────────────────────────────────
 *
 * `bulk-item-search.ts` — `matchesQuery`, `filterRowsByQuery`,
 * `selectionCounts`, `toggleAllForQuery`, `ROW_WINDOW_STEP` — is reused
 * VERBATIM, no flag, no fork. It keys on `appleIapId` / `productId` / `name`
 * and never reads `internalId`, so it was already surface-agnostic. `BulkItemRow`
 * is likewise shared as the row shape, which is what lets those five work here
 * unchanged.
 *
 * ⚠ `ExportItemRow` NARROWS `exclusion` to `local_draft` ONLY. That is not
 * decoration: it makes `not_linked` on this surface a COMPILE error, so the
 * defect above cannot come back by hand-writing the object literal either.
 */

import type {
  BulkItemRow,
  DraftItemInput,
} from "./bulk-item-rows";
import type { InAppPurchase } from "@/types/iap-management/apple";

/**
 * The ONLY exclusion this surface has (design §2.G: "Export's exclusion set is
 * local drafts only").
 *
 * ⚠ A′'s other four kinds are not merely unused here, they are UNREACHABLE and
 * the type says so:
 *   `not_linked`        — wrong on this surface, see the header.
 *   `read_rate_limited` }  export performs no pre-read at pick time, so these
 *   `read_failed`       }  buckets cannot exist. (The rate-limit story moves to
 *                          the run itself — the stop latch — not the picker.)
 *   `not_in_bucket`     — export applies no bucket restriction at all.
 */
export interface ExportRowExclusion {
  kind: "local_draft";
  reason: string;
  hint?: string;
}

/**
 * Structurally a `BulkItemRow` — so `bulk-item-search.ts` accepts it — with the
 * exclusion narrowed. Assignability holds because `"local_draft"` is a member
 * of `RowExclusionKind`.
 */
export interface ExportItemRow extends BulkItemRow {
  exclusion: ExportRowExclusion | null;
}

/**
 * ⚠ WORDING IS PER-SURFACE, NOT SHARED (design §2.0). A′'s draft hint is
 * "Create it on Apple first; availability only exists there" — true for
 * availability, wrong here: nothing about *availability* is why a draft cannot
 * be exported. Export is defined as live-from-Apple, so the honest reason is
 * that Apple has nothing to read.
 */
const DRAFT_EXCLUSION: ExportRowExclusion = {
  kind: "local_draft",
  reason: "Local draft — not on Apple yet.",
  hint: "Export reads live from Apple. Create this item on Apple first.",
};

export interface BuildExportItemRowsArgs {
  iaps: readonly InAppPurchase[];
  /**
   * Local-only drafts. Shown-but-disabled, never hidden — the Manager lock
   * A′ established (bulk-item-rows.ts:95-97): hiding them makes people think
   * an item vanished.
   */
  drafts?: readonly DraftItemInput[];
  /**
   * Apple id → internal UUID. ⚠ CARRIED FOR DISPLAY/NAVIGATION ONLY (the row's
   * Edit affordance), and DELIBERATELY NOT consulted by any selectability
   * decision below. It is optional for exactly that reason: an export picker
   * handed nothing at all still selects every Apple item.
   */
  appleToInternal?: Readonly<Record<string, string>>;
}

export function buildExportItemRows(
  args: BuildExportItemRowsArgs,
): ExportItemRow[] {
  const { iaps, drafts = [], appleToInternal = {} } = args;
  const rows: ExportItemRow[] = [];

  for (const iap of iaps) {
    // ⚠ NO GUARD HERE. Every Apple item is exportable, full stop — there is
    // deliberately no `if (!internalId)` counterpart to
    // bulk-item-rows.ts:143. `internalId` is recorded and then ignored.
    rows.push({
      key: iap.id,
      appleIapId: iap.id,
      internalId: appleToInternal[iap.id] ?? null,
      productId: iap.attributes.productId,
      name: iap.attributes.name,
      exclusion: null,
    });
  }

  for (const d of drafts) {
    rows.push({
      key: `draft:${d.id}`,
      appleIapId: null,
      internalId: d.id,
      productId: d.product_id,
      name: d.reference_name,
      exclusion: DRAFT_EXCLUSION,
    });
  }

  return rows;
}

/**
 * A row the export can actually send.
 *
 * ⚠ `appleIapId` ONLY. Contrast `SelectableRow` (bulk-item-rows.ts:233-237),
 * which also demands `internalId: string`. That difference is the whole point
 * of this module and is enforced by the type, not by a comment.
 */
export interface ExportSelectableRow extends ExportItemRow {
  appleIapId: string;
  exclusion: null;
}

export interface ExportExcludedRow extends ExportItemRow {
  exclusion: ExportRowExclusion;
}

export interface ExportRowPartition {
  selectable: ExportSelectableRow[];
  excluded: ExportExcludedRow[];
}

function isExportSelectable(r: ExportItemRow): r is ExportSelectableRow {
  // ⚠ TWO CONDITIONS, NOT THREE. `r.internalId !== null` is absent on purpose.
  return r.exclusion === null && r.appleIapId !== null;
}

/**
 * Split for rendering. Total — every input row lands in exactly one side, and
 * nothing is ever dropped.
 *
 * ⚠ DO NOT SUBSTITUTE `partitionRows` FROM `bulk-item-rows.ts`. It re-applies
 * the internal-id requirement twice over (its `isSelectable`, then its
 * fallback's `not_linked` reason), so an unlinked Apple item would come back
 * out as excluded even though this module's builder marked it selectable.
 * There is a test that fails on exactly that swap.
 */
export function partitionExportRows(
  rows: readonly ExportItemRow[],
): ExportRowPartition {
  const selectable: ExportSelectableRow[] = [];
  const excluded: ExportExcludedRow[] = [];
  for (const r of rows) {
    if (isExportSelectable(r)) selectable.push(r);
    else if (r.exclusion !== null) excluded.push({ ...r, exclusion: r.exclusion });
    else {
      // Unreachable by construction (the builder gives every Apple-id-less row
      // the draft exclusion) — but it must never be DROPPED. On this surface
      // "no Apple id" means precisely "not on Apple", so the draft reason is
      // the honest one, NOT A′'s `not_linked`.
      excluded.push({ ...r, exclusion: DRAFT_EXCLUSION });
    }
  }
  return { selectable, excluded };
}

/**
 * Why the picker is empty. Two causes here, against A′'s three: export has no
 * pre-read, so "everything was unreadable" cannot happen at pick time.
 */
export type ExportEmptyCause = "no_items" | "all_drafts";

export function exportEmptyCause(
  rows: readonly ExportItemRow[],
): ExportEmptyCause {
  return rows.length === 0 ? "no_items" : "all_drafts";
}
