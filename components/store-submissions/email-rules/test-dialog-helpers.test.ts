import { describe, expect, it } from 'vitest';

import type { DraftState } from './helpers';
import {
  MAX_TEST_BODY_BYTES,
  OUTCOME_DISPLAY,
  buildTestPayload,
  formatCapturedGroups,
  summarizeTraceDetails,
  utf8ByteLength,
} from './test-dialog-helpers';

const PLATFORM_ID = '00000000-0000-0000-0000-000000000001';

function emptyDraft(): DraftState {
  return {
    senders: [],
    subject_patterns: [],
    types: [],
    submission_id_patterns: [],
  };
}

const emailInput = {
  sender: 'no-reply@apple.com',
  subject: 'Review of your Puzzle Quest Saga submission is complete.',
  body: 'Your app has been approved...',
};

describe('buildTestPayload', () => {
  it('threads sender/subject/body/platform_id through verbatim', () => {
    const req = buildTestPayload(emptyDraft(), PLATFORM_ID, emailInput);
    expect(req).toMatchObject({
      sender: emailInput.sender,
      subject: emailInput.subject,
      body: emailInput.body,
      platform_id: PLATFORM_ID,
    });
  });

  it('drops senders with empty email and strips id', () => {
    const draft: DraftState = {
      ...emptyDraft(),
      senders: [
        { id: 's1', email: 'no-reply@apple.com', is_primary: true, active: true },
        { id: 's2', email: '   ', is_primary: false, active: true },
        { email: 'x@y.com', is_primary: false, active: true },
      ],
    };
    const req = buildTestPayload(draft, PLATFORM_ID, emailInput);
    expect(req.override_rules.senders).toEqual([
      { email: 'no-reply@apple.com', is_primary: true, active: true },
      { email: 'x@y.com', is_primary: false, active: true },
    ]);
    // id must not appear in the payload
    for (const s of req.override_rules.senders) {
      expect('id' in s).toBe(false);
    }
  });

  it('drops subject patterns with empty regex', () => {
    const draft: DraftState = {
      ...emptyDraft(),
      subject_patterns: [
        {
          outcome: 'APPROVED',
          regex: 'Review of your (?<app_name>.+)',
          priority: 1,
          example_subject: null,
          active: true,
        },
        {
          outcome: 'REJECTED',
          regex: '',
          priority: 2,
          example_subject: null,
          active: true,
        },
      ],
    };
    const req = buildTestPayload(draft, PLATFORM_ID, emailInput);
    expect(req.override_rules.subject_patterns).toHaveLength(1);
    expect(req.override_rules.subject_patterns[0]?.outcome).toBe('APPROVED');
  });

  it('drops types missing name/slug/body_keyword and coerces empty regex to null', () => {
    const draft: DraftState = {
      ...emptyDraft(),
      types: [
        {
          name: 'App',
          slug: 'app',
          body_keyword: 'App Version',
          payload_extract_regex: '',
          sort_order: 10,
          active: true,
        },
        {
          name: '',
          slug: 'incomplete',
          body_keyword: 'x',
          payload_extract_regex: null,
          sort_order: 20,
          active: true,
        },
        {
          name: 'Event',
          slug: 'iae',
          body_keyword: 'In-App Events',
          payload_extract_regex: '(?<event_id>\\d+)',
          sort_order: 30,
          active: true,
        },
      ],
    };
    const req = buildTestPayload(draft, PLATFORM_ID, emailInput);
    expect(req.override_rules.types).toHaveLength(2);
    expect(req.override_rules.types[0]).toEqual({
      name: 'App',
      slug: 'app',
      body_keyword: 'App Version',
      payload_extract_regex: null, // "" coerced to null
      sort_order: 10,
      active: true,
    });
    expect(req.override_rules.types[1]?.payload_extract_regex).toBe(
      '(?<event_id>\\d+)',
    );
  });

  it('drops submission_id patterns with empty body_regex', () => {
    const draft: DraftState = {
      ...emptyDraft(),
      submission_id_patterns: [
        {
          body_regex: 'Submission ID: (?<submission_id>\\d+)',
          active: true,
        },
        { body_regex: '  ', active: true },
      ],
    };
    const req = buildTestPayload(draft, PLATFORM_ID, emailInput);
    expect(req.override_rules.submission_id_patterns).toEqual([
      {
        body_regex: 'Submission ID: (?<submission_id>\\d+)',
        active: true,
      },
    ]);
  });

  it('still produces a well-formed payload when the draft is entirely empty', () => {
    const req = buildTestPayload(emptyDraft(), PLATFORM_ID, emailInput);
    expect(req.override_rules).toEqual({
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
    });
  });
});

describe('OUTCOME_DISPLAY', () => {
  it('covers all 5 classifier statuses with non-empty labels + descriptions', () => {
    for (const k of [
      'DROPPED',
      'UNCLASSIFIED_APP',
      'UNCLASSIFIED_TYPE',
      'CLASSIFIED',
      'ERROR',
    ] as const) {
      expect(OUTCOME_DISPLAY[k].label).toMatch(/\S/);
      expect(OUTCOME_DISPLAY[k].description).toMatch(/\S/);
      expect(OUTCOME_DISPLAY[k].cls).toMatch(/bg-/);
    }
  });
});

describe('formatCapturedGroups', () => {
  it('returns em-dash for null / empty', () => {
    expect(formatCapturedGroups(null)).toBe('—');
    expect(formatCapturedGroups(undefined)).toBe('—');
    expect(formatCapturedGroups({})).toBe('—');
  });

  it('formats key-value pairs in insertion order', () => {
    expect(
      formatCapturedGroups({ version: '2.4.1', os: 'iOS' }),
    ).toBe('version=2.4.1, os=iOS');
  });
});

describe('summarizeTraceDetails', () => {
  it('returns empty string when details is missing', () => {
    expect(summarizeTraceDetails('sender', undefined)).toBe('');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['sender', { matched_sender: 'no-reply@apple.com' }, 'matched: no-reply@apple.com'],
    [
      'subject',
      { outcome: 'APPROVED', matched_pattern: 'Review of your (?<app_name>.+)' },
      'APPROVED · Review of your (?<app_name>.+)',
    ],
    ['app', { app_name: 'Puzzle Quest Saga' }, 'app: Puzzle Quest Saga'],
    ['type', { type: 'App' }, 'type: App'],
    ['submission_id', { submission_id: 'SUB-123' }, 'submission_id: SUB-123'],
  ])('summarizes %s step', (step, details, expected) => {
    expect(summarizeTraceDetails(step, details)).toBe(expected);
  });

  it('ignores unknown steps', () => {
    expect(summarizeTraceDetails('mystery', { foo: 'bar' })).toBe('');
  });
});

describe('utf8ByteLength', () => {
  it('returns 0 for empty string', () => {
    expect(utf8ByteLength('')).toBe(0);
  });

  it('counts 3 bytes per Vietnamese diacritic character', () => {
    expect(utf8ByteLength('đ')).toBe(2);
    expect(utf8ByteLength('á')).toBe(2);
  });

  it('MAX_TEST_BODY_BYTES is 100k so the UI cap stays in sync with the classifier slice', () => {
    expect(MAX_TEST_BODY_BYTES).toBe(100_000);
  });
});
