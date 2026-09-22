/**
 * Why a Bulk Import row's localization failed — per locale, kept.
 *
 * ⚠ THIS MODULE EXISTS BECAUSE THE REASON USED TO BE THROWN AWAY.
 * Every one of the three localization catch blocks in the execute route did
 * the same two things: push the LOCALE CODE onto `failedLocales`, and hand
 * Apple's actual response to `log()`. The code reached the Manager via
 * `stages.localizations.failed`; the reason reached a Railway log line that
 * ages out. So a batch could report 20 rows all failing locale `vi` and carry
 * not one word about WHY — which is exactly the investigation that produced
 * this file (2026-09-21: 20 identical PARTIAL rows, `error: null` on all 20).
 *
 * ⚠ SAME CLASS AS THE body-429 HOLE. An error that is logged but not
 * PERSISTED is an error that does not exist the next morning. `pricing`,
 * `screenshot`, `availability` and `submit` all already carry an `error` into
 * the stage map (row-outcome.ts) — `localizations` was the one stage that
 * carried only a list of names. CLAUDE.md meta-rule P1: one shared choke
 * point, not three separate patches at three catch blocks.
 */
import { describeAppleError } from "./apple-error-descriptor";

/**
 * One locale that Apple refused, and what Apple said about it.
 *
 * ⚠ THE TRIPLE MIRRORS THE ROW LEVEL, DELIBERATELY. `error` /
 * `error_full` / `error_http_status` is the shape `PerIapResult` has carried
 * since the descriptor was extracted; reusing it here means a reader who
 * already knows how to read a failed ROW can read a failed LOCALE without
 * learning a second vocabulary — and `full` is the field that actually
 * answers "why", because Apple puts its `detail` string in the body.
 */
export interface LocaleFailure {
  locale: string;
  /** Capped at 500 chars by `describeAppleError` — safe for a table cell. */
  message: string;
  /** Apple's COMPLETE response body, never sliced. The diagnostic field. */
  full?: string;
  /** Apple's HTTP status, when the throw was an `AppleApiError`. */
  httpStatus?: number;
}

/**
 * Record one locale's failure into the row's single failure list.
 *
 * ⚠ ONE LIST, NOT TWO. The stage map needs both "which locales" and "why",
 * and keeping those in two parallel arrays is how they drift. `failed` is
 * DERIVED from this list via `localeCodes` at the point the stage map is
 * built, so the two cannot disagree by construction.
 *
 * `context` prefixes the message when the failure did not come from the
 * locale's own request — e.g. the OVERWRITE path's pre-flight LIST call,
 * whose single throw means no locale was attempted at all.
 */
export function recordLocaleFailure(
  into: LocaleFailure[],
  locale: string,
  err: unknown,
  context?: string,
): LocaleFailure {
  const desc = describeAppleError(err);
  const entry: LocaleFailure = {
    locale,
    message: context ? `${context}: ${desc.message}` : desc.message,
    full: context ? `${context}: ${desc.full}` : desc.full,
    ...(desc.httpStatus !== undefined ? { httpStatus: desc.httpStatus } : {}),
  };
  into.push(entry);
  return entry;
}

/** The locale codes, in failure order — what `stages.localizations.failed` is. */
export function localeCodes(failures: readonly LocaleFailure[]): string[] {
  return failures.map((f) => f.locale);
}

/**
 * ⚠ THE PRE-FLIGHT THROW MEANS *NOTHING WAS SENT*, AND THE STAGE MUST SAY SO.
 *
 * On the OVERWRITE path the LIST call, `planLocalizationSync`, and the
 * suppressed-deletions log all sit in front of the PATCH/POST/DELETE loops
 * inside one outer `try`. If any of them throws, zero localization writes
 * happened — yet before this the outer catch only wrote a log line, leaving
 * `failed` empty, `done` equal to `total`, and the stage reading **OK** for a
 * row where Apple was never told anything. That is a stage map that lies, and
 * it lies in the safe-looking direction.
 *
 * Marks every locale NOT already recorded, so it stays correct (and
 * idempotent) no matter where in the block the throw came from.
 */
export function recordAllLocalesFailed(
  into: LocaleFailure[],
  locales: readonly { locale: string }[],
  err: unknown,
  context: string,
): void {
  const already = new Set(into.map((f) => f.locale));
  for (const l of locales) {
    if (already.has(l.locale)) continue;
    recordLocaleFailure(into, l.locale, err, context);
  }
}
