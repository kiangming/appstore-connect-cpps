/**
 * Client-safe regex validators.
 *
 * The RE2 validators in ./validators.ts import `re2-wasm`, which drags Node's
 * `fs` into the webpack browser bundle and breaks `next build`. This module
 * mirrors the same rules using the browser's own JavaScript RegExp engine —
 * good enough for keystroke-by-keystroke UI feedback. The authoritative
 * RE2-based check still runs server-side inside the save actions via the
 * zod refinements on ../schemas/rules.ts, so anything this approximate
 * validator accepts but RE2 rejects is caught at submit time.
 *
 * Divergence vs RE2:
 *   - JS RegExp accepts lookbehind / backreferences; RE2 does not. We do not
 *     try to flag those here — the server rejects them.
 *   - RE2 accepts `(?P<name>...)` (Python-style named groups); JS does not.
 *     We rewrite `(?P<name>` → `(?<name>` before handing to RegExp so the
 *     named-group detector works for pasted Python patterns too. The rewrite
 *     is purely for validation; the pattern the user typed is what gets
 *     saved, and the server RE2 validator accepts both forms natively.
 */

export type ClientValidatorResult = { ok: true } | { ok: false; error: string };

const PERMISSIVE_PROBE = ['a', 'x', '1', ' '];

/**
 * Rewrite Python-style `(?P<name>` to JS-style `(?<name>` so
 * `new RegExp(pattern)` can compile patterns copied from Python tooling.
 * Only the group-open syntax differs between the two flavours; the rest of
 * the pattern (including nested groups and the group-reference `(?P=name)`)
 * is outside the scope of this UI-feedback shim — if present, RegExp will
 * throw and the user gets a "syntax error" message.
 */
function normalizePythonNamedGroups(pattern: string): string {
  return pattern.replace(/\(\?P</g, '(?<');
}

function compileClient(pattern: string): ClientValidatorResult & { compiled?: RegExp } {
  let compiled: RegExp;
  try {
    compiled = new RegExp(normalizePythonNamedGroups(pattern));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'syntax error';
    return { ok: false, error: `Invalid regex syntax: ${message}` };
  }
  return { ok: true, compiled };
}

/**
 * Mirrors validators.ts hasNamedGroup — accepts both JS and Python syntax.
 */
function hasNamedGroupClient(pattern: string, groupName: string): boolean {
  const escaped = groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\(\\?P?<${escaped}>`).test(pattern);
}

export function validateAliasRegexClient(pattern: string): ClientValidatorResult {
  if (!pattern || pattern.trim() === '') {
    return { ok: false, error: 'Alias regex cannot be empty' };
  }
  if (pattern.length < 3) {
    return { ok: false, error: 'Alias regex must be at least 3 characters' };
  }

  const compile = compileClient(pattern);
  if (!compile.ok) return { ok: false, error: compile.error };
  const compiled = compile.compiled as RegExp;

  if (compiled.test('')) {
    return { ok: false, error: 'Alias regex matches empty string — too permissive' };
  }

  if (PERMISSIVE_PROBE.every((probe) => compiled.test(probe))) {
    return { ok: false, error: 'Alias regex is too permissive (matches arbitrary single characters)' };
  }

  return { ok: true };
}

/**
 * Subject patterns MUST capture `app_name` — that group feeds Step 3
 * (app lookup by alias) in the classifier pipeline. See validators.ts for
 * the authoritative RE2 rule and docs/store-submissions/03-email-rule-engine.md §4.4.
 */
export function validateSubjectPatternClient(pattern: string): ClientValidatorResult {
  if (pattern.trim() === '') {
    return { ok: false, error: 'Subject pattern is required' };
  }
  const compile = compileClient(pattern);
  if (!compile.ok) return { ok: false, error: compile.error };
  if (!hasNamedGroupClient(pattern, 'app_name')) {
    return {
      ok: false,
      error: 'Subject pattern must contain a named group (?<app_name>...)',
    };
  }
  return { ok: true };
}

/**
 * Type payload_extract_regex — optional named groups. We still syntax-check
 * so an uncompilable pattern gets flagged on keystroke.
 */
export function validatePayloadRegexClient(pattern: string): ClientValidatorResult {
  if (pattern.trim() === '') {
    return { ok: false, error: 'Payload regex cannot be empty when provided' };
  }
  const compile = compileClient(pattern);
  if (!compile.ok) return { ok: false, error: compile.error };
  return { ok: true };
}

/**
 * Submission ID patterns MUST capture `submission_id` — that group is the
 * stored value on ticket_entries and drives thread-matching in the Ticket
 * Engine.
 */
export function validateSubmissionIdPatternClient(pattern: string): ClientValidatorResult {
  if (pattern.trim() === '') {
    return { ok: false, error: 'Submission ID pattern is required' };
  }
  const compile = compileClient(pattern);
  if (!compile.ok) return { ok: false, error: compile.error };
  if (!hasNamedGroupClient(pattern, 'submission_id')) {
    return {
      ok: false,
      error: 'Submission ID pattern must contain a named group (?<submission_id>...)',
    };
  }
  return { ok: true };
}
