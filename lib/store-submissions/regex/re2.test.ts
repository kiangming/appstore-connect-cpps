import { beforeEach, describe, expect, it } from 'vitest';

import {
  __re2CacheSizeForTests,
  __resetRe2CacheForTests,
  InvalidRegexError,
  re2Exec,
  re2Test,
  re2Validate,
  RE2_MAX_CACHE_SIZE,
  RegexTimeoutError,
} from './re2';

beforeEach(() => {
  __resetRe2CacheForTests();
});

describe('re2Validate', () => {
  it('accepts a plain literal', () => {
    expect(re2Validate('hello')).toEqual({ ok: true });
  });

  it('accepts a JS-style named group', () => {
    expect(re2Validate('Review of your (?<app_name>.+) submission')).toEqual({ ok: true });
  });

  it('accepts a Python-style named group', () => {
    expect(re2Validate('Review of your (?P<app_name>.+) submission')).toEqual({ ok: true });
  });

  it('accepts unicode character classes', () => {
    expect(re2Validate('\\p{L}+')).toEqual({ ok: true });
  });

  it('rejects unbalanced parens with an error message', () => {
    const result = re2Validate('(unclosed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it('rejects a backreference (RE2 does not support them)', () => {
    const result = re2Validate('(a)\\1');
    expect(result.ok).toBe(false);
  });

  it('rejects a lookbehind (RE2 does not support them)', () => {
    const result = re2Validate('(?<=foo)bar');
    expect(result.ok).toBe(false);
  });
});

describe('re2Test', () => {
  it('returns true when pattern matches', () => {
    expect(re2Test('hello', 'well, hello world')).toBe(true);
  });

  it('returns false when pattern does not match', () => {
    expect(re2Test('hello', 'goodbye world')).toBe(false);
  });

  it('matches unicode input in unicode mode', () => {
    expect(re2Test('\\p{L}+', 'Skyline')).toBe(true);
  });

  it('throws InvalidRegexError for a broken pattern', () => {
    expect(() => re2Test('(unbalanced', 'x')).toThrow(InvalidRegexError);
  });

  it('preserves pattern + reason on InvalidRegexError', () => {
    try {
      re2Test('(a)\\1', 'aa');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRegexError);
      const e = err as InvalidRegexError;
      expect(e.pattern).toBe('(a)\\1');
      expect(e.reason).toBeTruthy();
      expect(e.name).toBe('InvalidRegexError');
    }
  });
});

describe('re2Exec', () => {
  it('returns match with named groups', () => {
    const m = re2Exec('Review of your (?<app_name>.+) submission', 'Review of your Skyline Runners submission is complete.');
    expect(m).not.toBeNull();
    expect(m?.groups?.app_name).toBe('Skyline Runners');
  });

  it('returns null when no match', () => {
    expect(re2Exec('^hello$', 'goodbye')).toBeNull();
  });

  it('returns the match array with index-0 full match', () => {
    const m = re2Exec('foo(bar)', 'xxx foobar yyy');
    expect(m?.[0]).toBe('foobar');
    expect(m?.[1]).toBe('bar');
  });
});

describe('compile cache', () => {
  it('reuses a compiled pattern on subsequent calls', () => {
    __resetRe2CacheForTests();
    expect(__re2CacheSizeForTests()).toBe(0);

    re2Test('abc', 'abcdef');
    expect(__re2CacheSizeForTests()).toBe(1);

    re2Test('abc', 'xyzabc');
    expect(__re2CacheSizeForTests()).toBe(1);
  });

  it('does not cache invalid patterns', () => {
    __resetRe2CacheForTests();
    expect(() => re2Test('(bad', 'x')).toThrow(InvalidRegexError);
    expect(__re2CacheSizeForTests()).toBe(0);
  });

  it('evicts the cache when MAX_CACHE_SIZE is reached', () => {
    __resetRe2CacheForTests();
    for (let i = 0; i < RE2_MAX_CACHE_SIZE; i++) {
      re2Test(`p${i}`, 'x');
    }
    expect(__re2CacheSizeForTests()).toBe(RE2_MAX_CACHE_SIZE);

    re2Test('trigger-eviction', 'x');
    expect(__re2CacheSizeForTests()).toBe(1);
  });
});

describe('ReDoS resistance', () => {
  it('handles a pathological pattern + input in linear time', () => {
    const pattern = '(a+)+b';
    const input = 'a'.repeat(10_000) + 'X';
    const start = Date.now();
    const result = re2Test(pattern, input);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    // V8 would freeze for minutes on this input. RE2 finishes well under 200ms
    // even on slow CI runners; use a generous ceiling to avoid flakes.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('RegexTimeoutError', () => {
  it('carries the offending pattern', () => {
    const err = new RegexTimeoutError('(a+)+b');
    expect(err.pattern).toBe('(a+)+b');
    expect(err.name).toBe('RegexTimeoutError');
    expect(err.message).toContain('(a+)+b');
  });
});
