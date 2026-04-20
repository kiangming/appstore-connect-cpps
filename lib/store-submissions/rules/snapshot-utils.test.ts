import { describe, expect, it } from 'vitest';

import { countSnapshotRows } from './snapshot-utils';

describe('countSnapshotRows', () => {
  it('counts arrays from a zod-valid snapshot', () => {
    const snap = {
      schema_version: 1,
      senders: [
        {
          id: '00000000-0000-4000-a000-000000000001',
          email: 'x@y.com',
          is_primary: true,
          active: true,
        },
      ],
      subject_patterns: [
        {
          id: '00000000-0000-4000-a000-000000000002',
          outcome: 'APPROVED',
          regex: '(?<app_name>.+)',
          priority: 10,
          example_subject: null,
          active: true,
        },
        {
          id: '00000000-0000-4000-a000-000000000003',
          outcome: 'REJECTED',
          regex: 'foo',
          priority: 20,
          example_subject: null,
          active: true,
        },
      ],
      types: [],
      submission_id_patterns: [
        {
          id: '00000000-0000-4000-a000-000000000004',
          body_regex: '(?<submission_id>\\d+)',
          active: true,
        },
      ],
    };
    expect(countSnapshotRows(snap)).toEqual({
      senders: 1,
      subject_patterns: 2,
      types: 0,
      submission_id_patterns: 1,
    });
  });

  it('falls back to best-effort counts when schema fails', () => {
    // Missing schema_version → zod rejects; fallback counts array lengths.
    const snap = {
      senders: [{ shape: 'wrong' }, { shape: 'wrong' }],
      subject_patterns: [],
      types: [{ shape: 'wrong' }],
      submission_id_patterns: 'not-an-array',
    };
    expect(countSnapshotRows(snap)).toEqual({
      senders: 2,
      subject_patterns: 0,
      types: 1,
      submission_id_patterns: 0,
    });
  });

  it('returns all zeros for null/empty input', () => {
    expect(countSnapshotRows(null)).toEqual({
      senders: 0,
      subject_patterns: 0,
      types: 0,
      submission_id_patterns: 0,
    });
    expect(countSnapshotRows({})).toEqual({
      senders: 0,
      subject_patterns: 0,
      types: 0,
      submission_id_patterns: 0,
    });
  });
});
