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
 * **Unicode: NFC — ON THE COMPARISON SIDE ONLY. Manager decision Q5,
 * 2026-09-25.** ⚠⚠ AND THE TWO SIDES ARE DIFFERENT FUNCTIONS FOR THAT REASON:
 *   `localizationComparisonKey` — trim + **NFC**. Answers "are these the same?"
 *   `normalizeLocalizationText` — trim ONLY. Produces the value that is WRITTEN.
 * Manager's wording: *"normalize NFC chỉ khi SO SÁNH; ghi lên Apple thì NGUYÊN
 * VĂN nội dung file."* The failure directions are not symmetric — normalizing a
 * comparison is safe, normalizing a payload **edits the Manager's data**.
 *
 * ⚠⚠ THIS WAS ALREADY A LIVE TRAP, NOT A HYPOTHETICAL. `diff-detector.ts` uses
 * `normalize` to BUILD the values it PATCHes to Apple (`:173, :178, :212-213,
 * :222, :225`), not only to compare. Had NFC been added to that one function,
 * every localization the edit form writes would have been silently
 * re-encoded — a data change nobody asked for, invisible in every test that
 * compares normalized-to-normalized. The split below is what prevents it.
 *
 * ⚠ HISTORY — the rule used to be "no Unicode normalization at all", with this
 * note attached:
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
 *   ⇒ `"Vàng"` (NFC) and `"Vàng"` (NFD) look identical and compared UNEQUAL, so
 *     a cell reading "no change" was classified as a change. Under the V2 model
 *     that costs a new version and a re-review **for an edit that does not
 *     exist** — and the version cannot be deleted afterwards.
 *   ⇒ Manager closed it as Q5 rather than waiting for the codepoint
 *     measurement, because the cost is asymmetric in the same direction the
 *     measurement would have had to resolve.
 *
 * ⚠ NFC DOES NOT MEAN "FOLD EVERYTHING". `"188 Vàng"` vs `"188 Vàng."` differ
 * by one full stop and that IS a real change the Manager wants; NFC does not
 * touch it. Case is not folded either. Only encoding is canonicalised.
 */

/**
 * ⭐ THE VALUE THAT GETS WRITTEN. Trim only — **never** NFC.
 *
 * ⚠ Used by `diff-detector` to build PATCH payloads. Adding normalisation here
 * would re-encode the Manager's text on its way to Apple (Q5).
 */
export function normalizeLocalizationText(
  s: string | null | undefined,
): string {
  return (s ?? "").trim();
}

/**
 * ⭐ THE KEY USED TO ASK "ARE THESE THE SAME?" — trim + NFC.
 *
 * ⚠ NEVER WRITE THIS VALUE ANYWHERE. It exists to be compared and discarded.
 * Q5's whole point is that the comparison may canonicalise while the payload
 * may not; the moment this string is persisted or sent, that distinction is
 * gone and the Manager's data has been edited.
 */
export function localizationComparisonKey(
  s: string | null | undefined,
): string {
  return (s ?? "").trim().normalize("NFC");
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
  return localizationComparisonKey(a) === localizationComparisonKey(b);
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
