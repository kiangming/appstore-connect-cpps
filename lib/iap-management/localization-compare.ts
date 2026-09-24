/**
 * ⭐ THE ONE RULE FOR "IS THIS LOCALIZATION TEXT THE SAME AS THAT ONE?"
 * Arc `[LOC-V2-model]`, chunk V2.
 *
 * ⚠⚠ WHY THIS MODULE EXISTS AT ALL, AND WHY IT IS NOT A SECOND COPY.
 * Bulk import is about to need this comparison so it can auto-untick a cell
 * whose content already matches Apple. The single-IAP edit form has been making
 * the SAME decision, over the SAME two fields, since IAP.o.12 — `eqText` in
 * `apple/diff-detector.ts`. Two comparison rules that must agree is how they
 * drift: the day one grows a `toLowerCase()` the two surfaces disagree about
 * whether a product changed, and neither is obviously wrong. So the rule was
 * MOVED here and `diff-detector` now imports it. One choke point, not two
 * implementations (CLAUDE.md meta-rule P1 — same shape as
 * `applyLocalizationSelection` and `resolveBatchAvailabilitySelection`).
 *
 * ⚠ THIS IS THE COMPARISON RULE ONLY — IT NEVER TOUCHES WHAT GETS WRITTEN.
 * `normalizeLocalizationText` exists to make two strings comparable. The text
 * SENT to Apple must remain whatever the source said. Comparing and writing are
 * different jobs and this module only does the first one.
 *
 * ─── THE RULE, AND WHY EACH HALF IS THE WAY IT IS ──────────────────────────
 *
 *   trim BOTH ENDS · CASE-SENSITIVE · NO Unicode normalization
 *
 * **trim** — ĐÃ ĐO: the Excel parser already trims both ends
 * (`parsers/iap-items.ts:120-124`), so a trailing space in the sheet can never
 * reach Apple and must not read as a change. `diff-detector` has trimmed since
 * IAP.o.12 for the same reason.
 *
 * **case-sensitive** — `"vàng"` and `"Vàng"` are different display names and a
 * customer sees the difference. Folding case would silently refuse a rename the
 * Manager actually asked for.
 *
 * **no Unicode normalization — and this one is a KNOWN OPEN RISK, not an
 * oversight.** ⚠ MỨC CHẮC CHẮN:
 *   ĐÃ ĐO (code)  — nothing in this module's dependency graph normalizes.
 *                   A machine scan for `.normalize("NF…")` across the repo
 *                   returns exactly one hit, in `store-submissions`, a
 *                   different module.
 *   CHƯA ĐO       — whether Excel and Apple actually encode Vietnamese
 *                   diacritics the same way. There is NO fixture anywhere in
 *                   this repo containing a real Apple localization response
 *                   with accented text, so the question cannot be settled by
 *                   reading the repo. It is measured alongside the V0 snapshot
 *                   (compare codepoints, not glyphs) and decided by the
 *                   Manager as Q5.
 *   ⇒ If the two sources turn out to differ, `"Vàng"` (NFC) and `"Vàng"` (NFD)
 *     look identical and compare UNEQUAL, so a cell reading "no change" would
 *     be classified as a change. Under the V2 model that can mean a new version
 *     and a re-review **for an edit that does not exist**.
 *   ⚠ DO NOT "fix" this by adding `.normalize()` on a hunch. Over-normalizing
 *     fails the other way and worse: `"188 Vàng"` vs `"188 Vàng."` differ by
 *     one full stop and that IS a real change the Manager wants. The safe
 *     direction is the current one — a spurious *write attempt* is visible and
 *     Apple adjudicates it, whereas a spurious *skip* is silent (KB §30.2).
 */

/** Make two strings comparable. NOT for producing the value that is written. */
export function normalizeLocalizationText(
  s: string | null | undefined,
): string {
  return (s ?? "").trim();
}

/**
 * One text field — display name, or description.
 *
 * ⚠ `null`, `undefined` and `""` all collapse to the same thing. None of them
 * is a value Apple would store as different from the others, and the repo has
 * been treating them that way since IAP.o.12.
 */
export function localizationTextEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeLocalizationText(a) === normalizeLocalizationText(b);
}

/** The two fields a localization carries. Locale is NOT part of the content. */
export interface LocalizationContent {
  name: string | null | undefined;
  description: string | null | undefined;
}

/**
 * Both fields together — the unit the Manager's rule is phrased in.
 *
 * ⚠ THE RULE IS "OR", AND THAT IS LOAD-BEARING. Manager, R2b: *"nội dung KHÔNG
 * trùng hoàn toàn (khác Display Name **HOẶC** khác Description)"* ⇒ equality
 * requires BOTH to match. Comparing only the display name is the obvious
 * shortcut and it would silently drop every description-only edit — the exact
 * silent-skip class this arc exists to remove.
 *
 * ⚠ LOCALE IS DELIBERATELY NOT COMPARED. Callers pair a file row with an Apple
 * row BY locale before calling this; folding the locale in here would let a
 * caller pass a mismatched pair and get a confident answer about two different
 * languages.
 */
export function localizationContentEquals(
  a: LocalizationContent,
  b: LocalizationContent,
): boolean {
  return (
    localizationTextEquals(a.name, b.name) &&
    localizationTextEquals(a.description, b.description)
  );
}
