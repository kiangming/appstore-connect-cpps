/**
 * [LOC-ACTIVE-state] — classifying an Apple localization's `state`, and the
 * reason this is an ALLOW-list.
 *
 * ⚠ THE INCIDENT. 2026-09-22, an 88-row bulk import: 66 rows fine, 20 rows
 * identical — `localizations { done: 0, total: 1, failed: ["vi"] }`. Apple's
 * own words, recovered because `failedDetail[].full` had shipped one arc
 * earlier:
 *
 *     HTTP 409
 *     code:   ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE
 *     detail: "Cannot edit InAppPurchaseLocalization when it is in ACTIVE state"
 *     source.pointer: /data/attributes/state
 *
 * The 20 rows were live/approved products; the 66 were not yet ACTIVE.
 *
 * ⚠ AND `ACTIVE` IS NOT IN APPLE'S OWN SCHEMA. `InAppPurchaseLocalization.
 * attributes.state` in `docs/openapi.oas.v20260717.json` (v4.4.1) enumerates
 * only `PREPARE_FOR_SUBMISSION · WAITING_FOR_REVIEW · APPROVED · REJECTED`.
 * A machine scan of every `enum` in the whole document found `"ACTIVE"` in
 * exactly two places — `Profile.profileState` and `PhasedReleaseState` —
 * neither in the in-app-purchase branch. Apple returns a state its published
 * spec does not list.
 *
 * ⚠⚠ THAT IS WHY THIS IS AN ALLOW-LIST AND MUST STAY ONE.
 * A deny-list ("block the states we know are bad") is only as complete as the
 * enum it is built from, and the enum is DEMONSTRABLY incomplete — it missed
 * the single state that caused the incident. A deny-list built from it would
 * have let `ACTIVE` through, which is precisely the bug. An allow-list fails
 * the other way: a state nobody has seen reads as UNKNOWN, not as "fine".
 */

/**
 * States we have POSITIVE evidence are editable. Deliberately short.
 *
 * ⚠ EVIDENCE, NOT INFERENCE. `PREPARE_FOR_SUBMISSION` is here because App
 * Store Connect itself puts a freshly-created, still-editable localization in
 * exactly this state — observed by the Manager on 2026-09-22 when editing a
 * live IAP's display name produced a second `Vietnamese` row reading
 * "Prepare for Submission" beside the Approved one.
 *
 * ⚠ DO NOT ADD A STATE HERE BECAUSE IT "LOOKS EDITABLE". `APPROVED` and
 * `REJECTED` are in Apple's enum and are NOT in this list, because nothing in
 * the repo or in the incident shows a successful PATCH against either. If a
 * real run proves one editable, add it WITH the run as the citation.
 */
export const PATCHABLE_LOCALIZATION_STATES: ReadonlySet<string> = new Set([
  "PREPARE_FOR_SUBMISSION",
]);

/**
 * States Apple has REFUSED, in its own words. Used only to phrase the reason
 * — never to decide editability (that is `PATCHABLE_LOCALIZATION_STATES`).
 */
export const KNOWN_BLOCKED_LOCALIZATION_STATES: ReadonlySet<string> = new Set([
  "ACTIVE",
]);

/**
 * ⚠ THREE OUTCOMES, AND `UNKNOWN` IS NOT A SYNONYM FOR EITHER OTHER ONE.
 *
 *   PATCHABLE — positive evidence this state accepts an edit.
 *   BLOCKED   — Apple has refused this state, quoting it back to us.
 *   UNKNOWN   — no state on the record, or a state nobody has classified.
 *
 * Collapsing UNKNOWN into PATCHABLE reproduces the incident (that is what the
 * code did before: it never looked, so everything was implicitly patchable).
 * Collapsing it into BLOCKED would silently stop editing rows that are
 * perfectly fine the moment Apple adds an enum value. Callers must handle all
 * three.
 */
export type LocalizationEditability = "PATCHABLE" | "BLOCKED" | "UNKNOWN";

export function classifyLocalizationState(
  state: string | null | undefined,
): LocalizationEditability {
  if (!state) return "UNKNOWN";
  if (PATCHABLE_LOCALIZATION_STATES.has(state)) return "PATCHABLE";
  if (KNOWN_BLOCKED_LOCALIZATION_STATES.has(state)) return "BLOCKED";
  return "UNKNOWN";
}

/**
 * One sentence a Manager can act on, for a locale whose edit did not land.
 *
 * ⚠ THIS EXISTS BECAUSE "failed: [vi]" IS NOT AN ANSWER. The whole 20-row
 * investigation was spent recovering a fact the row could have carried. When
 * the state is known-blocked the sentence says so AND says what the remedy
 * actually is — editing a live localization requires a NEW VERSION on Apple's
 * side (see KB §28), not a retry.
 */
export function describeLocalizationState(
  locale: string,
  state: string | null | undefined,
): string {
  switch (classifyLocalizationState(state)) {
    case "BLOCKED":
      return (
        `${locale}: Apple will not edit this localization while it is in ` +
        `${state} state — the product is live. Changing it requires a new ` +
        `in-app purchase version and another review.`
      );
    case "UNKNOWN":
      return state
        ? `${locale}: Apple reports state ${state}, which this tool has no ` +
          `record of. The edit may be refused.`
        : `${locale}: Apple did not report a state for this localization.`;
    case "PATCHABLE":
      return `${locale}: state ${state} — editable.`;
  }
}
