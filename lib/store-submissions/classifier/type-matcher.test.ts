import { afterEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from '../regex/re2';

import { matchType } from './type-matcher';
import type { RulesSnapshot, Type } from './types';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';

function rules(types: Type[]): RulesSnapshot {
  return {
    platform_id: PLATFORM_ID,
    platform_key: 'apple',
    senders: [],
    subject_patterns: [],
    types,
    submission_id_patterns: [],
    apps_with_aliases: [],
  };
}

const t = (over: Partial<Type>): Type => ({
  id: 'type-app',
  name: 'App',
  slug: 'app',
  body_keyword: 'App Version',
  payload_extract_regex: null,
  sort_order: 100,
  active: true,
  ...over,
});

afterEach(__resetRe2CacheForTests);

describe('matchType — keyword matching', () => {
  it('matches on case-sensitive body substring', () => {
    const r = matchType('Your App Version is 2.4.1', rules([t({})]));
    expect(r?.type_id).toBe('type-app');
    expect(r?.type_slug).toBe('app');
  });

  it('returns null when keyword is absent', () => {
    expect(matchType('Unrelated body', rules([t({})]))).toBeNull();
  });

  it('is case-sensitive (spec: body.includes default)', () => {
    expect(matchType('app version 2.4', rules([t({})]))).toBeNull();
  });

  it('returns null on empty body', () => {
    expect(matchType('', rules([t({})]))).toBeNull();
  });

  it('skips inactive types', () => {
    expect(matchType('App Version 2.4', rules([t({ active: false })]))).toBeNull();
  });

  it('iterates by sort_order ASC — first match wins, ignoring input order', () => {
    const types = [
      t({ id: 'late', sort_order: 100, body_keyword: 'Shared' }),
      t({ id: 'early', sort_order: 10, body_keyword: 'Shared' }),
    ];
    const r = matchType('Has Shared keyword', rules(types));
    expect(r?.type_id).toBe('early');
  });
});

describe('matchType — payload extraction', () => {
  it('returns empty payload when no regex configured', () => {
    const r = matchType('App Version present', rules([t({})]));
    expect(r?.payload).toEqual({});
  });

  it('extracts named groups from payload_extract_regex', () => {
    const regex = 'App Version\\s*\\n\\s*(?<version>[\\d.]+) for (?<os>\\w+)';
    const r = matchType(
      'App Version\n2.4.1 for iOS',
      rules([t({ payload_extract_regex: regex })]),
    );
    expect(r?.payload).toEqual({ version: '2.4.1', os: 'iOS' });
  });

  it('returns type with empty payload when regex is present but does not match', () => {
    // keyword hits but regex does not — spec: type still identified.
    const r = matchType(
      'App Version without structured payload',
      rules([t({ payload_extract_regex: 'WILL_NOT_MATCH (?<x>\\d+)' })]),
    );
    expect(r?.type_id).toBe('type-app');
    expect(r?.payload).toEqual({});
  });

  it('does not include undefined named groups in payload (optional groups)', () => {
    const regex = 'App Version (?<version>[\\d.]+)(?: for (?<os>\\w+))?';
    const r = matchType(
      'App Version 2.4.1',
      rules([t({ payload_extract_regex: regex })]),
    );
    expect(r?.payload).toEqual({ version: '2.4.1' });
    expect('os' in (r?.payload ?? {})).toBe(false);
  });
});

describe('matchType — ReDoS guard', () => {
  it('handles adversarial body within 100ms', () => {
    const adversarialBody = 'App Version ' + 'a'.repeat(10_000) + 'X';
    const regex = '(?<x>(a+)+b)';
    const start = performance.now();
    matchType(adversarialBody, rules([t({ payload_extract_regex: regex })]));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
