/**
 * Pure helpers for the RegexInput component — kept out of the .tsx file so
 * vitest (node env, no JSX parser) can import them directly.
 */

import {
  validateAliasRegexClient,
  validatePayloadRegexClient,
  validateSubjectPatternClient,
  validateSubmissionIdPatternClient,
  type ClientValidatorResult,
} from '@/lib/store-submissions/regex/client-validators';

export type RegexInputKind = 'subject' | 'payload' | 'alias' | 'submission_id';

export const REGEX_INPUT_HINTS: Record<RegexInputKind, string> = {
  subject: 'Must capture (?<app_name>...) — fed into Step 3 app lookup',
  payload: 'Optional named groups — extract version, event_id, page_id, etc.',
  alias: 'No required groups. Reject empty and over-permissive patterns.',
  submission_id:
    'Must capture (?<submission_id>...) — used for thread matching',
};

export function pickRegexValidator(
  kind: RegexInputKind,
): (pattern: string) => ClientValidatorResult {
  switch (kind) {
    case 'subject':
      return validateSubjectPatternClient;
    case 'payload':
      return validatePayloadRegexClient;
    case 'alias':
      return validateAliasRegexClient;
    case 'submission_id':
      return validateSubmissionIdPatternClient;
  }
}
