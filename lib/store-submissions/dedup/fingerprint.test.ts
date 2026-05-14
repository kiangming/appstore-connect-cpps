import { describe, expect, it } from 'vitest';

import type { ExtractedPayload } from '../gmail/html-extractor';
import type {
  ClassificationResult,
  ClassifiedResult,
  PlatformKey,
} from '../classifier/types';

import { computeFingerprint } from './fingerprint';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
const APP_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID_VERSION = '33333333-3333-4333-8333-333333333333';
const TYPE_ID_CPP = '44444444-4444-4444-8444-444444444444';
const SUB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const classified = (over: Partial<ClassifiedResult> = {}): ClassifiedResult => ({
  status: 'CLASSIFIED',
  platform_id: PLATFORM_ID,
  app_id: APP_ID,
  type_id: TYPE_ID_VERSION,
  outcome: 'APPROVED',
  type_payload: {},
  submission_id: null,
  extracted_app_name: 'Test App',
  matched_rules: [],
  ...over,
});

const payload = (
  over: Partial<ExtractedPayload> = {},
): ExtractedPayload => ({
  outcome: 'ACCEPTED',
  items: [],
  submission_id: SUB_ID,
  app_name: 'Test App',
  ...over,
});

function call(args: {
  classification?: ClassificationResult;
  extractedPayload?: ExtractedPayload | null;
  platformKey?: PlatformKey;
}): string | null {
  return computeFingerprint({
    classification: args.classification ?? classified(),
    extractedPayload:
      args.extractedPayload === undefined ? payload() : args.extractedPayload,
    platformKey: args.platformKey ?? 'apple',
  });
}

describe('computeFingerprint — composition', () => {
  it('joins all slots with | for Apple CLASSIFIED + ext_submission_id', () => {
    expect(call({})).toBe(
      [PLATFORM_ID, APP_ID, TYPE_ID_VERSION, 'APPROVED', SUB_ID, ''].join('|'),
    );
  });

  it('includes version when APP_VERSION item is present', () => {
    expect(
      call({
        extractedPayload: payload({
          items: [
            {
              type: 'APP_VERSION',
              raw_heading: 'App Version',
              raw_body: '1.0.13 for iOS',
              version: '1.0.13',
              platform: 'iOS',
            },
          ],
        }),
      }),
    ).toBe(
      [PLATFORM_ID, APP_ID, TYPE_ID_VERSION, 'APPROVED', SUB_ID, '1.0.13'].join('|'),
    );
  });

  it('leaves version slot empty for CPP / IAE / PPO items', () => {
    expect(
      call({
        classification: classified({ type_id: TYPE_ID_CPP }),
        extractedPayload: payload({
          items: [
            {
              type: 'CUSTOM_PRODUCT_PAGE',
              raw_heading: 'Custom Product Pages',
              raw_body: 'My Page\nuuid-here',
              name: 'My Page',
              uuid: 'uuid-here',
            },
          ],
        }),
      }),
    ).toBe(
      [PLATFORM_ID, APP_ID, TYPE_ID_CPP, 'APPROVED', SUB_ID, ''].join('|'),
    );
  });

  it('takes the first APP_VERSION item when multiple are present', () => {
    const fp = call({
      extractedPayload: payload({
        items: [
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: '2.5.0 for macOS',
            version: '2.5.0',
            platform: 'macOS',
          },
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: '3.0.0 for iOS',
            version: '3.0.0',
            platform: 'iOS',
          },
        ],
      }),
    });
    expect(fp?.endsWith('|2.5.0')).toBe(true);
  });

  it('leaves version slot empty when APP_VERSION item lacks version field', () => {
    const fp = call({
      extractedPayload: payload({
        items: [
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: 'unparseable body',
          },
        ],
      }),
    });
    expect(fp?.endsWith('|')).toBe(true);
  });

  it('produces identical fingerprints for two emails with same key fields (the structural dedup target)', () => {
    const a = call({});
    const b = call({});
    expect(a).toBe(b);
  });

  it('differentiates by outcome (APPROVED vs REJECTED — verdict flip must not collapse)', () => {
    const approved = call({});
    const rejected = call({
      classification: classified({ outcome: 'REJECTED' }),
      extractedPayload: payload({ outcome: 'REJECTED' }),
    });
    expect(approved).not.toBe(rejected);
  });

  it('differentiates by app_id (cross-app coincidence guard)', () => {
    const a = call({});
    const b = call({
      classification: classified({ app_id: '99999999-9999-4999-8999-999999999999' }),
    });
    expect(a).not.toBe(b);
  });

  it('differentiates by type_id (cross-type guard)', () => {
    const a = call({});
    const b = call({ classification: classified({ type_id: TYPE_ID_CPP }) });
    expect(a).not.toBe(b);
  });

  it('differentiates by ext_submission_id (resubmit cycle guard)', () => {
    const a = call({});
    const b = call({
      extractedPayload: payload({
        submission_id: 'ffffffff-ffff-cccc-dddd-eeeeeeeeeeee',
      }),
    });
    expect(a).not.toBe(b);
  });
});

describe('computeFingerprint — skip conditions', () => {
  it('returns null for non-Apple platforms (Phase 1 scope)', () => {
    expect(call({ platformKey: 'google' })).toBeNull();
    expect(call({ platformKey: 'huawei' })).toBeNull();
    expect(call({ platformKey: 'facebook' })).toBeNull();
  });

  it('returns null for DROPPED classification', () => {
    expect(
      call({
        classification: {
          status: 'DROPPED',
          reason: 'SUBJECT_NOT_TRACKED',
        } as ClassificationResult,
      }),
    ).toBeNull();
  });

  it('returns null for ERROR classification', () => {
    expect(
      call({
        classification: {
          status: 'ERROR',
          error_code: 'PARSE_ERROR',
          error_message: 'boom',
          matched_rules: [],
        },
      }),
    ).toBeNull();
  });

  it('returns null for UNCLASSIFIED_APP (bucket tickets already merge)', () => {
    expect(
      call({
        classification: {
          status: 'UNCLASSIFIED_APP',
          platform_id: PLATFORM_ID,
          outcome: 'APPROVED',
          extracted_app_name: 'Mystery App',
          matched_rules: [],
        },
      }),
    ).toBeNull();
  });

  it('returns null for UNCLASSIFIED_TYPE (bucket tickets already merge)', () => {
    expect(
      call({
        classification: {
          status: 'UNCLASSIFIED_TYPE',
          platform_id: PLATFORM_ID,
          app_id: APP_ID,
          outcome: 'APPROVED',
          extracted_app_name: 'App',
          matched_rules: [],
        },
      }),
    ).toBeNull();
  });

  it('returns null when extractedPayload is null', () => {
    expect(call({ extractedPayload: null })).toBeNull();
  });

  it('returns null when ext_submission_id is missing (anchor required)', () => {
    expect(
      call({
        extractedPayload: payload({ submission_id: undefined }),
      }),
    ).toBeNull();
  });

  it('returns null when ext_submission_id is empty string', () => {
    expect(
      call({
        extractedPayload: payload({ submission_id: '' }),
      }),
    ).toBeNull();
  });
});

describe('computeFingerprint — format stability with migration', () => {
  // This format MUST match the PL/pgSQL composition in
  // 20260514000000_store_mgmt_pr_inbox_forward_dedup.sql step 3.
  // If you change separator or field order, update the migration
  // AND write a follow-up that re-computes duplicate_fingerprint
  // on every Apple CLASSIFIED row.
  it('uses pipe separator with 5 separators (6 slots)', () => {
    const fp = call({}) ?? '';
    expect(fp.split('|').length).toBe(6);
  });

  it('field order is platform | app | type | outcome | submission | version', () => {
    const fp = call({
      extractedPayload: payload({
        items: [
          {
            type: 'APP_VERSION',
            raw_heading: 'App Version',
            raw_body: '4.2.0 for iOS',
            version: '4.2.0',
            platform: 'iOS',
          },
        ],
      }),
    });
    const [pid, aid, tid, outcome, sid, ver] = (fp ?? '').split('|');
    expect(pid).toBe(PLATFORM_ID);
    expect(aid).toBe(APP_ID);
    expect(tid).toBe(TYPE_ID_VERSION);
    expect(outcome).toBe('APPROVED');
    expect(sid).toBe(SUB_ID);
    expect(ver).toBe('4.2.0');
  });
});
