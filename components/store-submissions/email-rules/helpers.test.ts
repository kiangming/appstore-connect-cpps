import { describe, expect, it } from 'vitest';

import type {
  PlatformRow,
  PlatformRules,
} from '@/lib/store-submissions/queries/rules';

import {
  PLATFORM_KEYS,
  addRow,
  buildDraftState,
  isDraftDirty,
  nextNumericField,
  removeRow,
  resolvePlatformKey,
  safeSlugFromName,
  setPrimarySender,
  sortByNumericField,
  updateRow,
} from './helpers';

const applyPlatform: PlatformRow = {
  id: '00000000-0000-0000-0000-000000000001',
  key: 'apple',
  display_name: 'Apple',
  active: true,
};
const googlePlatform: PlatformRow = {
  id: '00000000-0000-0000-0000-000000000002',
  key: 'google',
  display_name: 'Google Play',
  active: true,
};
const huaweiInactive: PlatformRow = {
  id: '00000000-0000-0000-0000-000000000003',
  key: 'huawei',
  display_name: 'Huawei',
  active: false,
};

function baseRules(): PlatformRules {
  return {
    platform: applyPlatform,
    senders: [
      {
        id: 's1',
        platform_id: applyPlatform.id,
        email: 'no-reply@apple.com',
        is_primary: true,
        active: true,
      },
    ],
    subject_patterns: [
      {
        id: 'p1',
        platform_id: applyPlatform.id,
        outcome: 'APPROVED',
        regex: 'Review of your (?<app_name>.+) submission is complete\\.',
        priority: 1,
        example_subject: null,
        active: true,
      },
    ],
    types: [
      {
        id: 't1',
        platform_id: applyPlatform.id,
        name: 'App',
        slug: 'app',
        body_keyword: 'App Version',
        payload_extract_regex: null,
        sort_order: 100,
        active: true,
      },
    ],
    submission_id_patterns: [
      {
        id: 'x1',
        platform_id: applyPlatform.id,
        body_regex: 'Submission ID: (?<submission_id>[A-Z0-9-]+)',
        active: true,
      },
    ],
    latest_version: 12,
  };
}

describe('PLATFORM_KEYS', () => {
  it('has the four hard-coded platform keys in a stable order', () => {
    expect([...PLATFORM_KEYS]).toEqual(['apple', 'google', 'huawei', 'facebook']);
  });
});

describe('buildDraftState', () => {
  it('drops platform_id and passes through editable fields', () => {
    const draft = buildDraftState(baseRules());
    expect(draft).toEqual({
      senders: [
        {
          id: 's1',
          email: 'no-reply@apple.com',
          is_primary: true,
          active: true,
        },
      ],
      subject_patterns: [
        {
          id: 'p1',
          outcome: 'APPROVED',
          regex: 'Review of your (?<app_name>.+) submission is complete\\.',
          priority: 1,
          example_subject: null,
          active: true,
        },
      ],
      types: [
        {
          id: 't1',
          name: 'App',
          slug: 'app',
          body_keyword: 'App Version',
          payload_extract_regex: null,
          sort_order: 100,
          active: true,
        },
      ],
      submission_id_patterns: [
        {
          id: 'x1',
          body_regex: 'Submission ID: (?<submission_id>[A-Z0-9-]+)',
          active: true,
        },
      ],
    });
  });

  it('produces an empty draft when no rules are defined', () => {
    const empty: PlatformRules = {
      platform: applyPlatform,
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      latest_version: null,
    };
    expect(buildDraftState(empty)).toEqual({
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
    });
  });
});

describe('isDraftDirty', () => {
  it('returns false when the draft is deeply equal to the original', () => {
    const a = buildDraftState(baseRules());
    const b = buildDraftState(baseRules());
    expect(isDraftDirty(a, b)).toBe(false);
  });

  it('detects edits to a leaf field (email change)', () => {
    const original = buildDraftState(baseRules());
    const modified = buildDraftState(baseRules());
    const firstSender = modified.senders[0];
    if (!firstSender) throw new Error('fixture regression: no sender');
    firstSender.email = 'someone-else@apple.com';
    expect(isDraftDirty(original, modified)).toBe(true);
  });

  it('detects newly added rows', () => {
    const original = buildDraftState(baseRules());
    const modified = buildDraftState(baseRules());
    modified.subject_patterns.push({
      outcome: 'REJECTED',
      regex: "There's an issue with your (?<app_name>.+)",
      priority: 2,
      example_subject: null,
      active: true,
    });
    expect(isDraftDirty(original, modified)).toBe(true);
  });

  it('detects removed rows', () => {
    const original = buildDraftState(baseRules());
    const modified = buildDraftState(baseRules());
    modified.senders = [];
    expect(isDraftDirty(original, modified)).toBe(true);
  });

  it('detects row reordering (priority edits surface here)', () => {
    const original = buildDraftState(baseRules());
    original.subject_patterns.push({
      id: 'p2',
      outcome: 'REJECTED',
      regex: 'x',
      priority: 2,
      example_subject: null,
      active: true,
    });
    const modified: typeof original = {
      ...original,
      subject_patterns: [...original.subject_patterns].reverse(),
    };
    expect(isDraftDirty(original, modified)).toBe(true);
  });
});

describe('updateRow', () => {
  it('shallow-merges the patch into the target index and returns a new array', () => {
    const rows = [
      { id: 'a', x: 1 },
      { id: 'b', x: 2 },
    ];
    const next = updateRow(rows, 1, { x: 99 });
    expect(next).toEqual([
      { id: 'a', x: 1 },
      { id: 'b', x: 99 },
    ]);
    expect(next).not.toBe(rows);
  });

  it('returns the same reference when the index is out of bounds', () => {
    const rows = [{ id: 'a' }];
    expect(updateRow(rows, -1, { id: 'z' })).toBe(rows);
    expect(updateRow(rows, 5, { id: 'z' })).toBe(rows);
  });
});

describe('addRow', () => {
  it('appends and returns a new array', () => {
    const rows = [{ id: 'a' }];
    const next = addRow(rows, { id: 'b' });
    expect(next).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(next).not.toBe(rows);
  });
});

describe('removeRow', () => {
  it('removes at the given index', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(removeRow(rows, 1)).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('returns the same reference when index is out of bounds', () => {
    const rows = [{ id: 'a' }];
    expect(removeRow(rows, -1)).toBe(rows);
    expect(removeRow(rows, 5)).toBe(rows);
  });
});

describe('setPrimarySender', () => {
  const base = [
    { email: 'a@x.com', is_primary: true },
    { email: 'b@x.com', is_primary: false },
    { email: 'c@x.com', is_primary: false },
  ];

  it('moves primary flag to another row, clearing the prior primary', () => {
    const next = setPrimarySender(base, 1, true);
    expect(next.map((s) => s.is_primary)).toEqual([false, true, false]);
  });

  it('unsets primary on the current row without promoting another', () => {
    const next = setPrimarySender(base, 0, false);
    expect(next.map((s) => s.is_primary)).toEqual([false, false, false]);
  });

  it('is a no-op when index is out of range', () => {
    expect(setPrimarySender(base, 7, true)).toBe(base);
  });

  it('promoting a row that is already primary keeps state stable', () => {
    const next = setPrimarySender(base, 0, true);
    expect(next.map((s) => s.is_primary)).toEqual([true, false, false]);
  });
});

describe('sortByNumericField', () => {
  it('sorts ascending', () => {
    const rows = [
      { id: 'a', priority: 3 },
      { id: 'b', priority: 1 },
      { id: 'c', priority: 2 },
    ];
    expect(sortByNumericField(rows, 'priority').map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('is stable for equal keys', () => {
    const rows = [
      { id: 'a', priority: 1 },
      { id: 'b', priority: 1 },
      { id: 'c', priority: 1 },
    ];
    expect(sortByNumericField(rows, 'priority').map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not mutate the input', () => {
    const rows = [{ id: 'a', priority: 2 }, { id: 'b', priority: 1 }];
    const out = sortByNumericField(rows, 'priority');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out).not.toBe(rows);
  });
});

describe('nextNumericField', () => {
  it('returns 1 for an empty list', () => {
    expect(nextNumericField<{ n: number }>([], 'n')).toBe(1);
  });

  it('returns max+1 for a populated list', () => {
    expect(
      nextNumericField([{ n: 3 }, { n: 7 }, { n: 5 }], 'n'),
    ).toBe(8);
  });

  it('skips non-finite values when computing the max', () => {
    expect(
      nextNumericField(
        [{ n: 2 }, { n: NaN }, { n: Number.POSITIVE_INFINITY }],
        'n',
      ),
    ).toBe(3);
  });

  it('returns 1 when all values are non-finite', () => {
    expect(nextNumericField([{ n: NaN }], 'n')).toBe(1);
  });
});

describe('safeSlugFromName', () => {
  it('derives a URL-safe slug from a typical name', () => {
    expect(safeSlugFromName('App Version')).toBe('app-version');
  });

  it('handles Vietnamese diacritics', () => {
    expect(safeSlugFromName('Đánh giá')).toBe('danh-gia');
  });

  it('returns "" for empty / whitespace input instead of throwing', () => {
    expect(safeSlugFromName('')).toBe('');
    expect(safeSlugFromName('   ')).toBe('');
  });

  it('returns "" when the name has no ASCII alphanumerics', () => {
    expect(safeSlugFromName('!!!')).toBe('');
  });
});

describe('resolvePlatformKey', () => {
  const all = [applyPlatform, googlePlatform, huaweiInactive];

  it('returns the requested key when it is a valid, active platform', () => {
    expect(resolvePlatformKey('google', all)).toBe('google');
  });

  it('falls back to the first active platform when the query value is missing', () => {
    expect(resolvePlatformKey(undefined, all)).toBe('apple');
  });

  it('ignores an unknown query value and falls back to apple', () => {
    expect(resolvePlatformKey('nintendo', all)).toBe('apple');
  });

  it('rejects an inactive platform and falls back to an active one', () => {
    expect(resolvePlatformKey('huawei', all)).toBe('apple');
  });

  it('picks the first element when the query value is an array', () => {
    expect(resolvePlatformKey(['google', 'apple'], all)).toBe('google');
  });

  it('returns null when no platform is active (seed missing)', () => {
    const allInactive: PlatformRow[] = [
      { ...applyPlatform, active: false },
      { ...googlePlatform, active: false },
    ];
    expect(resolvePlatformKey('apple', allInactive)).toBeNull();
  });
});
