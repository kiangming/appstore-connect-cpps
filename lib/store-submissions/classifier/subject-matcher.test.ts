import { afterEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from '../regex/re2';

import { matchSubject } from './subject-matcher';
import type { RulesSnapshot, SubjectPattern } from './types';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';

function rules(patterns: SubjectPattern[]): RulesSnapshot {
  return {
    platform_id: PLATFORM_ID,
    platform_key: 'apple',
    senders: [],
    subject_patterns: patterns,
    types: [],
    submission_id_patterns: [],
    apps_with_aliases: [],
  };
}

const make = (over: Partial<SubjectPattern>): SubjectPattern => ({
  id: 'p1',
  outcome: 'APPROVED',
  regex: 'Review of your (?<app_name>.+) submission is complete\\.',
  priority: 100,
  active: true,
  ...over,
});

afterEach(__resetRe2CacheForTests);

describe('matchSubject', () => {
  it('matches with JS-style named group', () => {
    const r = matchSubject('Review of your Skyline Runners submission is complete.', rules([
      make({ id: 'apple-approved' }),
    ]));
    expect(r?.outcome).toBe('APPROVED');
    expect(r?.extracted_app_name).toBe('Skyline Runners');
    expect(r?.pattern_id).toBe('apple-approved');
    expect(r?.matched_pattern).toContain('(?<app_name>');
  });

  it('returns null when nothing matches', () => {
    const r = matchSubject('Weekly digest', rules([make({})]));
    expect(r).toBeNull();
  });

  it('returns null on empty subject', () => {
    expect(matchSubject('', rules([make({})]))).toBeNull();
  });

  it('respects priority ASC — lower priority wins', () => {
    const lowPriority = make({
      id: 'specific',
      priority: 10,
      regex: 'Review of your (?<app_name>Dragon Guild) submission is complete\\.',
      outcome: 'REJECTED',
    });
    const highPriority = make({
      id: 'catchall',
      priority: 100,
      regex: 'Review of your (?<app_name>.+) submission is complete\\.',
      outcome: 'APPROVED',
    });

    // Order input deliberately reversed to prove sort is by priority, not input order.
    const r = matchSubject(
      'Review of your Dragon Guild submission is complete.',
      rules([highPriority, lowPriority]),
    );

    expect(r?.pattern_id).toBe('specific');
    expect(r?.outcome).toBe('REJECTED');
  });

  it('skips inactive patterns', () => {
    const r = matchSubject(
      'Review of your X submission is complete.',
      rules([make({ active: false })]),
    );
    expect(r).toBeNull();
  });

  it('returns app_name=null when named group is absent (defensive — validator should prevent this)', () => {
    const r = matchSubject(
      'Review of your X submission is complete.',
      rules([make({ regex: 'Review of your .+ submission is complete\\.' })]),
    );
    expect(r).not.toBeNull();
    expect(r?.extracted_app_name).toBeNull();
  });

  it('trims extracted app_name whitespace', () => {
    const r = matchSubject('Review of your    Padded App    submission is complete.', rules([make({})]));
    // The .+ is greedy so "Padded App    " captures incl. trailing spaces — trim enforces clean value
    expect(r?.extracted_app_name).toBe('Padded App');
  });

  it('is case-sensitive by default (authors opt in to i-mode via (?i))', () => {
    const caseSensitive = matchSubject(
      'REVIEW of your App submission is complete.',
      rules([make({})]),
    );
    expect(caseSensitive).toBeNull();

    const withIMode = matchSubject(
      'REVIEW of your App submission is complete.',
      rules([make({ regex: '(?i)Review of your (?<app_name>.+) submission is complete\\.' })]),
    );
    expect(withIMode?.extracted_app_name).toBe('App');
  });

  // ReDoS protection — RE2 guarantees linear time. If this test ever takes
  // >100ms we either lost the RE2 wrapper or swapped it for V8 regex.
  it('does not catastrophically backtrack on adversarial input (ReDoS guard)', () => {
    const adversarial = 'a'.repeat(10_000) + 'X';
    const pattern = make({ regex: '(?<app_name>(a+)+b)' });

    const start = performance.now();
    const r = matchSubject(adversarial, rules([pattern]));
    const elapsed = performance.now() - start;

    expect(r).toBeNull(); // pattern can't match — ends in X, no b
    expect(elapsed).toBeLessThan(100);
  });
});
