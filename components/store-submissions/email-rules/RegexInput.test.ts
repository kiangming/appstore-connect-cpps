import { describe, expect, it } from 'vitest';

import {
  validateAliasRegexClient,
  validatePayloadRegexClient,
  validateSubjectPatternClient,
  validateSubmissionIdPatternClient,
} from '@/lib/store-submissions/regex/client-validators';

import { REGEX_INPUT_HINTS, pickRegexValidator } from './regex-input-helpers';

describe('pickRegexValidator', () => {
  it('maps each kind to the matching client validator', () => {
    expect(pickRegexValidator('subject')).toBe(validateSubjectPatternClient);
    expect(pickRegexValidator('payload')).toBe(validatePayloadRegexClient);
    expect(pickRegexValidator('alias')).toBe(validateAliasRegexClient);
    expect(pickRegexValidator('submission_id')).toBe(validateSubmissionIdPatternClient);
  });
});

describe('REGEX_INPUT_HINTS', () => {
  it('has a non-empty hint for every kind', () => {
    for (const k of ['subject', 'payload', 'alias', 'submission_id'] as const) {
      expect(REGEX_INPUT_HINTS[k]).toMatch(/\S/);
    }
  });

  it('mentions app_name for subject and submission_id for submission_id', () => {
    expect(REGEX_INPUT_HINTS.subject).toMatch(/app_name/);
    expect(REGEX_INPUT_HINTS.submission_id).toMatch(/submission_id/);
  });
});
