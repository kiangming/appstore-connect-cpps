import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidRegexError, RegexTimeoutError } from '../regex/re2';

import type {
  AppMatch,
  AppWithAliases,
  EmailInput,
  RulesSnapshot,
  SenderMatch,
  SubjectMatch,
  SubmissionIdMatch,
  TypeMatch,
} from './types';

// ------------------------------------------------------------------
// Per-matcher mocks — hoisted so the SUT imports the mock, not the stub.
// ------------------------------------------------------------------

const {
  mockMatchSender,
  mockMatchSubject,
  mockMatchApp,
  mockMatchType,
  mockExtractSubmissionId,
} = vi.hoisted(() => ({
  mockMatchSender: vi.fn(),
  mockMatchSubject: vi.fn(),
  mockMatchApp: vi.fn(),
  mockMatchType: vi.fn(),
  mockExtractSubmissionId: vi.fn(),
}));

vi.mock('./sender-matcher', () => ({ matchSender: mockMatchSender }));
vi.mock('./subject-matcher', () => ({ matchSubject: mockMatchSubject }));
vi.mock('./app-matcher', () => ({ matchApp: mockMatchApp }));
vi.mock('./type-matcher', () => ({ matchType: mockMatchType }));
vi.mock('./submission-id-extractor', () => ({
  extractSubmissionId: mockExtractSubmissionId,
}));

import { classify } from './index';

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PLATFORM_ID = '22222222-2222-4222-8222-222222222222';
const APP_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_ID = '44444444-4444-4444-8444-444444444444';
const PATTERN_ID = '55555555-5555-4555-8555-555555555555';
const SENDER_ID = '66666666-6666-4666-8666-666666666666';
const SUB_ID_PATTERN_ID = '77777777-7777-4777-8777-777777777777';

function makeRules(overrides: Partial<RulesSnapshot> = {}): RulesSnapshot {
  return {
    platform_id: PLATFORM_ID,
    platform_key: 'apple',
    senders: [{ id: SENDER_ID, email: 'no-reply@apple.com', is_primary: true, active: true }],
    subject_patterns: [],
    types: [],
    submission_id_patterns: [],
    apps_with_aliases: [],
    ...overrides,
  };
}

function makeEmail(overrides: Partial<EmailInput> = {}): EmailInput {
  return {
    sender: 'no-reply@apple.com',
    subject: 'Review of your Skyline Runners submission is complete.',
    body: 'App Version\n2.4.1 for iOS',
    ...overrides,
  };
}

function makeApp(overrides: Partial<AppWithAliases> = {}): AppWithAliases {
  return {
    id: APP_ID,
    name: 'Skyline Runners',
    aliases: [
      { alias_text: 'Skyline Runners', alias_regex: null, source_type: 'AUTO_CURRENT' },
    ],
    platform_bindings: [{ platform_id: PLATFORM_ID }],
    ...overrides,
  };
}

// Matcher-response fixtures — kept small; full matcher behaviour lives in 2.2.
const senderHit: SenderMatch = {
  platform_id: PLATFORM_ID,
  platform_key: 'apple',
  sender_email: 'no-reply@apple.com',
};
const subjectHit: SubjectMatch = {
  pattern_id: PATTERN_ID,
  outcome: 'APPROVED',
  extracted_app_name: 'Skyline Runners',
  matched_pattern: 'Review of your (?<app_name>.+) submission is complete\\.',
};
const appHit: AppMatch = {
  app_id: APP_ID,
  app_name: 'Skyline Runners',
  matched_alias: {
    kind: 'text',
    value: 'Skyline Runners',
    source_type: 'AUTO_CURRENT',
  },
};
const typeHit: TypeMatch = {
  type_id: TYPE_ID,
  type_slug: 'app',
  type_name: 'App',
  payload: { version: '2.4.1', os: 'iOS' },
};
const subIdHit: SubmissionIdMatch = {
  pattern_id: SUB_ID_PATTERN_ID,
  submission_id: 'abc-123',
};

beforeEach(() => {
  mockMatchSender.mockReset();
  mockMatchSubject.mockReset();
  mockMatchApp.mockReset();
  mockMatchType.mockReset();
  mockExtractSubmissionId.mockReset();
  // Default everything to "no match" so tests opt-in to each step.
  mockMatchSender.mockReturnValue(null);
  mockMatchSubject.mockReturnValue(null);
  mockMatchApp.mockReturnValue(null);
  mockMatchType.mockReturnValue(null);
  mockExtractSubmissionId.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ------------------------------------------------------------------
// Orchestration — happy path
// ------------------------------------------------------------------

describe('classify — CLASSIFIED happy path', () => {
  it('runs all 5 steps in order and returns full result', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockReturnValue(subjectHit);
    mockMatchApp.mockReturnValue(appHit);
    mockMatchType.mockReturnValue(typeHit);
    mockExtractSubmissionId.mockReturnValue(subIdHit);

    const result = classify(makeEmail(), makeRules({ apps_with_aliases: [makeApp()] }));

    expect(result.status).toBe('CLASSIFIED');
    if (result.status !== 'CLASSIFIED') return;

    expect(result.platform_id).toBe(PLATFORM_ID);
    expect(result.app_id).toBe(APP_ID);
    expect(result.type_id).toBe(TYPE_ID);
    expect(result.outcome).toBe('APPROVED');
    expect(result.type_payload).toEqual({ version: '2.4.1', os: 'iOS' });
    expect(result.submission_id).toBe('abc-123');
    expect(result.extracted_app_name).toBe('Skyline Runners');
    expect(result.matched_rules).toHaveLength(5);
    expect(result.matched_rules.map((m) => m.step)).toEqual([
      'sender',
      'subject',
      'app',
      'type',
      'submission_id',
    ]);
    expect(result.matched_rules.every((m) => m.matched)).toBe(true);
  });

  it('CLASSIFIED with missing submission_id returns submission_id=null, trace step=matched:false', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockReturnValue(subjectHit);
    mockMatchApp.mockReturnValue(appHit);
    mockMatchType.mockReturnValue(typeHit);
    mockExtractSubmissionId.mockReturnValue(null);

    const result = classify(makeEmail(), makeRules({ apps_with_aliases: [makeApp()] }));

    expect(result.status).toBe('CLASSIFIED');
    if (result.status !== 'CLASSIFIED') return;
    expect(result.submission_id).toBeNull();
    const subIdTrace = result.matched_rules.find((m) => m.step === 'submission_id');
    expect(subIdTrace?.matched).toBe(false);
    expect(subIdTrace?.details).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Short-circuit paths
// ------------------------------------------------------------------

describe('classify — DROPPED (no sender match)', () => {
  it('returns DROPPED and does NOT call subsequent matchers', () => {
    mockMatchSender.mockReturnValue(null);

    const result = classify(makeEmail(), makeRules());

    expect(result).toEqual({ status: 'DROPPED', reason: 'NO_SENDER_MATCH' });
    expect(mockMatchSubject).not.toHaveBeenCalled();
    expect(mockMatchApp).not.toHaveBeenCalled();
    expect(mockMatchType).not.toHaveBeenCalled();
    expect(mockExtractSubmissionId).not.toHaveBeenCalled();
  });
});

describe('classify — ERROR (no subject pattern matched)', () => {
  it('returns ERROR NO_SUBJECT_MATCH with sender trace populated', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockReturnValue(null);

    const result = classify(makeEmail(), makeRules());

    expect(result.status).toBe('ERROR');
    if (result.status !== 'ERROR') return;
    expect(result.error_code).toBe('NO_SUBJECT_MATCH');
    expect(result.error_message).toContain('apple');
    expect(result.matched_rules).toHaveLength(1);
    expect(result.matched_rules[0]?.step).toBe('sender');
    expect(mockMatchApp).not.toHaveBeenCalled();
  });
});

describe('classify — UNCLASSIFIED_APP', () => {
  it('returns UNCLASSIFIED_APP when app lookup fails, keeps outcome + extracted_app_name', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockReturnValue(subjectHit);
    mockMatchApp.mockReturnValue(null);

    const result = classify(makeEmail(), makeRules());

    expect(result.status).toBe('UNCLASSIFIED_APP');
    if (result.status !== 'UNCLASSIFIED_APP') return;
    expect(result.platform_id).toBe(PLATFORM_ID);
    expect(result.outcome).toBe('APPROVED');
    expect(result.extracted_app_name).toBe('Skyline Runners');
    // trace: sender(hit), subject(hit), app(miss)
    expect(result.matched_rules).toHaveLength(3);
    expect(result.matched_rules[2]).toEqual({ step: 'app', matched: false });
    expect(mockMatchType).not.toHaveBeenCalled();
  });

  it('passes the extracted name from subject into matchApp', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockReturnValue(subjectHit);
    mockMatchApp.mockReturnValue(null);

    classify(makeEmail(), makeRules());

    expect(mockMatchApp).toHaveBeenCalledWith('Skyline Runners', []);
  });
});

describe('classify — UNCLASSIFIED_TYPE', () => {
  it('returns UNCLASSIFIED_TYPE with app_id set, trace stops at type-miss', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockReturnValue(subjectHit);
    mockMatchApp.mockReturnValue(appHit);
    mockMatchType.mockReturnValue(null);

    const result = classify(makeEmail(), makeRules({ apps_with_aliases: [makeApp()] }));

    expect(result.status).toBe('UNCLASSIFIED_TYPE');
    if (result.status !== 'UNCLASSIFIED_TYPE') return;
    expect(result.platform_id).toBe(PLATFORM_ID);
    expect(result.app_id).toBe(APP_ID);
    expect(result.extracted_app_name).toBe('Skyline Runners');
    expect(result.outcome).toBe('APPROVED');
    expect(result.matched_rules).toHaveLength(4);
    expect(result.matched_rules[3]).toEqual({ step: 'type', matched: false });
    expect(mockExtractSubmissionId).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// Exception paths — RE2 errors propagate as ErrorResult, not throws
// ------------------------------------------------------------------

describe('classify — RE2 error trapping', () => {
  it('RegexTimeoutError in any step → ErrorResult REGEX_TIMEOUT', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockImplementation(() => {
      throw new RegexTimeoutError('bad-pattern');
    });

    const result = classify(makeEmail(), makeRules());

    expect(result.status).toBe('ERROR');
    if (result.status !== 'ERROR') return;
    expect(result.error_code).toBe('REGEX_TIMEOUT');
    expect(result.error_message).toContain('bad-pattern');
    // sender trace already recorded before the throw
    expect(result.matched_rules).toHaveLength(1);
  });

  it('InvalidRegexError → ErrorResult PARSE_ERROR', () => {
    mockMatchSender.mockReturnValue(senderHit);
    mockMatchSubject.mockImplementation(() => {
      throw new InvalidRegexError('(?<=lookbehind)', 'unsupported feature');
    });

    const result = classify(makeEmail(), makeRules());

    expect(result.status).toBe('ERROR');
    if (result.status !== 'ERROR') return;
    expect(result.error_code).toBe('PARSE_ERROR');
  });

  it('unknown exception propagates (not swallowed)', () => {
    mockMatchSender.mockImplementation(() => {
      throw new Error('db gone');
    });
    expect(() => classify(makeEmail(), makeRules())).toThrow('db gone');
  });
});

// ------------------------------------------------------------------
// Enhancement 1 — dev-only scoping assertion
// ------------------------------------------------------------------

describe('classify — apps_with_aliases platform-scoping assertion', () => {
  // Next.js declares process.env.NODE_ENV as a readonly literal union, so
  // direct assignment fails tsc. Route through an untyped handle to flip
  // it per-test; `vi.stubEnv` isn't quite right here because we care about
  // the real process.env value at the moment `classify()` reads it.
  const envAny = process.env as Record<string, string | undefined>;
  const origEnv = envAny.NODE_ENV;

  afterEach(() => {
    envAny.NODE_ENV = origEnv;
  });

  it('throws in dev when an app has no binding to rules.platform_id', () => {
    envAny.NODE_ENV = 'development';
    const offender = makeApp({
      name: 'CrossPlatform',
      platform_bindings: [{ platform_id: OTHER_PLATFORM_ID }],
    });
    expect(() =>
      classify(makeEmail(), makeRules({ apps_with_aliases: [offender] })),
    ).toThrow(/RulesSnapshot contract violation/);
  });

  it('allows apps with matching platform binding', () => {
    envAny.NODE_ENV = 'development';
    // No sender mock → DROPPED; this test only exercises the assertion.
    expect(() =>
      classify(makeEmail(), makeRules({ apps_with_aliases: [makeApp()] })),
    ).not.toThrow();
  });

  it('is compiled-out in production — no throw even with bad scoping', () => {
    envAny.NODE_ENV = 'production';
    const offender = makeApp({
      name: 'CrossPlatform',
      platform_bindings: [{ platform_id: OTHER_PLATFORM_ID }],
    });
    expect(() =>
      classify(makeEmail(), makeRules({ apps_with_aliases: [offender] })),
    ).not.toThrow();
  });

  it('message lists up to 3 mismatched app names + "+N more"', () => {
    envAny.NODE_ENV = 'test';
    const offenders = Array.from({ length: 5 }, (_, i) =>
      makeApp({
        name: `Bad-${i}`,
        platform_bindings: [{ platform_id: OTHER_PLATFORM_ID }],
      }),
    );
    try {
      classify(makeEmail(), makeRules({ apps_with_aliases: offenders }));
      throw new Error('expected contract violation');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Bad-0, Bad-1, Bad-2/);
      expect(msg).toMatch(/\+2 more/);
    }
  });
});
