/**
 * ⭐ O2 — the localization planner that thinks in **versions**.
 * Arc `[LOC-V2-model]`, chunk `[LOCV2-orchestrate]`.
 *
 * ⚠⚠ THIS REPLACES `planLocalizationSync` — IT DOES NOT WRAP IT.
 * The old planner thinks in terms of "the IAP's localizations", which is the
 * V1 model and the direct cause of the 20 rows that came back
 * `409 … ACTIVE state`. Wrapping it would leave **two models alive over one
 * resource**, which is the exact thing CLAUDE.md meta-rule P1 forbids and the
 * exact shape that made the original bug survivable for so long. The old module
 * has ONE production consumer (`execute/route.ts:1431`); O3 repoints it and
 * deletes the old planner in the same commit. Until then the old one is still
 * the wired one and this is staged — one model in production, not two.
 *
 * ─── TWO DIFFERENT THINGS, DELIBERATELY NOT MERGED ─────────────────────────
 *
 *   **the BASELINE** — the APPROVED version's content. What customers see.
 *                      Answers *"does anything need changing at all?"*
 *                      (KB §28.11.c: the approved row is the comparison mark.)
 *   **the TARGET**   — the WRITABLE version's localization ids. Where a change
 *                      is written. Comes from O1 (`resolveWriteTargetVersion`).
 *
 * ⚠ They are different versions in CA 1 (a version is created, then written to)
 * and different rows even in CA 2. Comparing against the target, or writing to
 * the baseline, are each a whole class of bug — the second one IS the original
 * 409. Hence two functions with two inputs, not one function with one list.
 *
 * ─── ⭐ AND THE ORDER MATTERS, NOT JUST THE SPLIT ──────────────────────────
 *
 * `planLocalizationWrites` runs FIRST, against the baseline alone, and answers
 * `needsWrite`. Only if that is true does the caller resolve a write target —
 * which in CA 1 means `POST`ing a version that can never be deleted. Comparing
 * first is what makes §31.12 constraint 1 ("create the version as late as
 * possible") real rather than aspirational: an item whose file already matches
 * what is live creates NOTHING.
 */
import {
  localizationContentEquals,
  type LocalizationContent,
} from "../localization-compare";

/** One locale's content as it exists on a version (from the snapshot read). */
export interface VersionLocalization {
  id: string;
  locale: string;
  name: string;
  description: string;
}

/** One locale's content as the import file states it. */
export interface DesiredLocalization {
  locale: string;
  display_name: string;
  description: string;
}

/**
 * ⚠ THREE REASONS TO SKIP, AND THEY ARE NOT INTERCHANGEABLE.
 * All three produce the same ACTION (write nothing) and must never produce the
 * same SENTENCE: what the Manager needs from the cell is not "skipped", it is
 * **whether this item has a change waiting for Apple** — a fact they would
 * otherwise have to open App Store Connect to learn.
 */
export type SkipReason =
  /** File matches what is live, and nothing else is pending. */
  | "IDENTICAL_TO_LIVE"
  /** File matches the pending draft — a previous run already wrote this. */
  | "ALREADY_IN_DRAFT"
  /** File matches live, but a DIFFERENT change is pending review. */
  | "LIVE_MATCHES_BUT_DRAFT_DIFFERS";

/** Manager-facing sentences. Q4 wording approved 2026-09-25. */
export const SKIP_LABELS: Record<SkipReason, string> = {
  IDENTICAL_TO_LIVE: "Giống bản đang bán — không có gì để đổi",
  ALREADY_IN_DRAFT: "Bản nháp đã mang thay đổi này — đang chờ duyệt",
  LIVE_MATCHES_BUT_DRAFT_DIFFERS:
    "Giống bản đang bán — nhưng bản nháp đang chờ duyệt mang nội dung khác",
};

export interface SkippedLocale {
  locale: string;
  reason: SkipReason;
  label: string;
}

export interface LocalizationWritePlan {
  /** Locales whose content must reach Apple. */
  toWrite: DesiredLocalization[];
  /** Locales deliberately not written, each with WHY. */
  skipped: SkippedLocale[];
  /**
   * ⭐ THE GATE ON CREATING A VERSION. False ⇒ the caller must not resolve a
   * write target, which in CA 1 means it must not `POST`. An unnecessary POST
   * is a permanent artifact on a selling product.
   */
  needsWrite: boolean;
}

function toContent(v: {
  name: string;
  description: string;
}): LocalizationContent {
  return { name: v.name, description: v.description };
}

function desiredAsContent(d: DesiredLocalization): LocalizationContent {
  return { name: d.display_name, description: d.description };
}

/**
 * STEP A — decide what needs writing, comparing against the LIVE baseline.
 *
 * THE RULE: **write a locale iff the file differs from what is live AND
 * differs from what is already pending.**
 *
 * ⚠ THE SECOND HALF IS THE RE-RUN GUARD. The Manager re-ran the failed import
 * three times during the original incident, so "the draft already carries
 * exactly this" is not a hypothetical — it is the second run of every batch.
 * Under the V2 model the write target is the DRAFT's row, so re-sending a value
 * the draft already has is a no-op that costs a request and nothing else
 * (Manager, Q4). Skipping it is not an optimisation; sending it is noise.
 *
 * ⚠ NO `toDelete` — Q3, Manager 2026-09-25. **This is deliberate, not an
 * omission.** A locale present on Apple and absent from the file does NOT mean
 * "the Manager wants it deleted"; import files are routinely partial. Deleting
 * a localization cannot be undone, and the form (`update-orchestration`) is the
 * surface where removing a locale is an explicit, visible act. If you came here
 * looking for the delete branch: it was removed on purpose and this paragraph
 * is the record.
 */
export function planLocalizationWrites(args: {
  /** The APPROVED version's rows. Empty when the item has never been live. */
  approved: ReadonlyArray<VersionLocalization>;
  /** The pending draft's rows, when one exists. */
  draft: ReadonlyArray<VersionLocalization>;
  desired: ReadonlyArray<DesiredLocalization>;
}): LocalizationWritePlan {
  const approvedByLocale = new Map(args.approved.map((r) => [r.locale, r]));
  const draftByLocale = new Map(args.draft.map((r) => [r.locale, r]));

  const toWrite: DesiredLocalization[] = [];
  const skipped: SkippedLocale[] = [];

  for (const d of args.desired) {
    const live = approvedByLocale.get(d.locale);
    const pending = draftByLocale.get(d.locale);
    const want = desiredAsContent(d);

    const matchesLive = live !== undefined && localizationContentEquals(want, toContent(live));
    const matchesPending =
      pending !== undefined && localizationContentEquals(want, toContent(pending));

    if (matchesLive) {
      // Does something ELSE sit pending for this locale? The action is the
      // same either way; the sentence is not.
      const pendingDiffers =
        pending !== undefined &&
        live !== undefined &&
        !localizationContentEquals(toContent(pending), toContent(live));
      const reason: SkipReason = pendingDiffers
        ? "LIVE_MATCHES_BUT_DRAFT_DIFFERS"
        : "IDENTICAL_TO_LIVE";
      skipped.push({ locale: d.locale, reason, label: SKIP_LABELS[reason] });
      continue;
    }

    if (matchesPending) {
      skipped.push({
        locale: d.locale,
        reason: "ALREADY_IN_DRAFT",
        label: SKIP_LABELS.ALREADY_IN_DRAFT,
      });
      continue;
    }

    // ⚠ Includes the locale Apple has never heard of (absent from `approved`):
    // that differs from live by definition, so it is a write, and step B turns
    // it into a POST.
    toWrite.push(d);
  }

  return { toWrite, skipped, needsWrite: toWrite.length > 0 };
}

export interface LocalizationWriteOps {
  /** Existing rows on the WRITABLE version — PATCH by id. */
  toPatch: Array<{ id: string; locale: string; name: string; description: string }>;
  /** Locales the writable version does not have — POST onto it. */
  toCreate: Array<{ locale: string; name: string; description: string }>;
}

/**
 * STEP B — map the writes onto the version that may actually be written to.
 *
 * ⚠⚠ `writable` IS THE TARGET VERSION'S ROWS, NEVER THE APPROVED ONE'S.
 * PATCHing an id that belongs to the APPROVED version is precisely the request
 * Apple answers `409 IAP_VERSION_UNMODIFIABLE` (KB §32.3) — the failure this
 * whole arc exists to remove. The ids here must come from the version O1
 * resolved.
 *
 * ⚠⚠ THE PAYLOAD IS THE FILE'S TEXT, BYTE FOR BYTE (Q5). Nothing here passes
 * through `localizationComparisonKey`. Comparison may canonicalise encodings;
 * the value written may not, because that would edit the Manager's data on its
 * way to Apple.
 *
 * ⚠ Apple copies every approved locale into a newly created version (KB §32.2),
 * so on CA 1 the writable version already HAS the locale and this yields a
 * PATCH, not a POST. `toCreate` is for genuinely new locales only.
 */
export function resolveWriteOps(
  toWrite: ReadonlyArray<DesiredLocalization>,
  writable: ReadonlyArray<VersionLocalization>,
): LocalizationWriteOps {
  const byLocale = new Map(writable.map((r) => [r.locale, r]));
  const toPatch: LocalizationWriteOps["toPatch"] = [];
  const toCreate: LocalizationWriteOps["toCreate"] = [];

  for (const d of toWrite) {
    const row = byLocale.get(d.locale);
    if (row) {
      toPatch.push({
        id: row.id,
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
  return { toPatch, toCreate };
}

/**
 * ⚠⚠ WHERE A `WriteTargetRefused` FROM O1 LANDS — and why it gets its own
 * function instead of falling into the caller's `catch`.
 *
 * O1 refuses in two situations (two drafts; a review already in flight). Both
 * are **deliberate decisions with a stated reason**, not failures. Dropped into
 * a generic catch they would surface as "lỗi không rõ" — the row would read as
 * broken rather than as *deliberately not written, because writing would have
 * been a guess*. That is the silent-failure class this whole arc exists to
 * remove, pointed at our own code instead of Apple's.
 *
 * ⇒ The caller catches `WriteTargetRefused` SPECIFICALLY and calls this, so
 *   every locale the row intended to write carries Apple-side context in the
 *   Manager's own terms.
 */
export function describeWriteTargetRefusal(
  locales: ReadonlyArray<string>,
  reason: string,
): Array<{ locale: string; message: string }> {
  return locales.map((locale) => ({
    locale,
    message:
      `${locale}: không ghi được vì tool không xác định được version an toàn ` +
      `để ghi — ${reason}. Không có thay đổi nào được gửi lên Apple cho locale này.`,
  }));
}
