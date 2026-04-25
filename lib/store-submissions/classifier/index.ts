/**
 * Store Management email classifier — 5-step pure pipeline.
 *
 * Contract (spec §1): deterministic, fail-soft, traceable, pure.
 *   - No I/O. No DB, no fetch, no logging, no env reads other than
 *     NODE_ENV for a dev-only correctness assertion.
 *   - Every decision returns via `ClassificationResult`; exceptions are
 *     caught and returned as `ErrorResult` unless they're unexpected
 *     (those propagate so the caller can log + alert).
 *
 * Pipeline (spec §3):
 *   1. sender  → platform         | null → DROPPED: NO_SENDER_MATCH
 *   2. subject → outcome + name   | null → DROPPED: SUBJECT_NOT_TRACKED
 *   3. app     → app_id           | null → UNCLASSIFIED_APP
 *   4. type    → type_id + payload| null → UNCLASSIFIED_TYPE
 *   5. submission_id              | null → fine, continue
 *   → CLASSIFIED
 *
 * Gmail sync (PR-8) consumes `status` to decide which side-effects run;
 * this file stays oblivious to that.
 */

import { InvalidRegexError, RegexTimeoutError } from '../regex/re2';

import { matchApp } from './app-matcher';
import { matchSender } from './sender-matcher';
import { matchSubject } from './subject-matcher';
import { extractSubmissionId } from './submission-id-extractor';
import { matchType } from './type-matcher';
import type {
  ClassificationResult,
  EmailInput,
  MatchedRule,
  RulesSnapshot,
} from './types';

/**
 * Dev/test-only contract check: every app in `apps_with_aliases` must
 * have a platform binding to `rules.platform_id`. Callers are supposed
 * to pre-filter (see `getRulesSnapshotForPlatform` helper); without this
 * assertion a caller bug would silently match an Android app under Apple
 * emails and emit wrong CLASSIFIED results.
 *
 * Compiled-out in production (`NODE_ENV === 'production'`) so prod has
 * zero overhead.
 */
function assertAppsScopedToPlatform(rules: RulesSnapshot): void {
  if (process.env.NODE_ENV === 'production') return;

  const mismatched = rules.apps_with_aliases.filter(
    (app) => !app.platform_bindings.some((b) => b.platform_id === rules.platform_id),
  );

  if (mismatched.length > 0) {
    const names = mismatched
      .slice(0, 3)
      .map((a) => a.name)
      .join(', ');
    const extra = mismatched.length > 3 ? ` (+${mismatched.length - 3} more)` : '';
    throw new Error(
      `RulesSnapshot contract violation: ${mismatched.length} app(s) [${names}${extra}] ` +
        `have no binding to platform_key=${rules.platform_key} (${rules.platform_id}). ` +
        `Callers must pre-filter apps_with_aliases. ` +
        `See getRulesSnapshotForPlatform() in lib/store-submissions/queries/rules.ts.`,
    );
  }
}

export function classify(
  email: EmailInput,
  rules: RulesSnapshot,
): ClassificationResult {
  assertAppsScopedToPlatform(rules);

  const matched: MatchedRule[] = [];

  try {
    // Step 1 — sender
    const senderMatch = matchSender(email, rules);
    if (!senderMatch) {
      return { status: 'DROPPED', reason: 'NO_SENDER_MATCH' };
    }
    matched.push({
      step: 'sender',
      matched: true,
      details: {
        platform_id: senderMatch.platform_id,
        platform_key: senderMatch.platform_key,
        matched_sender: senderMatch.sender_email,
      },
    });

    // Step 2 — subject. A sender-matched email whose subject hits no
    // configured pattern is NOT an error: the subject-pattern list is a
    // whitelist of event types Managers care about (e.g. Apple sends
    // "Ready for Distribution" / "IAP Approved" daily alongside the
    // submission-review email we actually track). Flag as DROPPED with
    // SUBJECT_NOT_TRACKED and preserve the sender trace for auditing.
    const subjectMatch = matchSubject(email.subject, rules);
    if (!subjectMatch) {
      return {
        status: 'DROPPED',
        reason: 'SUBJECT_NOT_TRACKED',
        platform_id: senderMatch.platform_id,
        platform_key: senderMatch.platform_key,
        matched_sender: senderMatch.sender_email,
        matched_rules: matched,
      };
    }
    matched.push({
      step: 'subject',
      matched: true,
      details: {
        pattern_id: subjectMatch.pattern_id,
        outcome: subjectMatch.outcome,
        matched_pattern: subjectMatch.matched_pattern,
        extracted_app_name: subjectMatch.extracted_app_name,
      },
    });

    // Step 3 — app lookup by extracted name
    const appMatch = matchApp(subjectMatch.extracted_app_name, rules.apps_with_aliases);
    if (!appMatch) {
      matched.push({ step: 'app', matched: false });
      return {
        status: 'UNCLASSIFIED_APP',
        platform_id: rules.platform_id,
        outcome: subjectMatch.outcome,
        extracted_app_name: subjectMatch.extracted_app_name,
        matched_rules: matched,
      };
    }
    matched.push({
      step: 'app',
      matched: true,
      details: {
        app_id: appMatch.app_id,
        app_name: appMatch.app_name,
        matched_alias: appMatch.matched_alias,
      },
    });

    // Step 4 — type + payload
    const typeMatch = matchType(email, rules);
    if (!typeMatch) {
      matched.push({ step: 'type', matched: false });
      // extracted_app_name is non-null here because Step 3 would have
      // returned UNCLASSIFIED_APP with null app match if it were missing.
      const appName = subjectMatch.extracted_app_name ?? appMatch.app_name;
      return {
        status: 'UNCLASSIFIED_TYPE',
        platform_id: rules.platform_id,
        app_id: appMatch.app_id,
        outcome: subjectMatch.outcome,
        extracted_app_name: appName,
        matched_rules: matched,
      };
    }
    matched.push({
      step: 'type',
      matched: true,
      details: {
        type_id: typeMatch.type_id,
        type_slug: typeMatch.type_slug,
        type_name: typeMatch.type_name,
        payload: typeMatch.payload,
      },
    });

    // Step 5 — submission_id (optional, never errors)
    const subIdMatch = extractSubmissionId(email.body, rules);
    matched.push({
      step: 'submission_id',
      matched: !!subIdMatch,
      details: subIdMatch
        ? {
            pattern_id: subIdMatch.pattern_id,
            submission_id: subIdMatch.submission_id,
          }
        : undefined,
    });

    const extractedName = subjectMatch.extracted_app_name ?? appMatch.app_name;
    return {
      status: 'CLASSIFIED',
      platform_id: rules.platform_id,
      app_id: appMatch.app_id,
      type_id: typeMatch.type_id,
      outcome: subjectMatch.outcome,
      type_payload: typeMatch.payload,
      submission_id: subIdMatch?.submission_id ?? null,
      extracted_app_name: extractedName,
      matched_rules: matched,
    };
  } catch (err) {
    if (err instanceof RegexTimeoutError) {
      return {
        status: 'ERROR',
        error_code: 'REGEX_TIMEOUT',
        error_message: err.message,
        matched_rules: matched,
      };
    }
    if (err instanceof InvalidRegexError) {
      return {
        status: 'ERROR',
        error_code: 'PARSE_ERROR',
        error_message: err.message,
        matched_rules: matched,
      };
    }
    throw err;
  }
}

export type {
  AppAlias,
  AppWithAliases,
  ClassificationResult,
  ClassifiedResult,
  DroppedReason,
  DroppedResult,
  EmailInput,
  ErrorResult,
  MatchedRule,
  PlatformKey,
  RulesSnapshot,
  Sender,
  SubjectPattern,
  Type,
  SubmissionIdPattern,
  UnclassifiedAppResult,
  UnclassifiedTypeResult,
} from './types';
