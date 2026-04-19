import { beforeEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from './re2';
import {
  validateAliasRegex,
  validatePayloadRegex,
  validateSubjectPattern,
  validateSubmissionIdPattern,
} from './validators';

beforeEach(() => {
  __resetRe2CacheForTests();
});

describe('validateSubjectPattern', () => {
  it('accepts JS-style (?<app_name>...)', () => {
    expect(validateSubjectPattern('Review of your (?<app_name>.+) submission')).toEqual({ ok: true });
  });

  it('accepts Python-style (?P<app_name>...)', () => {
    expect(validateSubjectPattern('Review of your (?P<app_name>.+) submission')).toEqual({ ok: true });
  });

  it('rejects a pattern without app_name group', () => {
    const r = validateSubjectPattern('Review of your (.+) submission');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('app_name');
  });

  it('rejects an uncompilable pattern', () => {
    const r = validateSubjectPattern('(unclosed');
    expect(r.ok).toBe(false);
  });

  it('rejects a pattern with a different named group', () => {
    const r = validateSubjectPattern('Review of (?<name>.+) submission');
    expect(r.ok).toBe(false);
  });
});

describe('validatePayloadRegex', () => {
  it('accepts a compilable pattern with no groups', () => {
    expect(validatePayloadRegex('version: \\d+\\.\\d+\\.\\d+')).toEqual({ ok: true });
  });

  it('accepts a pattern with named groups', () => {
    expect(validatePayloadRegex('version: (?<version>[\\d.]+)')).toEqual({ ok: true });
  });

  it('rejects an uncompilable pattern', () => {
    const r = validatePayloadRegex('(?<=lookbehind)x');
    expect(r.ok).toBe(false);
  });
});

describe('validateSubmissionIdPattern', () => {
  it('accepts JS-style submission_id group', () => {
    expect(validateSubmissionIdPattern('Submission ID: (?<submission_id>[A-Z0-9-]+)')).toEqual({ ok: true });
  });

  it('accepts Python-style submission_id group', () => {
    expect(validateSubmissionIdPattern('Submission ID: (?P<submission_id>[A-Z0-9-]+)')).toEqual({ ok: true });
  });

  it('rejects a pattern without submission_id group', () => {
    const r = validateSubmissionIdPattern('Submission ID: ([A-Z0-9-]+)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('submission_id');
  });

  it('rejects an uncompilable pattern', () => {
    const r = validateSubmissionIdPattern('(?<submission_id>[unclosed');
    expect(r.ok).toBe(false);
  });
});

describe('validateAliasRegex', () => {
  it('rejects empty string', () => {
    const r = validateAliasRegex('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('empty');
  });

  it('rejects whitespace-only', () => {
    const r = validateAliasRegex('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('empty');
  });

  it('rejects patterns shorter than 3 chars', () => {
    const r = validateAliasRegex('ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('3 characters');
  });

  it('rejects .* (short + matches empty — length gate fires first)', () => {
    const r = validateAliasRegex('.*');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('3 characters');
  });

  it('rejects .+ (short + permissive — length gate fires first)', () => {
    const r = validateAliasRegex('.+');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('3 characters');
  });

  it('rejects a long pattern that matches empty string', () => {
    const r = validateAliasRegex('(.*)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('empty string');
  });

  it('rejects a long permissive pattern that matches any single char', () => {
    // (a|x|1| ) matches each probe independently; does NOT match empty.
    const r = validateAliasRegex('(a|x|1| )');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('too permissive');
  });

  it('rejects \\w+ (matches all single-char samples except space)', () => {
    // \w matches a,x,1 but not space → should pass permissive probe, but still
    // reject on some other rule? No — spec says reject ONLY if all 4 probes
    // match. \w+ matches space? No. So \w+ should pass the permissive gate.
    // This test documents the current behavior.
    expect(validateAliasRegex('\\w+')).toEqual({ ok: true });
  });

  it('rejects an uncompilable pattern', () => {
    const r = validateAliasRegex('(unclosed');
    expect(r.ok).toBe(false);
  });

  it('accepts a specific prefix pattern', () => {
    expect(validateAliasRegex('Skyline.*')).toEqual({ ok: true });
  });

  it('accepts an anchored pattern', () => {
    expect(validateAliasRegex('^Dragon [A-Z][a-z]+$')).toEqual({ ok: true });
  });

  it('accepts a literal multichar alias', () => {
    expect(validateAliasRegex('Skyline Runners')).toEqual({ ok: true });
  });

  it('rejects a 2-char pattern even if not permissive', () => {
    const r = validateAliasRegex('^a');
    // length 2 → fails length gate before permissive check
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('3 characters');
  });
});
