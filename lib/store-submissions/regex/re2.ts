/**
 * RE2 wrapper for user-provided regex patterns.
 *
 * Store Management accepts regex from Manager users (subject patterns, payload
 * extractors, app aliases, submission_id patterns). V8's regex engine is
 * vulnerable to ReDoS via catastrophic backtracking — RE2 is linear-time by
 * construction and trades backreferences/lookbehind for safety.
 *
 * See docs/store-submissions/03-email-rule-engine.md §4.
 */

import { RE2 } from 're2-wasm';

export class InvalidRegexError extends Error {
  constructor(
    public readonly pattern: string,
    public readonly reason: string,
  ) {
    super(`Invalid regex "${pattern}": ${reason}`);
    this.name = 'InvalidRegexError';
  }
}

export class RegexTimeoutError extends Error {
  constructor(public readonly pattern: string) {
    super(`Regex execution timeout: ${pattern}`);
    this.name = 'RegexTimeoutError';
  }
}

const COMPILED_CACHE = new Map<string, RE2>();
const MAX_CACHE_SIZE = 500;

function getCompiled(pattern: string): RE2 {
  const cached = COMPILED_CACHE.get(pattern);
  if (cached) return cached;

  let re: RE2;
  try {
    re = new RE2(pattern, 'u');
  } catch (err) {
    throw new InvalidRegexError(pattern, (err as Error).message);
  }

  if (COMPILED_CACHE.size >= MAX_CACHE_SIZE) {
    COMPILED_CACHE.clear();
  }
  COMPILED_CACHE.set(pattern, re);
  return re;
}

export function re2Exec(pattern: string, input: string): RegExpMatchArray | null {
  const re = getCompiled(pattern);
  return re.match(input) as RegExpMatchArray | null;
}

export function re2Test(pattern: string, input: string): boolean {
  return getCompiled(pattern).test(input);
}

export type RegexValidation = { ok: true } | { ok: false; error: string };

export function re2Validate(pattern: string): RegexValidation {
  try {
    new RE2(pattern, 'u');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Test-only: reset the compile cache between isolated tests. */
export function __resetRe2CacheForTests(): void {
  COMPILED_CACHE.clear();
}

/** Test-only: current cache size for assertions. */
export function __re2CacheSizeForTests(): number {
  return COMPILED_CACHE.size;
}

export { MAX_CACHE_SIZE as RE2_MAX_CACHE_SIZE };
