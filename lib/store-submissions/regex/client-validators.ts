/**
 * Client-safe regex validators.
 *
 * The RE2 validators in ./validators.ts import `re2-wasm`, which drags Node's
 * `fs` into the webpack browser bundle and breaks `next build`. This module
 * mirrors the same rules using the browser's own JavaScript RegExp engine —
 * good enough for keystroke-by-keystroke UI feedback. The authoritative
 * RE2-based check still runs server-side inside addAliasAction via the zod
 * addAliasInputSchema refinement, so anything this approximate validator
 * accepts but RE2 rejects is caught at submit time.
 *
 * Divergence vs RE2:
 *   - JS RegExp accepts lookbehind / backreferences; RE2 does not. We do not
 *     try to flag those here — the server rejects them.
 *   - RE2 accepts `(?P<name>...)` (Python-style named groups); JS does not.
 *     A pattern using that syntax will fail our syntax check but succeed on
 *     the server. Acceptable since users rarely paste Python patterns into
 *     the add-alias form.
 */

export type ClientValidatorResult = { ok: true } | { ok: false; error: string };

const PERMISSIVE_PROBE = ['a', 'x', '1', ' '];

export function validateAliasRegexClient(pattern: string): ClientValidatorResult {
  if (!pattern || pattern.trim() === '') {
    return { ok: false, error: 'Alias regex cannot be empty' };
  }
  if (pattern.length < 3) {
    return { ok: false, error: 'Alias regex must be at least 3 characters' };
  }

  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'syntax error';
    return { ok: false, error: `Invalid regex syntax: ${message}` };
  }

  if (compiled.test('')) {
    return { ok: false, error: 'Alias regex matches empty string — too permissive' };
  }

  if (PERMISSIVE_PROBE.every((probe) => compiled.test(probe))) {
    return { ok: false, error: 'Alias regex is too permissive (matches arbitrary single characters)' };
  }

  return { ok: true };
}
