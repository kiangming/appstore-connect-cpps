import { describe, expect, it } from 'vitest';

import { extractVersions } from './extract-versions';

/**
 * Fixtures use the production wrapper shape `{ payload, first_seen_at }`
 * — the structure the ticket-engine RPC inserts. Pre-PR-17.2.5
 * fixtures used a flat `{ version }` shape that the helper happened to
 * match, but production never had that shape; classic
 * passing-by-coincidence anti-pattern. Fixtures below mirror the RPC
 * INSERT statement exactly so the helper's contract is checked against
 * production reality.
 */

describe('extractVersions', () => {
  it('returns [] for an empty payloads array', () => {
    expect(extractVersions([])).toEqual([]);
  });

  it('returns the single version string when one wrapped payload carries it', () => {
    expect(
      extractVersions([
        {
          payload: { version: '2.4.0', platform: 'iOS' },
          first_seen_at: '2026-05-01T10:22:00Z',
        },
      ]),
    ).toEqual(['2.4.0']);
  });

  it('dedupes repeated versions while preserving first-seen order', () => {
    // A common shape — multiple email events for the same submission
    // build append the same version repeatedly. We want a clean chip
    // row, not "2.4.0 → 2.4.0 → 2.4.1".
    const payloads = [
      { payload: { version: '2.4.0' }, first_seen_at: '2026-05-01T10:00:00Z' },
      { payload: { version: '2.4.1' }, first_seen_at: '2026-05-01T11:00:00Z' },
      { payload: { version: '2.4.0' }, first_seen_at: '2026-05-01T12:00:00Z' }, // dup
      { payload: { version: '2.4.2' }, first_seen_at: '2026-05-01T13:00:00Z' },
      { payload: { version: '2.4.1' }, first_seen_at: '2026-05-01T14:00:00Z' }, // dup
    ];
    expect(extractVersions(payloads)).toEqual(['2.4.0', '2.4.1', '2.4.2']);
  });

  it('ignores entries where payload.version is not a string', () => {
    const payloads = [
      { payload: { version: 240 }, first_seen_at: '...' }, // numeric
      { payload: { version: null }, first_seen_at: '...' },
      { payload: { version: undefined }, first_seen_at: '...' },
      { payload: { version: '2.4.0' }, first_seen_at: '...' }, // valid
    ];
    expect(extractVersions(payloads)).toEqual(['2.4.0']);
  });

  it('ignores entries whose payload object lacks a version field', () => {
    // Non-Apple platforms typically don't capture <version>; the
    // payload may carry only `count`, `platform`, etc.
    const payloads = [
      { payload: { count: '5' }, first_seen_at: '...' },
      { payload: { platform: 'iOS' }, first_seen_at: '...' },
      { payload: { version: '1.0.0' }, first_seen_at: '...' },
    ];
    expect(extractVersions(payloads)).toEqual(['1.0.0']);
  });

  it('skips empty-string versions to avoid blank chips', () => {
    expect(
      extractVersions([
        { payload: { version: '' }, first_seen_at: '...' },
        { payload: { version: '3.0.0' }, first_seen_at: '...' },
      ]),
    ).toEqual(['3.0.0']);
  });

  // -- Defensive nested-edge coverage (PR-17.2.5) ---------------------------

  it('ignores entries missing the `payload` field entirely', () => {
    // Shouldn't happen in production (RPC always wraps), but guard
    // against future writers or migration backfills that skip the
    // wrapper.
    expect(
      extractVersions([
        { first_seen_at: '2026-05-01T10:22:00Z' },
        { payload: { version: '2.4.0' }, first_seen_at: '...' },
      ]),
    ).toEqual(['2.4.0']);
  });

  it('ignores entries where `payload` is not an object', () => {
    expect(
      extractVersions([
        { payload: 'iOS', first_seen_at: '...' },
        { payload: 42, first_seen_at: '...' },
        { payload: null, first_seen_at: '...' },
        { payload: { version: '5.0.0' }, first_seen_at: '...' }, // valid
      ]),
    ).toEqual(['5.0.0']);
  });

  it('ignores top-level non-object items (null, primitive)', () => {
    expect(
      extractVersions([
        null,
        'a string',
        42,
        undefined,
        { payload: { version: '1.2.3' }, first_seen_at: '...' }, // valid
      ]),
    ).toEqual(['1.2.3']);
  });
});
