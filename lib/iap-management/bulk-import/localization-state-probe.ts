/**
 * ⏳ TEMPORARY INSTRUMENTATION — DELETE ONCE IT HAS ANSWERED.
 * Arc `[BULKIMPORT-loc-step]`, Manager-approved 2026-09-23.
 *
 * ⚠ THIS LINE EXISTS TO ANSWER EXACTLY TWO QUESTIONS, AND NOTHING ELSE:
 *
 *   1. Does Apple actually POPULATE `state` on a localization GET?
 *      OAS 4.4.1 declares the field; a machine scan of this repo finds NO
 *      fixture, log or test in which Apple ever returned one. "The schema says
 *      so" and "we have seen it" are different claims, and only the second one
 *      can be built on (KB §29).
 *
 *   2. Does Apple return MORE THAN ONE row for the same locale?
 *      ASC shows two rows for one locale after editing a live IAP (KB §28.6,
 *      §28.7), but nothing in this repo has ever observed the API side of it.
 *      `pickPatchTarget` was written for that shape without being able to
 *      confirm the API produces it.
 *
 * ⚠ WHY A LOG AND NOT A QUERY. `state` is currently touched only inside the
 * PATCH catch block, so a SUCCESSFUL row records nothing — and the arc's three
 * real batches (2026-09-22 13:44/13:52) predate that code by ~9 hours. Neither
 * SQL over `actions_log` nor Apple's OpenAPI can answer either question. One
 * unconditional log line on the next real import can, at zero extra requests.
 *
 * ⚠⚠ REMOVAL IS PART OF THE JOB, NOT A NICE-TO-HAVE. When the next import has
 * run: write the answer into KB §28.11.b, then DELETE this module and its call
 * site. Precedent: the DEBUG 429-header line from the key-pool arc, added to
 * settle one question and removed once settled. An "informative" log kept
 * forever is how a log file becomes unreadable.
 */

/** One localization row, as loosely as Apple might actually send it. */
export interface ProbeRow {
  attributes?: { locale?: unknown; state?: unknown };
}

/**
 * ⚠ THREE OUTCOMES, NOT TWO — and telling them apart IS the question.
 *   ABSENT — the key is not there at all      ⇒ Apple does not send `state`
 *   EMPTY  — the key is there, value is ""    ⇒ Apple sends it, unpopulated
 *   <value> — an actual state
 * Collapsing ABSENT and EMPTY would destroy the very distinction being probed.
 */
function readState(attrs: { state?: unknown } | undefined): string {
  if (!attrs || !("state" in attrs) || attrs.state === undefined) return "ABSENT";
  if (attrs.state === null) return "NULL";
  if (typeof attrs.state !== "string") return `NON_STRING(${typeof attrs.state})`;
  return attrs.state === "" ? "EMPTY" : attrs.state;
}

function readLocale(attrs: { locale?: unknown } | undefined): string {
  return typeof attrs?.locale === "string" && attrs.locale !== ""
    ? attrs.locale
    : "ABSENT";
}

/**
 * One greppable line describing what Apple just returned for one IAP.
 *
 * Shape (stable — Manager greps it):
 *   LOC-STATE-PROBE product=<id> total=<n> rows=[vi=ACTIVE, vi=PREPARE_FOR_SUBMISSION] dupes=[vi x2]
 *
 * `dupes` is empty when every locale appeared once; a non-empty `dupes` is the
 * direct answer to question 2.
 */
export function describeLocalizationStatesForLog(
  productId: string,
  rows: ReadonlyArray<ProbeRow>,
): string {
  const parsed = rows.map((r) => ({
    locale: readLocale(r.attributes),
    state: readState(r.attributes),
  }));

  const counts = new Map<string, number>();
  for (const p of parsed) counts.set(p.locale, (counts.get(p.locale) ?? 0) + 1);
  const dupes = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([locale, n]) => `${locale} x${n}`);

  return (
    `LOC-STATE-PROBE product=${productId} total=${rows.length} ` +
    `rows=[${parsed.map((p) => `${p.locale}=${p.state}`).join(", ")}] ` +
    `dupes=[${dupes.join(", ")}]`
  );
}
