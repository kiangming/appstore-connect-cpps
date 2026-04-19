import { afterEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from '../regex/re2';

import { extractSubmissionId } from './submission-id-extractor';
import type { RulesSnapshot, SubmissionIdPattern } from './types';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';

function rules(patterns: SubmissionIdPattern[]): RulesSnapshot {
  return {
    platform_id: PLATFORM_ID,
    platform_key: 'apple',
    senders: [],
    subject_patterns: [],
    types: [],
    submission_id_patterns: patterns,
    apps_with_aliases: [],
  };
}

const pat = (over: Partial<SubmissionIdPattern> = {}): SubmissionIdPattern => ({
  id: 'sid-1',
  body_regex: 'Submission ID: (?<submission_id>[a-f0-9-]{36})',
  active: true,
  ...over,
});

afterEach(__resetRe2CacheForTests);

describe('extractSubmissionId', () => {
  it('extracts first matching submission_id', () => {
    const r = extractSubmissionId(
      'Submission ID: 11111111-2222-3333-4444-555555555555',
      rules([pat()]),
    );
    expect(r).toEqual({
      pattern_id: 'sid-1',
      submission_id: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('returns null when no pattern matches (non-blocking)', () => {
    expect(extractSubmissionId('no submission info', rules([pat()]))).toBeNull();
  });

  it('returns null on empty body', () => {
    expect(extractSubmissionId('', rules([pat()]))).toBeNull();
  });

  it('returns null when no patterns configured', () => {
    expect(extractSubmissionId('Submission ID: foo', rules([]))).toBeNull();
  });

  it('skips inactive patterns', () => {
    const r = extractSubmissionId(
      'Submission ID: 11111111-2222-3333-4444-555555555555',
      rules([pat({ active: false })]),
    );
    expect(r).toBeNull();
  });

  it('returns first match across multiple patterns (DB order, not priority)', () => {
    const a = pat({ id: 'first', body_regex: 'Ref: (?<submission_id>\\w+)' });
    const b = pat({ id: 'second', body_regex: 'SID: (?<submission_id>\\w+)' });
    const r = extractSubmissionId('SID: xyz\nRef: abc', rules([a, b]));
    // First pattern matches "abc" first regardless of DB-order of hits in body
    expect(r?.pattern_id).toBe('first');
    expect(r?.submission_id).toBe('abc');
  });

  it('trims captured submission_id', () => {
    const r = extractSubmissionId('Ref:  padded-id  \n', rules([
      pat({ body_regex: 'Ref:\\s+(?<submission_id>[\\w-]+)' }),
    ]));
    expect(r?.submission_id).toBe('padded-id');
  });

  it('ignores a match where captured group is empty', () => {
    // Regex allows zero-width capture — classifier should treat as no-match.
    const r = extractSubmissionId('Ref: ', rules([
      pat({ body_regex: 'Ref: (?<submission_id>.*)' }),
    ]));
    expect(r).toBeNull();
  });

  it('does not catastrophically backtrack on adversarial body (ReDoS guard)', () => {
    const body = 'a'.repeat(10_000) + 'X';
    const start = performance.now();
    extractSubmissionId(body, rules([pat({ body_regex: '(?<submission_id>(a+)+b)' })]));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
