import { describe, expect, it } from 'vitest';

import {
  validateAliasRegexClient,
  validatePayloadRegexClient,
  validateSubjectPatternClient,
  validateSubmissionIdPatternClient,
} from './client-validators';

describe('validateAliasRegexClient', () => {
  it('accepts a well-formed non-permissive regex', () => {
    expect(validateAliasRegexClient('Skyline.+')).toEqual({ ok: true });
  });

  it('rejects empty / whitespace-only input', () => {
    expect(validateAliasRegexClient('').ok).toBe(false);
    expect(validateAliasRegexClient('   ').ok).toBe(false);
  });

  it('rejects input shorter than 3 characters', () => {
    const r = validateAliasRegexClient('ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least 3/i);
  });

  it('rejects uncompilable patterns', () => {
    const r = validateAliasRegexClient('(unclosed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/syntax/i);
  });

  it('rejects a pattern that matches the empty string', () => {
    const r = validateAliasRegexClient('(.*)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it('rejects an over-permissive pattern that matches every probe', () => {
    const r = validateAliasRegexClient('(.+)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/permissive/i);
  });
});

describe('validateSubjectPatternClient', () => {
  it('accepts JS-style (?<app_name>...)', () => {
    expect(
      validateSubjectPatternClient('Review of your (?<app_name>.+) submission is complete'),
    ).toEqual({ ok: true });
  });

  it('accepts Python-style (?P<app_name>...) by rewriting to JS syntax for compile', () => {
    expect(
      validateSubjectPatternClient('Review of your (?P<app_name>.+) submission is complete'),
    ).toEqual({ ok: true });
  });

  it('rejects empty input', () => {
    expect(validateSubjectPatternClient('').ok).toBe(false);
    expect(validateSubjectPatternClient('  ').ok).toBe(false);
  });

  it('rejects patterns missing (?<app_name>...)', () => {
    const r = validateSubjectPatternClient('Review of your (.+) submission');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/app_name/);
  });

  it('rejects patterns with a different named group', () => {
    const r = validateSubjectPatternClient('Review of your (?<other>.+) submission');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/app_name/);
  });

  it('rejects uncompilable patterns', () => {
    const r = validateSubjectPatternClient('(?<app_name>.+');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/syntax/i);
  });
});

describe('validatePayloadRegexClient', () => {
  it('accepts a compilable pattern with no required groups', () => {
    expect(
      validatePayloadRegexClient('App Version\\n([\\d.]+) for (\\w+)'),
    ).toEqual({ ok: true });
  });

  it('accepts patterns with named groups (Python syntax accepted via rewrite)', () => {
    expect(
      validatePayloadRegexClient('App Version\\n(?P<version>[\\d.]+)'),
    ).toEqual({ ok: true });
  });

  it('rejects empty input', () => {
    const r = validatePayloadRegexClient('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it('rejects uncompilable patterns', () => {
    const r = validatePayloadRegexClient('(unclosed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/syntax/i);
  });
});

describe('validateSubmissionIdPatternClient', () => {
  it('accepts a pattern with (?<submission_id>...)', () => {
    expect(
      validateSubmissionIdPatternClient('Submission ID: (?<submission_id>[A-Z0-9-]+)'),
    ).toEqual({ ok: true });
  });

  it('accepts Python-style (?P<submission_id>...)', () => {
    expect(
      validateSubmissionIdPatternClient('Submission ID: (?P<submission_id>[A-Z0-9-]+)'),
    ).toEqual({ ok: true });
  });

  it('rejects empty input', () => {
    expect(validateSubmissionIdPatternClient('').ok).toBe(false);
  });

  it('rejects patterns missing the submission_id group', () => {
    const r = validateSubmissionIdPatternClient('Submission ID: ([A-Z0-9-]+)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/submission_id/);
  });

  it('rejects uncompilable patterns', () => {
    const r = validateSubmissionIdPatternClient('(?<submission_id>[A-Z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/syntax/i);
  });
});
