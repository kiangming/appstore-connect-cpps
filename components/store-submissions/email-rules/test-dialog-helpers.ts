/**
 * Pure helpers for the TestEmailDialog — extracted so vitest (node env)
 * can exercise payload building + trace summarization without JSX.
 */

import type { DraftState } from './helpers';

/**
 * Max body size for the test endpoint. Matches the classifier's ~100KB
 * slice (docs/store-submissions/03-email-rule-engine.md §4.3). Enforced
 * client-side so we fail fast instead of round-tripping a rejected body.
 */
export const MAX_TEST_BODY_BYTES = 100_000;

export interface TestEmailInput {
  sender: string;
  subject: string;
  body: string;
}

export interface OverrideRulesPayload {
  senders: Array<{ email: string; is_primary: boolean; active: boolean }>;
  subject_patterns: Array<{
    outcome: 'APPROVED' | 'REJECTED' | 'IN_REVIEW';
    regex: string;
    priority: number;
    active: boolean;
  }>;
  types: Array<{
    name: string;
    slug: string;
    body_keyword: string;
    payload_extract_regex: string | null;
    sort_order: number;
    active: boolean;
  }>;
  submission_id_patterns: Array<{
    body_regex: string;
    active: boolean;
  }>;
}

export interface TestApiRequest {
  sender: string;
  subject: string;
  body: string;
  platform_id: string;
  override_rules: OverrideRulesPayload;
}

/**
 * Build the POST body for /api/store-submissions/rules/test using the
 * Manager's current draft.
 *
 * Filter invariants (so the test endpoint's zod schema doesn't reject a
 * draft that merely has a newly-added empty row):
 *   - senders: require non-empty `email`
 *   - subject_patterns: require non-empty `regex`
 *   - types: require non-empty `name`, `slug`, `body_keyword`
 *   - submission_id_patterns: require non-empty `body_regex`
 *   - types.payload_extract_regex: "" and null both → null (API accepts null)
 *
 * `id` is intentionally NOT forwarded — the override schemas accept
 * missing `id` (documented in app/api/store-submissions/rules/test/route.ts),
 * and newly-added rows don't have one anyway.
 */
export function buildTestPayload(
  draft: DraftState,
  platformId: string,
  input: TestEmailInput,
): TestApiRequest {
  return {
    sender: input.sender,
    subject: input.subject,
    body: input.body,
    platform_id: platformId,
    override_rules: {
      senders: draft.senders
        .filter((s) => s.email.trim() !== '')
        .map((s) => ({
          email: s.email,
          is_primary: s.is_primary,
          active: s.active,
        })),
      subject_patterns: draft.subject_patterns
        .filter((p) => p.regex.trim() !== '')
        .map((p) => ({
          outcome: p.outcome,
          regex: p.regex,
          priority: p.priority,
          active: p.active,
        })),
      types: draft.types
        .filter(
          (t) =>
            t.name.trim() !== '' &&
            t.slug.trim() !== '' &&
            t.body_keyword.trim() !== '',
        )
        .map((t) => ({
          name: t.name,
          slug: t.slug,
          body_keyword: t.body_keyword,
          payload_extract_regex:
            t.payload_extract_regex && t.payload_extract_regex.trim() !== ''
              ? t.payload_extract_regex
              : null,
          sort_order: t.sort_order,
          active: t.active,
        })),
      submission_id_patterns: draft.submission_id_patterns
        .filter((p) => p.body_regex.trim() !== '')
        .map((p) => ({
          body_regex: p.body_regex,
          active: p.active,
        })),
    },
  };
}

// -- Result presentation -------------------------------------------------

export type TestOutcomeKind =
  | 'DROPPED'
  | 'UNCLASSIFIED_APP'
  | 'UNCLASSIFIED_TYPE'
  | 'CLASSIFIED'
  | 'ERROR';

export interface OutcomeDisplay {
  label: string;
  cls: string;
  description: string;
}

export const OUTCOME_DISPLAY: Record<TestOutcomeKind, OutcomeDisplay> = {
  DROPPED: {
    label: 'DROPPED',
    cls: 'bg-slate-100 text-slate-600 border-slate-200',
    description: 'Sender did not match — email would be ignored.',
  },
  UNCLASSIFIED_APP: {
    label: 'UNCLASSIFIED APP',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
    description:
      'Subject matched but no app alias resolves — email goes to the Unclassified bucket.',
  },
  UNCLASSIFIED_TYPE: {
    label: 'UNCLASSIFIED TYPE',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
    description:
      'App identified but body keyword did not match any type — Unclassified bucket.',
  },
  CLASSIFIED: {
    label: 'CLASSIFIED',
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    description: 'Email would be routed to a ticket for (app + type).',
  },
  ERROR: {
    label: 'ERROR',
    cls: 'bg-rose-50 text-rose-700 border-rose-200',
    description:
      'Classification failed — typically a bad regex. Email would be marked ERROR and skipped.',
  },
};

/**
 * Format a named-capture groups object for display. `null` → "—",
 * empty → "—", otherwise `k=v, k=v`. Used by the CLASSIFIED and
 * UNCLASSIFIED trace renderers.
 */
export function formatCapturedGroups(
  groups: Record<string, string> | null | undefined,
): string {
  if (!groups) return '—';
  const entries = Object.entries(groups).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

/**
 * Collapse a trace `details` map to a short single-line summary. Detail
 * shape varies by step and is `Record<string, unknown>` in the classifier
 * type — we extract the 2-3 most interesting fields per step so the UI
 * doesn't need to know the shape.
 */
export function summarizeTraceDetails(
  step: string,
  details: Record<string, unknown> | undefined,
): string {
  if (!details) return '';
  const get = (k: string) =>
    typeof details[k] === 'string' ? (details[k] as string) : null;

  switch (step) {
    case 'sender': {
      const matched = get('matched_sender');
      return matched ? `matched: ${matched}` : '';
    }
    case 'subject': {
      const outcome = get('outcome');
      const pattern = get('matched_pattern');
      const parts: string[] = [];
      if (outcome) parts.push(outcome);
      if (pattern) parts.push(pattern);
      return parts.join(' · ');
    }
    case 'app': {
      const appName = get('app_name') ?? get('extracted_name');
      return appName ? `app: ${appName}` : '';
    }
    case 'type': {
      const typeName = get('type');
      return typeName ? `type: ${typeName}` : '';
    }
    case 'submission_id': {
      const id = get('submission_id');
      return id ? `submission_id: ${id}` : '';
    }
    default:
      return '';
  }
}

/**
 * UTF-8 byte size of a string without allocating a Buffer. Keeps this
 * module free of node-only APIs so the file works in server *and* client
 * bundles.
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
