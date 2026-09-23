/**
 * Localization sync planner for bulk-import OVERWRITE (Problem 3b fix).
 *
 * The old overwrite path deleted ALL existing localizations then recreated
 * them. Apple enforces that an IAP must always retain ≥1 localization, so the
 * DELETE of the LAST remaining localization is rejected ("Cannot delete last
 * localization") — the delete was caught/non-fatal but left the locale's
 * content stale while the row still reported SUCCESS.
 *
 * This planner replaces delete-all-then-recreate with a delta strategy that
 * respects Apple's ≥1 invariant:
 *
 *   - PATCH locales present in BOTH old and new (update in place — no delete).
 *   - POST locales that are new.
 *   - DELETE only locales genuinely removed — and NEVER when it would remove
 *     the last localization.
 *
 * The never-delete-last guard works in concert with execution ORDER: the
 * caller MUST apply toPatch + toCreate BEFORE toDelete, so the desired locales
 * already exist on Apple when leftovers are removed. Combined with suppressing
 * all deletions when the desired set is empty, the IAP can never drop to zero
 * localizations.
 *
 * Pure + deterministic — no Apple I/O — so the decision logic is unit-tested
 * independently of the orchestration (mirrors conflict-resolution.ts /
 * decideOverwritePricing patterns).
 */

import { classifyLocalizationState } from "../apple/localization-state";

export interface ExistingLocalization {
  id: string;
  locale: string;
  /**
   * ⚠ APPLE'S STATE FOR THIS LOCALIZATION — the field whose ABSENCE here cost
   * a 20-row investigation.
   *
   * ⚠⚠ MỨC CHẮC CHẮN — đọc kỹ, câu này TỪNG BỊ VIẾT QUÁ.
   * An earlier version of this comment said "Apple returns it … answers with
   * the V1 shape, which carries `state`" — stated as an observation. It was
   * not one. What is actually known:
   *
   *   CÓ TRONG SCHEMA — OAS 4.4.1 declares
   *     `GET /v2/inAppPurchases/{id}/inAppPurchaseLocalizations` →
   *     `InAppPurchaseLocalization[]`, whose `attributes.state` enumerates
   *     PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED.
   *     The repo's own type models it (`types/iap-management/apple.ts`).
   *   ĐÃ ĐO — Apple's 409 quotes an `ACTIVE` state back at us, so a state
   *     certainly EXISTS server-side (and `ACTIVE` is outside Apple's own
   *     enum, KB §28.1).
   *   CHƯA ĐO — that this GET response actually CARRIES the field. A machine
   *     scan of this repo finds no fixture, log or test in which Apple ever
   *     returned one. See `localization-state-probe.ts`, which exists purely
   *     to settle it on the next real import.
   *
   * The execute route did not carry the field across regardless: it mapped the
   * response to `{ id, locale }` on the line immediately before calling this
   * planner, so the planner could not have consulted the state even if Apple
   * had sent one — the type did not have it.
   *
   * ⚠ COSTS ZERO EXTRA REQUESTS. The LIST call that produces it already runs
   * on the OVERWRITE path; this is a field that was being fetched and thrown
   * away.
   *
   * Optional because a caller with no state information must stay able to
   * plan — see `classifyLocalizationState`, where absent reads as UNKNOWN and
   * never as "fine".
   */
  state?: string;
}

export interface DesiredLocalization {
  locale: string;
  display_name: string;
  description: string;
}

export interface LocalizationSyncPlan {
  /**
   * Shared locales — PATCH content in place (id is the Apple localization id).
   *
   * ⚠ `state` RIDES ALONG, AND THE PLAN DOES NOT ACT ON IT — YET. Manager has
   * not decided whether a blocked locale should be skipped or still attempted
   * (Apple's refusal is authoritative; a stale local read is not). Carrying it
   * is what lets the FAILURE say "…because it is in ACTIVE state" instead of
   * "failed: [vi]". Deciding to skip is a separate, Manager-gated change.
   */
  toPatch: Array<{
    id: string;
    locale: string;
    name: string;
    description: string;
    state?: string;
  }>;
  /** New locales — POST. */
  toCreate: Array<{ locale: string; name: string; description: string }>;
  /** Genuinely-removed locales — DELETE (only after toPatch/toCreate applied). */
  toDelete: Array<{ id: string; locale: string }>;
  /** True when deletions were suppressed because the desired set is empty —
   *  deleting would have removed the last localization (Apple-forbidden). */
  deletionsSuppressed: boolean;
}

/**
 * Choose WHICH row to PATCH when Apple returns MORE THAN ONE localization for
 * the same locale. `[LOCSYNC-duplicate-locale]`
 *
 * ⚠ THE BUG THIS REPLACES. The planner used to build its lookup with
 * `new Map(existing.map((e) => [e.locale, e]))`. A `Map` built from pairs keeps
 * the LAST entry for a duplicated key, so the row that got PATCHed was
 * whichever one Apple happened to list last — and `route.ts` passes Apple's
 * list through unfiltered. Nothing in JSON:API promises an order, so the tool
 * was depending on an UNWRITTEN CONTRACT.
 *
 * ⚠ THE SHAPE IS REAL, THE HARM IS NOT MEASURED — say which is which.
 *   · REAL: an IAP can carry two rows for one locale — one live, one draft.
 *     Observed on ASC 2026-09-22 (KB §28.6) and confirmed structurally by the
 *     two different version ids in ASC's own URLs (KB §28.7).
 *   · NOT MEASURED: whether Apple's LIST actually returns BOTH rows, and in
 *     what order. No fixture, log or run in this repo shows a two-row
 *     response (KB §28.11.b).
 *   ⇒ So this is a fix for a contract we should never have leaned on, NOT a
 *     fix for a failure anyone has been observed to hit. Do not let the next
 *     reader inherit it as "this was breaking imports".
 *
 * THE RULE: prefer a row Apple's own state says is editable, per the
 * ALLOW-list in `localization-state.ts` (`PREPARE_FOR_SUBMISSION` is the state
 * ASC puts a freshly-opened draft in). That is the draft — the row that can be
 * overwritten without creating a version and without a re-review.
 *
 * ⚠ AND WHEN NO ROW IS PATCHABLE, IT STILL RETURNS ONE — deliberately.
 * Skipping here would be a behaviour change this module explicitly defers to
 * the Manager (see `LocalizationSyncPlan.toPatch`: *"the plan does not act on
 * it — YET"*). Apple's refusal is authoritative; a local state read is not. So
 * the attempt still goes out, and when Apple refuses, `describeLocalizationState`
 * already turns the failure into "…is in ACTIVE state — the product is live.
 * Changing it requires a new in-app purchase version and another review."
 * The Manager gets the sentence either way; this function only stops the tool
 * from picking the blocked row while an editable one was sitting right there.
 */
function pickPatchTarget(
  candidates: ReadonlyArray<ExistingLocalization>,
): ExistingLocalization {
  const patchable = candidates.find(
    (c) => classifyLocalizationState(c.state) === "PATCHABLE",
  );
  // Fallback is the FIRST row, not the last: an explicit, stated choice rather
  // than whatever `Map` overwrite order produced. It is still arbitrary among
  // equally-blocked rows — but it is arbitrary ON PURPOSE and written down.
  return patchable ?? candidates[0];
}

/**
 * Compute the localization delta. `existing` is what Apple currently has;
 * `desired` is the parsed import's localizations.
 */
export function planLocalizationSync(
  existing: ReadonlyArray<ExistingLocalization>,
  desired: ReadonlyArray<DesiredLocalization>,
): LocalizationSyncPlan {
  // ⚠ GROUPED, NOT `new Map(existing.map(e => [e.locale, e]))`. That one-liner
  // silently kept the LAST row for a duplicated locale — see `pickPatchTarget`.
  const existingByLocale = new Map<string, ExistingLocalization[]>();
  for (const e of existing) {
    const bucket = existingByLocale.get(e.locale);
    if (bucket) bucket.push(e);
    else existingByLocale.set(e.locale, [e]);
  }
  const desiredLocales = new Set(desired.map((d) => d.locale));

  const toPatch: LocalizationSyncPlan["toPatch"] = [];
  const toCreate: LocalizationSyncPlan["toCreate"] = [];
  for (const d of desired) {
    const candidates = existingByLocale.get(d.locale);
    if (candidates && candidates.length > 0) {
      const ex = pickPatchTarget(candidates);
      toPatch.push({
        id: ex.id,
        locale: d.locale,
        name: d.display_name,
        description: d.description,
        ...(ex.state !== undefined ? { state: ex.state } : {}),
      });
    } else {
      toCreate.push({
        locale: d.locale,
        name: d.display_name,
        description: d.description,
      });
    }
  }

  const leftovers = existing.filter((e) => !desiredLocales.has(e.locale));

  // Never-delete-last guard: only remove leftovers when at least one desired
  // locale will remain. With create/patch applied first (caller contract),
  // a non-empty desired set guarantees ≥1 localization survives every delete.
  // An empty desired set means EVERY existing locale is a leftover — deleting
  // them would hit zero, so suppress all deletions.
  const deletionsSuppressed = desiredLocales.size === 0 && leftovers.length > 0;
  const toDelete = deletionsSuppressed
    ? []
    : leftovers.map((e) => ({ id: e.id, locale: e.locale }));

  return { toPatch, toCreate, toDelete, deletionsSuppressed };
}
