import { describe, expect, it } from 'vitest';

import {
  configSnapshotSchema,
  rollbackRulesInputSchema,
  saveRulesInputSchema,
  senderInputSchema,
  subjectPatternInputSchema,
  submissionIdPatternInputSchema,
  typeInputSchema,
  typeSlugSchema,
} from './rules';

const PLATFORM_ID = '00000000-0000-4000-a000-000000000001';

describe('senderInputSchema', () => {
  it('lowercases and trims email', () => {
    const r = senderInputSchema.parse({ email: '  NO-REPLY@Apple.COM  ' });
    expect(r.email).toBe('no-reply@apple.com');
  });

  it('rejects invalid email', () => {
    expect(senderInputSchema.safeParse({ email: 'not an email' }).success).toBe(false);
  });

  it('defaults active=true and is_primary=false', () => {
    const r = senderInputSchema.parse({ email: 'x@y.com' });
    expect(r.active).toBe(true);
    expect(r.is_primary).toBe(false);
  });
});

describe('subjectPatternInputSchema', () => {
  const base = {
    outcome: 'APPROVED' as const,
    regex: 'Review of your (?<app_name>.+) submission is complete\\.',
    priority: 10,
  };

  it('accepts a JS-style named group', () => {
    expect(subjectPatternInputSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a Python-style named group', () => {
    expect(
      subjectPatternInputSchema.safeParse({
        ...base,
        regex: 'Review of your (?P<app_name>.+) submission is complete\\.',
      }).success,
    ).toBe(true);
  });

  it('rejects when app_name named group is missing', () => {
    const r = subjectPatternInputSchema.safeParse({
      ...base,
      regex: 'Review of your (.+) submission is complete\\.',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/app_name/);
      expect(r.error.issues[0]?.path).toEqual(['regex']);
    }
  });

  it('rejects RE2-incompatible pattern (lookbehind)', () => {
    const r = subjectPatternInputSchema.safeParse({
      ...base,
      regex: '(?<=foo)(?<app_name>.+)',
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid outcome', () => {
    const r = subjectPatternInputSchema.safeParse({ ...base, outcome: 'PENDING' as unknown });
    expect(r.success).toBe(false);
  });
});

describe('typeInputSchema', () => {
  const base = {
    name: 'App',
    slug: 'app',
    body_keyword: 'App Version',
    sort_order: 10,
  };

  it('accepts a type with no payload regex', () => {
    expect(typeInputSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a type with a valid payload regex (named groups optional)', () => {
    const r = typeInputSchema.safeParse({
      ...base,
      payload_extract_regex: 'App Version\\s*\\n\\s*(?<version>[\\d.]+) for (?<os>\\w+)',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a payload regex with no named groups', () => {
    const r = typeInputSchema.safeParse({
      ...base,
      payload_extract_regex: 'App Version \\d+',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a payload regex that does not compile under RE2', () => {
    const r = typeInputSchema.safeParse({
      ...base,
      payload_extract_regex: '(?<=x)foo', // lookbehind — RE2 rejects
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['payload_extract_regex']);
    }
  });

  it('rejects invalid slug', () => {
    expect(typeInputSchema.safeParse({ ...base, slug: 'Not A Slug' }).success).toBe(false);
  });
});

describe('typeSlugSchema', () => {
  it.each([['app'], ['in-app-event'], ['cpp'], ['a1-b2']])('accepts %p', (s) => {
    expect(typeSlugSchema.safeParse(s).success).toBe(true);
  });

  it.each([[''], ['In-App'], ['foo_bar'], ['-foo'], ['foo-']])('rejects %p', (s) => {
    expect(typeSlugSchema.safeParse(s).success).toBe(false);
  });
});

describe('submissionIdPatternInputSchema', () => {
  it('accepts a pattern with submission_id named group', () => {
    const r = submissionIdPatternInputSchema.safeParse({
      body_regex: 'Submission ID: (?<submission_id>[a-f0-9-]{36})',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when submission_id named group is missing', () => {
    const r = submissionIdPatternInputSchema.safeParse({
      body_regex: 'Submission ID: ([a-f0-9-]{36})',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/submission_id/);
    }
  });
});

describe('saveRulesInputSchema', () => {
  const validPayload = {
    platform_id: PLATFORM_ID,
    expected_version_number: 12 as number | null,
    senders: [{ email: 'no-reply@apple.com', is_primary: true, active: true }],
    subject_patterns: [
      {
        outcome: 'APPROVED' as const,
        regex: 'Review of your (?<app_name>.+) submission is complete\\.',
        priority: 10,
      },
    ],
    types: [
      {
        name: 'App',
        slug: 'app',
        body_keyword: 'App Version',
        sort_order: 10,
      },
    ],
    submission_id_patterns: [],
  };

  it('accepts a valid payload', () => {
    expect(saveRulesInputSchema.safeParse(validPayload).success).toBe(true);
  });

  it('accepts expected_version_number = null (first save)', () => {
    const r = saveRulesInputSchema.safeParse({
      ...validPayload,
      expected_version_number: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects expected_version_number = 0 (use null for first save)', () => {
    const r = saveRulesInputSchema.safeParse({
      ...validPayload,
      expected_version_number: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative expected_version_number', () => {
    const r = saveRulesInputSchema.safeParse({
      ...validPayload,
      expected_version_number: -1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects when expected_version_number omitted', () => {
    const { expected_version_number, ...withoutField } = validPayload;
    void expected_version_number;
    const r = saveRulesInputSchema.safeParse(withoutField);
    expect(r.success).toBe(false);
  });

  it('rejects duplicate sender email (post-normalization)', () => {
    const r = saveRulesInputSchema.safeParse({
      ...validPayload,
      senders: [
        { email: 'no-reply@apple.com' },
        { email: 'NO-REPLY@APPLE.COM' },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const dup = r.error.issues.find((i) => i.message.includes('Duplicate sender'));
      expect(dup).toBeDefined();
      expect(dup?.path).toEqual(['senders', 1, 'email']);
    }
  });

  it('rejects duplicate type slug', () => {
    const r = saveRulesInputSchema.safeParse({
      ...validPayload,
      types: [
        { name: 'App', slug: 'app', body_keyword: 'App Version' },
        { name: 'App v2', slug: 'app', body_keyword: 'Version' },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const dup = r.error.issues.find((i) => i.message.includes('Duplicate type'));
      expect(dup).toBeDefined();
    }
  });

  it('rejects invalid platform_id', () => {
    expect(
      saveRulesInputSchema.safeParse({ ...validPayload, platform_id: 'not-uuid' }).success,
    ).toBe(false);
  });

  it('allows empty rule arrays (full wipe)', () => {
    const r = saveRulesInputSchema.safeParse({
      platform_id: PLATFORM_ID,
      expected_version_number: null,
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
    });
    expect(r.success).toBe(true);
  });
});

describe('rollbackRulesInputSchema', () => {
  it('accepts a positive version number', () => {
    expect(
      rollbackRulesInputSchema.safeParse({
        platform_id: PLATFORM_ID,
        target_version: 3,
      }).success,
    ).toBe(true);
  });

  it('rejects non-positive version', () => {
    expect(
      rollbackRulesInputSchema.safeParse({
        platform_id: PLATFORM_ID,
        target_version: 0,
      }).success,
    ).toBe(false);
  });
});

describe('configSnapshotSchema', () => {
  it('accepts a minimal snapshot', () => {
    const r = configSnapshotSchema.safeParse({
      schema_version: 1,
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unsupported schema_version', () => {
    expect(
      configSnapshotSchema.safeParse({
        schema_version: 2,
        senders: [],
        subject_patterns: [],
        types: [],
        submission_id_patterns: [],
      }).success,
    ).toBe(false);
  });
});
