/**
 * ⭐ C2 — **what a Localization cell looks like before the Manager touches it.**
 * Arc `[BULKIMPORT-loc-compare-apple]`.
 *
 * The template the Manager imports is a faithful dump of App Store Connect, so
 * it always carries localization text even when the job is "change the prices".
 * Ticking everything by default therefore asks them to untick 88 rows by hand
 * to do nothing. This module computes the default instead.
 *
 * ─── ⚠⚠ "WE COULD NOT ASK APPLE" IS A DIFFERENT AXIS FROM "APPLE SAID X" ──
 *
 * `SkipReason` has exactly three members and this module does **not** add a
 * fourth. Those three are findings — *Apple told us the file matches what is
 * live / what is pending*. "The read failed" is not a finding about Apple, it
 * is the absence of one, and the two point OPPOSITE WAYS:
 *
 *   Apple genuinely lacks this locale  → **TICK**   (it is an add)
 *   We could not reach Apple           → **UNTICK** (when unsure, do not write)
 *
 * Folding them into one type is the `UNKNOWN ≠ PATCHABLE` error class that
 * already cost this module an allow-list once (`localization-state.ts`), and
 * the collapse direction here is the dangerous one: every cell would read as
 * "chưa có trên Apple", tick itself, and recreate the 409 incident of
 * 2026-09-22 in full.
 *
 * ⇒ The unknown lives in `ItemAppleState`, which wraps the plan rather than
 *   extending it.
 *
 * ─── ⚠ THE VERDICT COMES FROM THE PLANNER, NOT FROM HERE ──────────────────
 *
 * Tick/untick is read off `planLocalizationWrites` — the SAME function the
 * write path calls. This module translates; it does not decide. A second
 * comparison implementation on the client would agree on the day it was
 * written and drift silently afterwards, and the drift would only ever be
 * visible by comparing a screenshot against a live product.
 */
import {
  planLocalizationWrites,
  SKIP_LABELS,
  type DesiredLocalization,
  type SkipReason,
  type VersionLocalization,
} from "./localization-version-plan";
import { localizationTextEquals } from "../localization-compare";

/** Which of the two text fields differ from the live row. */
export interface ChangedFields {
  name: boolean;
  description: boolean;
}

export type CellDefault =
  /** Apple says there is nothing to do. Three findings, three sentences. */
  | { tick: false; kind: "SKIPPED"; reason: SkipReason; label: string }
  /** Apple has this locale and the file differs. */
  | { tick: true; kind: "DIFFERS"; changed: ChangedFields; label: string }
  /** Apple genuinely does not have this locale — an add. */
  | { tick: true; kind: "NEW_LOCALE"; label: string }
  /** The item itself is not on Apple yet (CREATE row). Nothing was asked. */
  | { tick: true; kind: "NEW_ITEM"; label: string }
  /** ⚠ We could not ask. NOT the same as "Apple has nothing". */
  | { tick: false; kind: "UNREADABLE"; label: string };

export const CELL_LABELS = {
  NEW_LOCALE: "Chưa có trên Apple",
  /** Q-D, Manager approved 2026-09-30. */
  NEW_ITEM: "Item mới — chưa có trên App Store Connect",
  /** Fail-safe wording, Manager approved. */
  UNREADABLE: "Không đọc được trạng thái trên Apple",
  CHANGED_NAME: "Đổi Display Name",
  CHANGED_DESC: "Đổi Description",
  CHANGED_BOTH: "Đổi cả hai",
} as const;

/**
 * What we know about the item's Apple side.
 *
 * ⚠ THREE STATES, NOT A BOOLEAN. `NEW_ITEM` and `UNREADABLE` both mean "no
 * Apple data", and they produce OPPOSITE defaults — which is precisely why
 * they cannot be one flag.
 */
export type ItemAppleState =
  | {
      kind: "READ";
      approved: ReadonlyArray<VersionLocalization>;
      draft: ReadonlyArray<VersionLocalization>;
    }
  /** Bulk import CREATE row — the item does not exist on Apple yet. */
  | { kind: "NEW_ITEM" }
  /** The baseline read failed or came back incomplete. */
  | { kind: "UNREADABLE" };

export interface LocaleCellDefault {
  locale: string;
  default: CellDefault;
}

function changedFields(
  d: DesiredLocalization,
  live: VersionLocalization,
): ChangedFields {
  return {
    name: !localizationTextEquals(d.display_name, live.name),
    description: !localizationTextEquals(d.description, live.description),
  };
}

function changedLabel(c: ChangedFields): string {
  if (c.name && c.description) return CELL_LABELS.CHANGED_BOTH;
  if (c.name) return CELL_LABELS.CHANGED_NAME;
  if (c.description) return CELL_LABELS.CHANGED_DESC;
  // ⚠ Unreachable via the planner (a locale in `toWrite` differs from live by
  // construction) but stated rather than assumed: a cell that says "changed"
  // while naming no field is a cell the Manager cannot act on.
  return CELL_LABELS.CHANGED_BOTH;
}

/**
 * The default state of every cell of ONE item, in the file's locale order.
 */
export function buildCellDefaults(
  desired: ReadonlyArray<DesiredLocalization>,
  state: ItemAppleState,
): LocaleCellDefault[] {
  if (state.kind === "NEW_ITEM") {
    // ⚠ NO APPLE READ HAPPENS FOR THESE, and none should: there is nothing on
    // Apple to compare against and no `appleIapId` to ask about yet.
    return desired.map((d) => ({
      locale: d.locale,
      default: { tick: true, kind: "NEW_ITEM", label: CELL_LABELS.NEW_ITEM },
    }));
  }

  if (state.kind === "UNREADABLE") {
    return desired.map((d) => ({
      locale: d.locale,
      default: { tick: false, kind: "UNREADABLE", label: CELL_LABELS.UNREADABLE },
    }));
  }

  const plan = planLocalizationWrites({
    approved: state.approved,
    draft: state.draft,
    desired,
  });
  const skippedByLocale = new Map(plan.skipped.map((s) => [s.locale, s]));
  const writeLocales = new Set(plan.toWrite.map((w) => w.locale));

  return desired.map((d) => {
    const skip = skippedByLocale.get(d.locale);
    if (skip) {
      return {
        locale: d.locale,
        default: {
          tick: false as const,
          kind: "SKIPPED" as const,
          reason: skip.reason,
          label: SKIP_LABELS[skip.reason],
        },
      };
    }
    if (!writeLocales.has(d.locale)) {
      // Defensive: the planner puts every desired locale in exactly one of the
      // two lists. Reaching here means that invariant broke, and defaulting to
      // UNREADABLE is the option that does not write.
      return {
        locale: d.locale,
        default: {
          tick: false as const,
          kind: "UNREADABLE" as const,
          label: CELL_LABELS.UNREADABLE,
        },
      };
    }
    const live = plan.comparedAgainst[d.locale]?.live;
    if (!live) {
      return {
        locale: d.locale,
        default: {
          tick: true as const,
          kind: "NEW_LOCALE" as const,
          label: CELL_LABELS.NEW_LOCALE,
        },
      };
    }
    const changed = changedFields(d, live);
    return {
      locale: d.locale,
      default: {
        tick: true as const,
        kind: "DIFFERS" as const,
        changed,
        label: changedLabel(changed),
      },
    };
  });
}

/**
 * ⭐ Q-F — will processing this item CREATE a version on Apple?
 * Manager decision 2026-09-30: the confirm dialog counts **items**, not cells.
 *
 * ⚠ ONE ITEM CREATES ONE VERSION, however many of its cells are ticked. The
 * obvious implementation — counting cells — overstates by exactly the number
 * of locales, and a warning about something irreversible must not cry wolf.
 *
 * ⚠⚠ CONDITION (3) IS `toWrite`, **NOT** "differs from what is live".
 * A locale Apple has never seen is not "different", it is absent — and adding
 * it to a live item forces a new version just the same. Phrasing the test as a
 * content comparison is the natural mistake and it UNDERCOUNTS: every
 * add-a-locale row would go unwarned. `toWrite` already holds both cases, so
 * asking the planner is both simpler and correct.
 *
 * ⚠ And the converse: a cell the Manager ticked by hand that the planner will
 * skip (it matches Apple) creates nothing, and must not be counted.
 */
export function itemWillCreateVersion(args: {
  /** Item is live — there is an APPROVED version. */
  hasApproved: boolean;
  /** Item already has a draft ⇒ the edit lands in place, creating nothing. */
  hasDraft: boolean;
  /** Locales the planner says will be written (`plan.toWrite`). */
  writeLocales: ReadonlyArray<string>;
  /** Locales the Manager left ticked for this item. */
  tickedLocales: ReadonlyArray<string>;
}): boolean {
  if (!args.hasApproved) return false;
  if (args.hasDraft) return false;
  const ticked = new Set(args.tickedLocales);
  return args.writeLocales.some((l) => ticked.has(l));
}
