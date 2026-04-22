/**
 * Type contract for the Store Management email classifier.
 *
 * The classifier is a PURE function: no DB access, no network, no logging,
 * no cache. All inputs arrive in `RulesSnapshot`; all results live in the
 * returned `ClassificationResult`. See
 *   docs/store-submissions/03-email-rule-engine.md §2
 *
 * Type names mirror the spec where reasonable. Field shapes are kept
 * deliberately minimal — we don't import DB row types (SenderRow etc.)
 * because the classifier must not depend on the persistence layer.
 * The test endpoint (Chunk 2.3) and the Gmail sync caller (PR-8) adapt
 * their DB rows into these shapes.
 */

import type { Outcome } from '../schemas/rules';

// -- Inputs --------------------------------------------------------------

export type PlatformKey = 'apple' | 'google' | 'huawei' | 'facebook';

export interface EmailInput {
  /**
   * Normalized sender email. Callers MUST strip display names
   * ("Apple <no-reply@apple.com>" → "no-reply@apple.com") and trim
   * whitespace before passing. We still lowercase defensively inside the
   * classifier so a caller bug never silently causes DROPPED.
   */
  sender: string;
  subject: string;
  /**
   * Body text. Caller SHOULD slice to ~100KB before passing — RE2 is
   * linear-time but body size still dominates wall-clock. Gmail sync
   * clips to 100_000 chars (spec §4.3).
   */
  body: string;
}

export interface Sender {
  id: string;
  email: string;
  is_primary: boolean;
  active: boolean;
}

export interface SubjectPattern {
  id: string;
  outcome: Outcome;
  regex: string;
  priority: number;
  active: boolean;
}

export interface Type {
  id: string;
  name: string;
  slug: string;
  body_keyword: string;
  payload_extract_regex: string | null;
  sort_order: number;
  active: boolean;
}

export interface SubmissionIdPattern {
  id: string;
  body_regex: string;
  active: boolean;
}

export type AliasSourceType =
  | 'AUTO_CURRENT'
  | 'AUTO_HISTORICAL'
  | 'MANUAL'
  | 'REGEX';

export interface AppAlias {
  /** One of alias_text / alias_regex is set; never both. Mirrors DB CHECK. */
  alias_text: string | null;
  alias_regex: string | null;
  source_type: AliasSourceType;
}

export interface AppWithAliases {
  id: string;
  name: string;
  aliases: AppAlias[];
  /**
   * Only the `platform_id` field is needed — the classifier uses this to
   * verify, in dev/test mode, that the caller pre-filtered apps correctly.
   */
  platform_bindings: Array<{ platform_id: string }>;
}

/**
 * Everything `classify()` needs to decide.
 *
 * **Caller contract**: `apps_with_aliases` MUST be pre-filtered to apps
 * that have a binding to `platform_id`. See `getRulesSnapshotForPlatform`
 * helper in queries/rules.ts for the canonical composition. Violation is
 * detected (in non-production builds only) by an assertion in classify().
 */
export interface RulesSnapshot {
  platform_id: string;
  platform_key: PlatformKey;
  senders: Sender[];
  subject_patterns: SubjectPattern[];
  types: Type[];
  submission_id_patterns: SubmissionIdPattern[];
  apps_with_aliases: AppWithAliases[];
}

// -- Outputs -------------------------------------------------------------

/**
 * One entry per pipeline step; accumulates into matched_rules[] on the
 * result. `details` is step-specific (see per-step matchers).
 */
export type ClassificationStep =
  | 'sender'
  | 'subject'
  | 'app'
  | 'type'
  | 'submission_id';

export interface MatchedRule {
  step: ClassificationStep;
  matched: boolean;
  details?: Record<string, unknown>;
}

export type DroppedReason = 'NO_SENDER_MATCH' | 'SUBJECT_NOT_TRACKED';

export interface DroppedResult {
  status: 'DROPPED';
  reason: DroppedReason;
  /**
   * Audit fields — populated when the classifier has progressed past the
   * sender step before dropping (currently only `SUBJECT_NOT_TRACKED`).
   * Absent for `NO_SENDER_MATCH` to keep legacy rows untouched.
   */
  platform_id?: string;
  platform_key?: PlatformKey;
  matched_sender?: string;
  matched_rules?: MatchedRule[];
}

export interface UnclassifiedAppResult {
  status: 'UNCLASSIFIED_APP';
  platform_id: string;
  outcome: Outcome;
  extracted_app_name: string | null;
  matched_rules: MatchedRule[];
}

export interface UnclassifiedTypeResult {
  status: 'UNCLASSIFIED_TYPE';
  platform_id: string;
  app_id: string;
  outcome: Outcome;
  extracted_app_name: string;
  matched_rules: MatchedRule[];
}

export interface ClassifiedResult {
  status: 'CLASSIFIED';
  platform_id: string;
  app_id: string;
  type_id: string;
  outcome: Outcome;
  type_payload: Record<string, string>;
  submission_id: string | null;
  extracted_app_name: string;
  matched_rules: MatchedRule[];
}

export type ErrorCode = 'REGEX_TIMEOUT' | 'PARSE_ERROR';

export interface ErrorResult {
  status: 'ERROR';
  error_code: ErrorCode;
  error_message: string;
  matched_rules: MatchedRule[];
}

export type ClassificationResult =
  | DroppedResult
  | UnclassifiedAppResult
  | UnclassifiedTypeResult
  | ClassifiedResult
  | ErrorResult;

// -- Per-step matcher return contracts ----------------------------------
//
// Exported so 2.2 matchers + orchestrator tests share a single type source.

export interface SenderMatch {
  platform_id: string;
  platform_key: PlatformKey;
  sender_email: string;
}

export interface SubjectMatch {
  pattern_id: string;
  outcome: Outcome;
  /** Contents of the (?<app_name>...) named group, trimmed. May be null. */
  extracted_app_name: string | null;
  matched_pattern: string;
}

export interface AppMatch {
  app_id: string;
  app_name: string;
  matched_alias: {
    kind: 'text' | 'regex';
    value: string;
    source_type: AliasSourceType;
  };
}

export interface TypeMatch {
  type_id: string;
  type_slug: string;
  type_name: string;
  /** Named-group captures from payload_extract_regex. Empty object if regex is null / no groups. */
  payload: Record<string, string>;
}

export interface SubmissionIdMatch {
  pattern_id: string;
  submission_id: string;
}
