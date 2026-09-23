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
 *
 * ⚠⚠ `ACTIVE` HAS ONLY EVER BEEN SEEN ON THE **WRITE** PATH.
 * It comes from the body of a `409` answering
 * `PATCH /v1/inAppPurchaseLocalizations/{id}`. On the **READ** path
 * (`GET /v2/inAppPurchases/{id}?include=…`) the same live row comes back as
 * `APPROVED` — measured 2026-09-24, KB §30.1.
 *
 * ⇒ Matching this set against a state READ from Apple will essentially never
 *   hit. That is not a bug here — this set exists to phrase a refusal Apple has
 *   already sent, and at that moment `ACTIVE` is exactly the word in hand. But
 *   do NOT build a read-side guard on it (KB §29.4: a guard that never fires).
 */
export const KNOWN_BLOCKED_LOCALIZATION_STATES: ReadonlySet<string> = new Set([
  "ACTIVE",
]);

/**
 * ⚠ WHY `APPROVED` IS DELIBERATELY IN NEITHER SET — do not "fix" this.
 *
 * Measured 2026-09-24: the live row of a live IAP reads back as `APPROVED`
 * (KB §30.1). The tempting next step is to add it to the blocked set, since the
 * live row is the one Apple refused. ⛔ There is not enough evidence yet, and
 * the gap is a real fork, not a formality:
 *
 *   (a) READ and WRITE use different VOCABULARIES for one row — `APPROVED` when
 *       read IS `ACTIVE` when written (V1 and V2 are different MODELS, KB
 *       §28.3). Then `APPROVED` belongs in the blocked set.
 *   (b) The two observations are from different TIMES — the 409 predates the
 *       draft row existing; the state may simply have changed. Then `APPROVED`
 *       may be perfectly patchable, and blocking it would refuse work that
 *       would have succeeded.
 *
 * ⇒ Until one import settles it (KB §30.6), `APPROVED` classifies as `UNKNOWN`,
 *   which is the honest answer and the safe one: `UNKNOWN` never claims a row is
 *   fine, and never claims it is blocked.
 *
 * ⭐ AND THE ALLOW-LIST DESIGN IS CORRECT UNDER **BOTH** BRANCHES — this is why
 * the fork does not block shipping. `pickPatchTarget` (localization-sync.ts)
 * prefers a `PATCHABLE` row and otherwise falls back to the first candidate:
 *
 *   · two rows (live + draft) → the draft is `PREPARE_FOR_SUBMISSION`, so the
 *     draft is chosen. Right under (a) — it dodges the blocked row — and right
 *     under (b) too, since the draft is the correct target regardless (edited in
 *     place, no new version, no re-review).
 *   · one row only (live, `APPROVED`) → nothing is PATCHABLE, the attempt still
 *     goes out, and Apple decides. Right under (a) (refusal, explained) and
 *     right under (b) (it succeeds, which is what was wanted).
 *
 * A DENY-list would NOT have this property: it would have to guess which branch
 * is true before either could be observed.
 */

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
