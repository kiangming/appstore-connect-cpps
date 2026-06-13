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

export interface ExistingLocalization {
  id: string;
  locale: string;
}

export interface DesiredLocalization {
  locale: string;
  display_name: string;
  description: string;
}

export interface LocalizationSyncPlan {
  /** Shared locales — PATCH content in place (id is the Apple localization id). */
  toPatch: Array<{ id: string; locale: string; name: string; description: string }>;
  /** New locales — POST. */
  toCreate: Array<{ locale: string; name: string; description: string }>;
  /** Genuinely-removed locales — DELETE (only after toPatch/toCreate applied). */
  toDelete: Array<{ id: string; locale: string }>;
  /** True when deletions were suppressed because the desired set is empty —
   *  deleting would have removed the last localization (Apple-forbidden). */
  deletionsSuppressed: boolean;
}

/**
 * Compute the localization delta. `existing` is what Apple currently has;
 * `desired` is the parsed import's localizations.
 */
export function planLocalizationSync(
  existing: ReadonlyArray<ExistingLocalization>,
  desired: ReadonlyArray<DesiredLocalization>,
): LocalizationSyncPlan {
  const existingByLocale = new Map(existing.map((e) => [e.locale, e]));
  const desiredLocales = new Set(desired.map((d) => d.locale));

  const toPatch: LocalizationSyncPlan["toPatch"] = [];
  const toCreate: LocalizationSyncPlan["toCreate"] = [];
  for (const d of desired) {
    const ex = existingByLocale.get(d.locale);
    if (ex) {
      toPatch.push({
        id: ex.id,
        locale: d.locale,
        name: d.display_name,
        description: d.description,
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
