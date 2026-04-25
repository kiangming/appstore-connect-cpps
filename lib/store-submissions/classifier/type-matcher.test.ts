import { afterEach, describe, expect, it } from 'vitest';

import type { ExtractedPayload } from '../gmail/html-extractor';
import { __resetRe2CacheForTests } from '../regex/re2';

import { mapExtractorTypeToSlug, matchType } from './type-matcher';
import type { EmailInput, RulesSnapshot, Type } from './types';

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

/** Build an EmailInput from a body. PR-11 refactor: matcher takes the
 *  full email so it can read `extracted_payload` alongside body. */
const e = (body: string, over: Partial<EmailInput> = {}): EmailInput => ({
  sender: 'no-reply@apple.com',
  subject: '',
  body,
  ...over,
});

afterEach(__resetRe2CacheForTests);

describe('matchType — keyword matching (Priority 2 fallback)', () => {
  it('matches on case-sensitive body substring', () => {
    const r = matchType(e('Your App Version is 2.4.1'), rules([t({})]));
    expect(r?.type_id).toBe('type-app');
    expect(r?.type_slug).toBe('app');
  });

  it('returns null when keyword is absent', () => {
    expect(matchType(e('Unrelated body'), rules([t({})]))).toBeNull();
  });

  it('is case-sensitive (spec: body.includes default)', () => {
    expect(matchType(e('app version 2.4'), rules([t({})]))).toBeNull();
  });

  it('returns null on empty body', () => {
    expect(matchType(e(''), rules([t({})]))).toBeNull();
  });

  it('skips inactive types', () => {
    expect(
      matchType(e('App Version 2.4'), rules([t({ active: false })])),
    ).toBeNull();
  });

  it('iterates by sort_order ASC — first match wins, ignoring input order', () => {
    const types = [
      t({ id: 'late', sort_order: 100, body_keyword: 'Shared' }),
      t({ id: 'early', sort_order: 10, body_keyword: 'Shared' }),
    ];
    const r = matchType(e('Has Shared keyword'), rules(types));
    expect(r?.type_id).toBe('early');
  });
});

describe('matchType — payload extraction (Priority 2 regex)', () => {
  it('returns empty payload when no regex configured', () => {
    const r = matchType(e('App Version present'), rules([t({})]));
    expect(r?.payload).toEqual({});
  });

  it('extracts named groups from payload_extract_regex', () => {
    const regex = 'App Version\\s*\\n\\s*(?<version>[\\d.]+) for (?<os>\\w+)';
    const r = matchType(
      e('App Version\n2.4.1 for iOS'),
      rules([t({ payload_extract_regex: regex })]),
    );
    expect(r?.payload).toEqual({ version: '2.4.1', os: 'iOS' });
  });

  it('returns type with empty payload when regex is present but does not match', () => {
    // keyword hits but regex does not — spec: type still identified.
    const r = matchType(
      e('App Version without structured payload'),
      rules([t({ payload_extract_regex: 'WILL_NOT_MATCH (?<x>\\d+)' })]),
    );
    expect(r?.type_id).toBe('type-app');
    expect(r?.payload).toEqual({});
  });

  it('does not include undefined named groups in payload (optional groups)', () => {
    const regex = 'App Version (?<version>[\\d.]+)(?: for (?<os>\\w+))?';
    const r = matchType(
      e('App Version 2.4.1'),
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
    matchType(
      e(adversarialBody),
      rules([t({ payload_extract_regex: regex })]),
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

/* ============================================================================
 * PR-11: extracted_payload Priority 1
 * ========================================================================== */

const APPLE_TYPES: Type[] = [
  t({ id: 'tid-app', slug: 'app', name: 'App', body_keyword: 'App Version', sort_order: 10 }),
  t({ id: 'tid-iae', slug: 'iae', name: 'In-App Event', body_keyword: 'In-App Events', sort_order: 20 }),
  t({ id: 'tid-cpp', slug: 'cpp', name: 'Custom Product Page', body_keyword: 'Custom Product Pages', sort_order: 30 }),
  t({ id: 'tid-ppo', slug: 'ppo', name: 'Product Page Optimization', body_keyword: 'Product Page Optimization', sort_order: 40 }),
];

function payload(items: ExtractedPayload['accepted_items']): ExtractedPayload {
  return { accepted_items: items };
}

describe('matchType — Priority 1: extracted_payload (PR-11)', () => {
  it('APP_VERSION → matches app slug + populates payload from item fields', () => {
    const r = matchType(
      e('Submission ID only — body has no type signal', {
        extracted_payload: payload([
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: '1.0.13 for iOS',
            version: '1.0.13',
            platform: 'iOS',
          },
        ]),
      }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_id).toBe('tid-app');
    expect(r?.type_slug).toBe('app');
    expect(r?.payload).toEqual({ version: '1.0.13', platform: 'iOS' });
  });

  it('IN_APP_EVENTS → matches iae slug + count payload', () => {
    const r = matchType(
      e('', {
        extracted_payload: payload([
          {
            type: 'IN_APP_EVENTS',
            raw_heading: 'In-App Events (5)',
            raw_body: '',
            count: 5,
          },
        ]),
      }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_slug).toBe('iae');
    expect(r?.payload).toEqual({ count: '5' });
  });

  it('CUSTOM_PRODUCT_PAGE → matches cpp slug + name + uuid payload', () => {
    const r = matchType(
      e('', {
        extracted_payload: payload([
          {
            type: 'CUSTOM_PRODUCT_PAGE',
            raw_heading: 'Custom Product Pages',
            raw_body: 'CPP 2004\ne2232a07-7cdb-4418-bf62-77ad22da36dc',
            name: 'CPP 2004',
            uuid: 'e2232a07-7cdb-4418-bf62-77ad22da36dc',
          },
        ]),
      }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_slug).toBe('cpp');
    expect(r?.payload).toEqual({
      name: 'CPP 2004',
      uuid: 'e2232a07-7cdb-4418-bf62-77ad22da36dc',
    });
  });

  it('PRODUCT_PAGE_OPTIMIZATION → matches ppo slug + version_code payload', () => {
    const r = matchType(
      e('', {
        extracted_payload: payload([
          {
            type: 'PRODUCT_PAGE_OPTIMIZATION',
            raw_heading: 'Product Page Optimization',
            raw_body: '230426',
            version_code: '230426',
          },
        ]),
      }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_slug).toBe('ppo');
    expect(r?.payload).toEqual({ version_code: '230426' });
  });

  it('UNKNOWN type → falls through to body keyword path', () => {
    const r = matchType(
      e('App Version mentioned in body', {
        extracted_payload: payload([
          {
            type: 'UNKNOWN',
            raw_heading: 'Future Apple Type',
            raw_body: 'unknown stuff',
          },
        ]),
      }),
      rules(APPLE_TYPES),
    );
    // Priority 1 skipped (UNKNOWN), Priority 2 catches via body keyword.
    expect(r?.type_slug).toBe('app');
  });

  it('null extracted_payload → falls through to body keyword path', () => {
    const r = matchType(
      e('App Version 1.2.3', { extracted_payload: null }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_slug).toBe('app');
  });

  it('empty accepted_items → falls through to body keyword path', () => {
    const r = matchType(
      e('App Version 1.2.3', { extracted_payload: payload([]) }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_slug).toBe('app');
  });

  it('slug mapped but no active type seeded → falls through to body keyword', () => {
    // Rules contain only `app` — extractor reports PPO. Slug mismatch
    // → fallback to body keyword (which here also misses → null).
    const r = matchType(
      e('Unrelated body', {
        extracted_payload: payload([
          {
            type: 'PRODUCT_PAGE_OPTIMIZATION',
            raw_heading: 'Product Page Optimization',
            raw_body: '230426',
            version_code: '230426',
          },
        ]),
      }),
      rules([APPLE_TYPES[0]]), // only 'app' seeded
    );
    expect(r).toBeNull();
  });

  it('skips inactive types even when slug matches extractor', () => {
    const r = matchType(
      e('', {
        extracted_payload: payload([
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: '1.0.0 for iOS',
            version: '1.0.0',
            platform: 'iOS',
          },
        ]),
      }),
      rules([t({ slug: 'app', active: false })]),
    );
    expect(r).toBeNull();
  });

  it('Priority 1 wins over Priority 2 when both could match', () => {
    // Body has "Custom Product Pages" keyword (would match cpp via P2).
    // Extractor reports APP_VERSION (P1 → app). P1 must win.
    const r = matchType(
      e('Mention of Custom Product Pages here', {
        extracted_payload: payload([
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: '2.0.0 for iOS',
            version: '2.0.0',
            platform: 'iOS',
          },
        ]),
      }),
      rules(APPLE_TYPES),
    );
    expect(r?.type_slug).toBe('app');
    expect(r?.payload).toEqual({ version: '2.0.0', platform: 'iOS' });
  });
});

describe('mapExtractorTypeToSlug', () => {
  it('maps each known extractor type to its DB slug', () => {
    expect(mapExtractorTypeToSlug('APP_VERSION')).toBe('app');
    expect(mapExtractorTypeToSlug('IN_APP_EVENTS')).toBe('iae');
    expect(mapExtractorTypeToSlug('CUSTOM_PRODUCT_PAGE')).toBe('cpp');
    expect(mapExtractorTypeToSlug('PRODUCT_PAGE_OPTIMIZATION')).toBe('ppo');
  });

  it('returns null for UNKNOWN', () => {
    expect(mapExtractorTypeToSlug('UNKNOWN')).toBeNull();
  });
});
