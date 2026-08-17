/**
 * Form-vs-cached diff detection for IAP.o.12 update-on-Apple flow.
 *
 * The diff drives:
 *   1. The "Push these changes?" confirmation modal copy (UI surface).
 *   2. Which Apple PATCH endpoints the orchestrator hits (skip unchanged
 *      stages → minimize Apple traffic + reduce risk of state-locked
 *      rejection on fields the Manager didn't touch).
 *
 * Manager Q-IAP.o.12.B locked: per-field diff (β strategy). Cache is the
 * `iap_mgmt.iaps` + `iap_mgmt.iap_localizations` rows from the last sync,
 * which is the authoritative local view of what's currently on Apple.
 *
 * Whitespace normalization: every text field is trimmed before compare.
 * "  Diamonds  " vs "Diamonds" must not appear as a change. Null vs empty
 * string ("" / null) are also collapsed — neither represents a value Apple
 * would store as different.
 */
import type { FormLocalization, IapFormState } from "../validation";
import {
  selectionsEqual,
  type TerritorySelection,
} from "./territory-selection";

/** Locally-cached IAP state as last persisted from Apple (or local draft). */
export interface CachedIapState {
  /** Apple `name` mirror (stored as iap_mgmt.iaps.reference_name). */
  reference_name: string;
  /** Apple `reviewNote` mirror. Null = unset on Apple. */
  review_note: string | null;
  /** Apple `familySharable` mirror. */
  family_sharable: boolean;
  /** Local tier_id (e.g. "TIER_5", "0" for FREE). Null when no tier set. */
  tier_id: string | null;
  /** Localizations keyed by BCP-47 locale code. */
  localizations: Record<
    string,
    { locale: string; display_name: string; description: string }
  >;
  /** Apple screenshot id from iap_mgmt.iap_screenshots.apple_id. Null when
   *  no screenshot has been uploaded yet. */
  screenshot_apple_id: string | null;
  /** Local cached file_name from iap_mgmt.iap_screenshots.file_name. */
  screenshot_file_name: string | null;
  /**
   * Apple-side availability as last read. `null` means "no availability
   * resource" — Apple's Removed-from-Sale state.
   *
   * ⚠ `null` does NOT mean "we failed to read it". A failed read is
   * `availability_previous_known: false`, and the two must not be conflated:
   * treating a failed read as null would silently assert "it was removed"
   * about an item nobody managed to read. Same distinction
   * `diffSelection` refuses to model and `filterEligible` keeps in its own
   * bucket.
   */
  availability_selection: TerritorySelection | null;
  /**
   * False when the Apple-side read failed or was never attempted, so
   * `availability_selection === null` cannot be read as "removed from sale".
   * The audit payload carries this verbatim as `previous_known` — SC2's
   * reconstructability rule requires it to be honest rather than defaulting
   * to a count.
   */
  availability_previous_known: boolean;
}

export interface IapDiff {
  /** PATCH-able attributes on `/v2/inAppPurchases/{id}` that changed. */
  attributes_changed: {
    name?: string;
    reviewNote?: string | null;
    familySharable?: boolean;
  } | null;
  /** Per-locale changes split into update/add/remove buckets. */
  localizations_changed: {
    updated: { locale: string; name?: string; description?: string }[];
    added: { locale: string; name: string; description: string }[];
    removed: { locale: string }[];
  } | null;
  /** True when the form has a new screenshot file staged (the form carries
   *  only `screenshot_filename`; the actual File handle lives in multipart
   *  upload). A non-null filename that differs from the cached one ⇒ replace. */
  screenshot_changed: boolean;
  /** Tier change. Null when local tier_id matches cached. */
  tier_changed: {
    old_tier_id: string | null;
    new_tier_id: string;
  } | null;
  /**
   * Availability change. Null when the form's selection would produce a
   * byte-equal Apple request to what is already there (no Stage 5 work).
   *
   * ⚠ An availability-ONLY edit must reach the orchestrator. This bucket is
   * one of the two gates that decides that (`isEmptyDiff` here, `shouldRun`
   * in Stage 5) — the LAYER-GAP shape that has bitten this project four
   * times. Both are tested, and each is mutated independently.
   */
  availability_changed: {
    old_selection: TerritorySelection | null;
    new_selection: TerritorySelection;
    /** Mirrors `CachedIapState.availability_previous_known`. */
    previous_known: boolean;
  } | null;
  /**
   * ⚠ SC3 GATE 1. Per-territory custom prices that need re-sending to Apple.
   * Null when the stored custom set already matches Apple's effective-now
   * manual prices.
   *
   * Without this clause `isEmptyDiff` returns true for a customs-ONLY edit —
   * which is the COMMON case, a Manager opening an item purely to fix one
   * territory's price. The route would answer NO_CHANGES and the confirm modal
   * would never open: the merge could be perfect and the change would still
   * never reach it, with no message anywhere. This is the LAYER-GAP failure in
   * its Apple form.
   *
   * Customs are not part of `IapFormState` (they live in `iap_custom_prices`),
   * so unlike every other bucket this one is computed by the CALLER — from the
   * stored set versus the G4 schedule read — and threaded in. See
   * `customPricesDivergeFromApple`.
   */
  custom_prices_changed: {
    /** How many customs the push will carry. */
    count: number;
    /** Territories whose custom differs from what Apple currently charges. */
    diverging_territories: string[];
  } | null;
}

const normalize = (s: string | null | undefined): string =>
  (s ?? "").trim();

/** True when both sides normalize to the same string. */
const eqText = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => normalize(a) === normalize(b);

export interface DetectIapChangesArgs {
  form: IapFormState;
  cached: CachedIapState;
  /** True when a new screenshot File has been staged client-side and is
   *  being uploaded with the request. The form itself only carries the
   *  filename, not the bytes, so this flag is explicit. */
  hasNewScreenshotFile: boolean;
  /**
   * SC3 — custom prices needing a push, computed by the caller (they live in
   * `iap_custom_prices`, not in the form). Omitted ⇒ no customs, which keeps
   * every existing caller's behaviour byte-identical.
   */
  customPrices?: {
    count: number;
    diverging_territories: string[];
  } | null;
}

/**
 * Compute the diff between the form-as-submitted and the locally-cached
 * Apple state. Every change is at the field level — the orchestrator decides
 * which Apple PATCH endpoints fire based on which buckets are non-null.
 */
export function detectIapChanges(args: DetectIapChangesArgs): IapDiff {
  const { form, cached, hasNewScreenshotFile } = args;

  // ── Attributes ────────────────────────────────────────────────────────
  const attrPatch: NonNullable<IapDiff["attributes_changed"]> = {};
  if (!eqText(form.reference_name, cached.reference_name)) {
    attrPatch.name = normalize(form.reference_name);
  }
  if (!eqText(form.review_note, cached.review_note)) {
    // Apple supports null to clear the field — surface explicit null when
    // the form emptied a previously-set review note.
    const next = normalize(form.review_note);
    attrPatch.reviewNote = next.length === 0 ? null : next;
  }
  if (
    typeof form.family_sharable === "boolean" &&
    form.family_sharable !== cached.family_sharable
  ) {
    attrPatch.familySharable = form.family_sharable;
  }
  const attributes_changed =
    Object.keys(attrPatch).length === 0 ? null : attrPatch;

  // ── Localizations ─────────────────────────────────────────────────────
  const updated: { locale: string; name?: string; description?: string }[] = [];
  const added: { locale: string; name: string; description: string }[] = [];
  const removed: { locale: string }[] = [];

  // Treat a form locale as "filled" only when at least one field has
  // content — empty rows are not pushed to Apple (matches create-on-apple
  // semantics).
  const filledFormLocales: Record<string, FormLocalization> = {};
  for (const [locale, loc] of Object.entries(form.localizations)) {
    if (normalize(loc.display_name) || normalize(loc.description)) {
      filledFormLocales[locale] = loc;
    }
  }

  const cachedLocales = cached.localizations;
  for (const [locale, formLoc] of Object.entries(filledFormLocales)) {
    const cachedLoc = cachedLocales[locale];
    if (!cachedLoc) {
      // Apple-side doesn't have this locale yet — add via POST.
      added.push({
        locale,
        name: normalize(formLoc.display_name),
        description: normalize(formLoc.description),
      });
      continue;
    }
    // Same locale, possibly different content — narrow to changed fields.
    const patch: { locale: string; name?: string; description?: string } = {
      locale,
    };
    if (!eqText(formLoc.display_name, cachedLoc.display_name)) {
      patch.name = normalize(formLoc.display_name);
    }
    if (!eqText(formLoc.description, cachedLoc.description)) {
      patch.description = normalize(formLoc.description);
    }
    if (patch.name !== undefined || patch.description !== undefined) {
      updated.push(patch);
    }
  }
  for (const locale of Object.keys(cachedLocales)) {
    if (!filledFormLocales[locale]) {
      removed.push({ locale });
    }
  }
  const localizations_changed =
    updated.length === 0 && added.length === 0 && removed.length === 0
      ? null
      : { updated, added, removed };

  // ── Screenshot ────────────────────────────────────────────────────────
  // Filename-based diff is the loosest sensible check: when the user stages
  // a new file the form filename flips to the new name; replacing with the
  // same filename is still a meaningful "replace" intent. The
  // `hasNewScreenshotFile` arg is the authoritative signal — the file bytes
  // accompany the request only when the user staged a new file.
  const screenshot_changed =
    hasNewScreenshotFile &&
    Boolean(form.screenshot_filename) &&
    form.screenshot_filename !== cached.screenshot_file_name;

  // ── Tier ──────────────────────────────────────────────────────────────
  let tier_changed: IapDiff["tier_changed"] = null;
  if (form.tier_id && form.tier_id !== cached.tier_id) {
    tier_changed = {
      old_tier_id: cached.tier_id,
      new_tier_id: form.tier_id,
    };
  }

  // ── Availability ──────────────────────────────────────────────────────
  // Fire Stage 5 only when the form carries an explicit selection AND it
  // would produce a different Apple request than what is already there. A
  // form selection of `undefined`/`null` means Section 5 didn't render
  // (create flow) — leave availability untouched.
  //
  // ⚠ Comparison is `selectionsEqual`, NOT a length or id-set check: "all
  // territories" and "all territories ticked by hand" carry identical ids and
  // different flags, so an id-only comparison would call a real change a
  // no-op and silently skip the write (KB §4.13).
  //
  // ⚠ When the previous state is UNKNOWN (read failed) any explicit selection
  // is treated as a change. The alternative — comparing against null and
  // calling it equal — would skip the write on exactly the items whose state
  // we could not see.
  let availability_changed: IapDiff["availability_changed"] = null;
  const formSelection = form.availability_selection;
  if (formSelection) {
    const previousKnown = cached.availability_previous_known;
    const current = cached.availability_selection;
    const unchanged =
      previousKnown && current !== null && selectionsEqual(formSelection, current);
    // A known-absent availability (Removed from Sale) vs an empty selection is
    // also a no-op — both send zero territories with the flag off.
    const bothEmpty =
      previousKnown &&
      current === null &&
      formSelection.territoryIds.length === 0 &&
      !formSelection.availableInNewTerritories;
    if (!unchanged && !bothEmpty) {
      availability_changed = {
        old_selection: current,
        new_selection: formSelection,
        previous_known: previousKnown,
      };
    }
  }

  return {
    attributes_changed,
    localizations_changed,
    screenshot_changed,
    tier_changed,
    availability_changed,
    // SC3 — threaded in by the caller (customs are not form state). Normalised
    // so an empty diverging list can never masquerade as a change.
    custom_prices_changed:
      args.customPrices && args.customPrices.diverging_territories.length > 0
        ? args.customPrices
        : null,
  };
}

/**
 * Do the stored customs differ from what Apple is charging right now?
 *
 * This is what makes a customs-ONLY edit detectable without a new form field or
 * a new DB column: compare the set against the effective-now manual prices from
 * the G4 read. It is also the honest question — "does Apple need this push?" —
 * rather than "did the Manager touch the dialog in this session".
 *
 * Both directions count as divergence:
 *   · a custom Apple does not have, or has at a different price ⇒ push needed
 *   · a manual price on Apple with NO custom behind it ⇒ the Manager cleared
 *     that custom, and the replace-all push is what reverts the territory to
 *     template/auto. Missing this direction would make "clear all" a no-op on
 *     Apple while the UI reported success.
 *
 * The base territory is excluded: it is carried by `applePricePointId`, never by
 * an override (§E).
 */
export function customPricesDivergeFromApple(args: {
  customs: ReadonlyArray<{ territory_code: string; customer_price: number }>;
  /** Effective-now manual prices — MUST already be startDate === null filtered. */
  appleManualPrices: ReadonlyArray<{ territory: string; customerPrice: number }>;
  baseTerritory?: string;
}): { count: number; diverging_territories: string[] } | null {
  const base = (args.baseTerritory ?? "USA").toUpperCase();
  const customs = new Map(
    args.customs
      .filter((c) => c.territory_code.toUpperCase() !== base)
      .map((c) => [c.territory_code.toUpperCase(), c.customer_price]),
  );
  const apple = new Map(
    args.appleManualPrices
      .filter((p) => p.territory.toUpperCase() !== base)
      .map((p) => [p.territory.toUpperCase(), Number(p.customerPrice)]),
  );

  const diverging: string[] = [];
  for (const [territory, price] of customs) {
    const live = apple.get(territory);
    // Same epsilon discipline as findPricePointByUsdPrice — Apple's prices are
    // at most 3-decimal, so 0.001 is safe and must not be widened.
    if (live === undefined || Math.abs(live - price) >= 0.001) {
      diverging.push(territory);
    }
  }
  for (const territory of apple.keys()) {
    if (!customs.has(territory)) diverging.push(territory);
  }

  if (diverging.length === 0) return null;
  return {
    count: customs.size,
    diverging_territories: [...new Set(diverging)].sort(),
  };
}

/** True when the diff has no non-null buckets — the orchestrator can skip
 *  every Apple call and surface "No changes detected" to Manager. */
export function isEmptyDiff(diff: IapDiff): boolean {
  return (
    diff.attributes_changed === null &&
    diff.localizations_changed === null &&
    diff.screenshot_changed === false &&
    diff.tier_changed === null &&
    diff.availability_changed === null &&

    // ⚠ SC3 GATE 1 — without this clause a customs-only edit reports
    // NO_CHANGES and the confirm modal never opens. Removing it does not break
    // any other test; it silently deletes the feature on the Edit path.
    diff.custom_prices_changed === null
  );
}
