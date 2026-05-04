import { describe, expect, it } from 'vitest';

import { extractVersions } from './extract-versions';

describe('extractVersions', () => {
  it('returns [] for an empty payloads array', () => {
    expect(extractVersions([])).toEqual([]);
  });

  it('returns the single version string when one payload carries it', () => {
    expect(extractVersions([{ version: '2.4.0', os: 'iOS' }])).toEqual(['2.4.0']);
  });

  it('dedupes repeated versions while preserving first-seen order', () => {
    // A common shape — multiple email events for the same submission
    // build append the same version repeatedly. We want a clean chip
    // row, not "2.4.0 → 2.4.0 → 2.4.1".
    const payloads = [
      { version: '2.4.0' },
      { version: '2.4.0' },
      { version: '2.4.1' },
      { version: '2.4.0' }, // back-fill / out-of-order should not resurrect
      { version: '2.4.2' },
    ];
    expect(extractVersions(payloads)).toEqual(['2.4.0', '2.4.1', '2.4.2']);
  });

  it('ignores payloads where `version` is not a string', () => {
    const payloads = [
      { version: 240 }, // numeric — skip
      { version: null }, // null — skip
      { version: undefined }, // undefined — skip
      { version: '2.4.0' }, // valid
    ];
    expect(extractVersions(payloads)).toEqual(['2.4.0']);
  });

  it('ignores payloads missing the version field entirely', () => {
    // Non-Apple platforms typically don't capture <version>; the
    // payload may have `count`, `platform`, or be a plain string.
    const payloads = [
      { count: '5' },
      { platform: 'iOS' },
      'not-an-object',
      null,
      { version: '1.0.0' },
    ];
    expect(extractVersions(payloads)).toEqual(['1.0.0']);
  });

  it('skips empty-string versions to avoid blank chips', () => {
    expect(extractVersions([{ version: '' }, { version: '3.0.0' }])).toEqual([
      '3.0.0',
    ]);
  });
});
