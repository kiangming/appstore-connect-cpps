/**
 * Domain validators for user-provided regex patterns.
 *
 * Every validator runs re2Validate first (RE2 compile check) then applies
 * domain rules specific to where the pattern is used:
 *   - subject_patterns.regex  → named group `app_name` required
 *   - types.payload_extract_regex → optional named groups
 *   - app_aliases.alias_regex → no required groups, but reject empty/too-permissive
 *   - submission_id_patterns.body_regex → named group `submission_id` required
 *
 * See docs/store-submissions/03-email-rule-engine.md §4.4.
 */

import { re2Test, re2Validate } from './re2';

export type ValidatorResult = { ok: true } | { ok: false; error: string };

/**
 * Detect a named capture group in a RE2 pattern.
 *
 * Accepts both JS-style `(?<name>...)` and Python-style `(?P<name>...)`
 * because users may paste patterns copied from Python tooling — RE2 accepts
 * both syntaxes internally.
 *
 * The check is a regex on the pattern itself; not a full parser. It will
 * flag groups inside character classes `[(?<x>)]` as present, but that's
 * a syntactically invalid RE2 pattern anyway (caught by re2Validate first).
 */
function hasNamedGroup(pattern: string, groupName: string): boolean {
  const escaped = groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\(\\?P?<${escaped}>`).test(pattern);
}

function ensureCompilable(pattern: string): ValidatorResult {
  const compile = re2Validate(pattern);
  if (!compile.ok) return { ok: false, error: compile.error };
  return { ok: true };
}

export function validateSubjectPattern(pattern: string): ValidatorResult {
  const compile = ensureCompilable(pattern);
  if (!compile.ok) return compile;
  if (!hasNamedGroup(pattern, 'app_name')) {
    return { ok: false, error: 'Subject pattern must contain a named group (?<app_name>...)' };
  }
  return { ok: true };
}

export function validatePayloadRegex(pattern: string): ValidatorResult {
  return ensureCompilable(pattern);
}

export function validateSubmissionIdPattern(pattern: string): ValidatorResult {
  const compile = ensureCompilable(pattern);
  if (!compile.ok) return compile;
  if (!hasNamedGroup(pattern, 'submission_id')) {
    return { ok: false, error: 'Submission ID pattern must contain a named group (?<submission_id>...)' };
  }
  return { ok: true };
}

const PERMISSIVE_PROBE = ['a', 'x', '1', ' '];

/**
 * Validate an app alias regex.
 *
 * Aliases are matched against `extractedAppName` from subject patterns — a
 * regex that matches every string would bind every email to a single app.
 * Reject obviously-permissive patterns up front; finer guards live in the
 * classifier itself.
 */
export function validateAliasRegex(pattern: string): ValidatorResult {
  if (!pattern || pattern.trim() === '') {
    return { ok: false, error: 'Alias regex cannot be empty' };
  }
  if (pattern.length < 3) {
    return { ok: false, error: 'Alias regex must be at least 3 characters' };
  }

  const compile = ensureCompilable(pattern);
  if (!compile.ok) return compile;

  if (re2Test(pattern, '')) {
    return { ok: false, error: 'Alias regex matches empty string — too permissive' };
  }

  if (PERMISSIVE_PROBE.every((probe) => re2Test(pattern, probe))) {
    return { ok: false, error: 'Alias regex is too permissive (matches arbitrary single characters)' };
  }

  return { ok: true };
}
