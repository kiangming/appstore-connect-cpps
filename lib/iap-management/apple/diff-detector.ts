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

  return {
    attributes_changed,
    localizations_changed,
    screenshot_changed,
    tier_changed,
  };
}

/** True when the diff has no non-null buckets — the orchestrator can skip
 *  every Apple call and surface "No changes detected" to Manager. */
export function isEmptyDiff(diff: IapDiff): boolean {
  return (
    diff.attributes_changed === null &&
    diff.localizations_changed === null &&
    diff.screenshot_changed === false &&
    diff.tier_changed === null
  );
}
