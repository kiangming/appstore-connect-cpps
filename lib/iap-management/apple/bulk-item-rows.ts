/**
 * The bulk-availability modal's ITEM LIST model — every row the Manager should
 * see, including the ones that cannot be acted on and WHY. PURE.
 *
 * Design: docs/iap-management/design-set-availabilities-item-list.md §4.1-4.3.
 *
 * ⚠ WHY THIS EXISTS — the silent drop.
 * `filterEligible` returns only the actionable rows. Everything it drops
 * vanished from the UI with no trace, while the caption above the list kept
 * explaining the absence in terms of AVAILABILITY:
 *
 *   "Showing 0 items currently in Remove from Sales. Items already Available
 *    are filtered out."
 *   "All items are currently Available. Nothing to enable — every IAP in this
 *    app already sells in all territories."
 *
 * Three different causes produce that same caption, and only one of them is
 * what the caption says:
 *
 *   1. the row's Apple read was RATE-LIMITED (at N=500 this is most of them)
 *   2. the row's Apple read FAILED for another reason
 *   3. the row has no local UUID because `seedMissingIapStubs` failed inside a
 *      silent `catch {}` on the page (page.tsx:106+:122)
 *
 * ⇒ the caption asserted a cause the code never established. That is the
 * status principle (KB §9 P5) applied to a filter caption: report the real
 * outcome, never the intent of the button. This module makes every exclusion
 * carry its own true reason.
 *
 * ⚠ WHY `filterEligible` IS NOT REIMPLEMENTED HERE.
 * For the two all-or-nothing modes this builder does NOT decide who is
 * selectable — it is handed `eligibleAppleIds`, which is `filterEligible`'s own
 * output, and only explains the rows missing from it. There is therefore no
 * second implementation of the bucket rule that could drift from the first
 * (P1): the parity is structural, not test-enforced. `filterEligible` remains
 * the single authority and is untouched by the A′ work.
 *
 * ⚠ THE EXCLUSION-REASON ORDER MIRRORS `filterEligible`'s GUARD ORDER.
 * A row can satisfy several exclusion tests at once (unread AND out-of-bucket).
 * The reason shown must be the one that actually dropped it, so the order here
 * is the same order the guards run in — unlinked → read error → unread →
 * bucket. Reordering them would show a true-but-not-operative reason, which is
 * the same class of lie this module exists to remove.
 */

import type { InAppPurchase } from "@/types/iap-management/apple";
import type { AvailabilityForIap } from "./availabilities";

/** Mirrors the modal's `BulkMode`; kept structural so this module imports no
 *  component. */
export type BulkItemMode = "set-all" | "remove" | "set-territories";

export type RowExclusionKind =
  | "local_draft"
  | "not_linked"
  | "read_rate_limited"
  | "read_failed"
  | "not_in_bucket";

export interface RowExclusion {
  kind: RowExclusionKind;
  /** Manager-facing sentence. Never a code, never a bare count. */
  reason: string;
  /** What the Manager can do about it, when there is something. */
  hint?: string;
}

export interface BulkItemRow {
  /** Stable React key AND the selection id. Drafts are never selectable, but
   *  they still need a collision-free key alongside Apple ids. */
  key: string;
  /** Apple's IAP id — `null` for a local draft, which has none yet. */
  appleIapId: string | null;
  /** `iap_mgmt.iaps.id` — `null` when the Apple row was never seeded locally. */
  internalId: string | null;
  productId: string;
  name: string;
  /** `null` ⇒ selectable. Anything else ⇒ shown, disabled, with the reason. */
  exclusion: RowExclusion | null;
}

/** The shape `listDraftIaps` returns, narrowed to what a row needs.
 *  ⚠ A draft is defined by `apple_iap_id IS NULL` — queries/iaps.ts:325-335,
 *  the partial index (20260515000000:106), and the availability route's 409
 *  `not_synced`. There is NO `existsOnApple_validated` column; that name is
 *  phantom (KB §4.15). */
export interface DraftItemInput {
  id: string;
  product_id: string;
  reference_name: string;
}

export interface BuildBulkItemRowsArgs {
  iaps: readonly InAppPurchase[];
  /** Local-only drafts. Shown-but-disabled per Manager lock: hiding them makes
   *  a Manager think the item disappeared. */
  drafts?: readonly DraftItemInput[];
  appleToInternal: Readonly<Record<string, string>>;
  states: ReadonlyMap<string, AvailabilityForIap | null>;
  errors: ReadonlyMap<string, string>;
  mode: BulkItemMode;
  /**
   * The Apple ids `filterEligible` kept.
   *
   * `null` means NO bucket restriction was applied at all — the A′ case for
   * `set-territories`, where the modal performs no on-open read and therefore
   * holds no state to filter on. `null` is not "nothing eligible"; it is "the
   * question was never asked", and the two must not collapse.
   */
  eligibleAppleIds: ReadonlySet<string> | null;
}

const NOT_IN_BUCKET_REASON: Record<BulkItemMode, string> = {
  "set-all": "Already available — nothing to enable.",
  remove: "Already removed from sales — nothing to remove.",
  // Unreachable: set-territories applies no bucket restriction, so it never
  // produces this exclusion. Present so the Record is total and a fourth mode
  // fails to compile rather than falling through to a sibling's wording.
  "set-territories": "Not eligible for this action.",
};

export function buildBulkItemRows(
  args: BuildBulkItemRowsArgs,
): BulkItemRow[] {
  const { iaps, drafts = [], appleToInternal, states, errors, mode } = args;
  const { eligibleAppleIds } = args;
  const rows: BulkItemRow[] = [];

  for (const iap of iaps) {
    const internalId = appleToInternal[iap.id] ?? null;
    const base = {
      key: iap.id,
      appleIapId: iap.id,
      internalId,
      productId: iap.attributes.productId,
      name: iap.attributes.name,
    };

    // ── Guard 1 — no local UUID. Mirrors filterEligible's first guard.
    //    This one was invisible AND had a plausible silent cause on the page,
    //    which is exactly the combination that produces "the list is empty and
    //    I don't know why".
    if (!internalId) {
      rows.push({
        ...base,
        exclusion: {
          kind: "not_linked",
          reason: "Not linked locally — this item has no local record yet.",
          hint: "Run Refresh from Apple, then reopen this dialog.",
        },
      });
      continue;
    }

    // ── A′ — no pre-read happened, so no state-based exclusion is possible.
    //    Selectable. The availability read for this row happens later, and
    //    only if the Manager selects it.
    if (eligibleAppleIds === null) {
      rows.push({ ...base, exclusion: null });
      continue;
    }

    if (eligibleAppleIds.has(iap.id)) {
      rows.push({ ...base, exclusion: null });
      continue;
    }

    // ── filterEligible dropped it. Name the guard that did, in ITS order.
    const err = errors.get(iap.id);
    if (err !== undefined) {
      rows.push({
        ...base,
        exclusion:
          err === "rate_limited"
            ? {
                kind: "read_rate_limited",
                reason: "Apple rate-limited the read of its current availability.",
                hint: "Wait for Apple's budget to recover, then reopen.",
              }
            : {
                kind: "read_failed",
                reason: `Could not read its current availability from Apple (${err}).`,
                hint: "Reopen this dialog to retry the read.",
              },
      });
      continue;
    }
    if (!states.has(iap.id)) {
      rows.push({
        ...base,
        exclusion: {
          kind: "read_failed",
          reason: "Its current availability was not read.",
          hint: "Reopen this dialog to retry the read.",
        },
      });
      continue;
    }
    rows.push({
      ...base,
      exclusion: { kind: "not_in_bucket", reason: NOT_IN_BUCKET_REASON[mode] },
    });
  }

  // ── Local drafts. Never selectable in ANY mode — Apple has no resource to
  //    replace. Shown anyway, per the Manager lock.
  for (const d of drafts) {
    rows.push({
      key: `draft:${d.id}`,
      appleIapId: null,
      internalId: d.id,
      productId: d.product_id,
      name: d.reference_name,
      exclusion: {
        kind: "local_draft",
        reason: "Local draft — not on Apple yet.",
        hint: "Create it on Apple first; availability only exists there.",
      },
    });
  }

  return rows;
}

/**
 * A row that can actually be selected and written.
 *
 * ⚠ The narrowing is EARNED, not asserted. Both ids are non-null on this type
 * because the only rows that reach it passed `isSelectable`, which checks them
 * — rather than a cast that would let a draft (no Apple id) or an unlinked row
 * (no internal id) reach the write path and fail deep inside the orchestrator.
 */
export interface SelectableRow extends BulkItemRow {
  appleIapId: string;
  internalId: string;
  exclusion: null;
}

/** A row that cannot be acted on — and therefore ALWAYS has a reason.
 *  Narrowed for the same reason `SelectableRow` is: the renderer shows
 *  `exclusion.reason` unconditionally, and a `!` there would be a promise the
 *  type system never checked. */
export interface ExcludedRow extends BulkItemRow {
  exclusion: RowExclusion;
}

export interface RowPartition {
  selectable: SelectableRow[];
  excluded: ExcludedRow[];
}

function isSelectable(r: BulkItemRow): r is SelectableRow {
  return (
    r.exclusion === null && r.appleIapId !== null && r.internalId !== null
  );
}

/** Split for rendering: the actionable list, and the shown-but-disabled tail.
 *  Total — every input row lands in exactly one side. */
export function partitionRows(rows: readonly BulkItemRow[]): RowPartition {
  const selectable: SelectableRow[] = [];
  const excluded: ExcludedRow[] = [];
  for (const r of rows) {
    if (isSelectable(r)) selectable.push(r);
    else if (r.exclusion !== null) excluded.push({ ...r, exclusion: r.exclusion });
    else {
      // Unreachable by construction (a row with no exclusion and a missing id
      // cannot be produced) — but it must never be DROPPED, which is the whole
      // point of this module. Give it an honest reason instead of vanishing.
      excluded.push({
        ...r,
        exclusion: {
          kind: "not_linked",
          reason: "Not linked locally — this item has no local record yet.",
          hint: "Run Refresh from Apple, then reopen this dialog.",
        },
      });
    }
  }
  return { selectable, excluded };
}

/**
 * Why the list is empty — the distinction the old empty state could not make.
 *
 * ⚠ "Nothing matched" and "nothing could be read" are DIFFERENT facts and lead
 * the Manager to different actions (change the filter vs. wait and retry).
 * Collapsing them is what let the modal say "every IAP in this app already
 * sells in all territories" when the truth was "Apple throttled 500 reads".
 */
export type EmptyCause = "no_items" | "all_excluded_unreadable" | "all_excluded_other";

export function emptyCause(rows: readonly BulkItemRow[]): EmptyCause {
  if (rows.length === 0) return "no_items";
  const unreadable = rows.filter(
    (r) =>
      r.exclusion?.kind === "read_rate_limited" ||
      r.exclusion?.kind === "read_failed",
  ).length;
  // Any unreadable row at all means the list CANNOT be described as a complete
  // picture of availability — say so rather than asserting a clean bucket.
  return unreadable > 0 ? "all_excluded_unreadable" : "all_excluded_other";
}
