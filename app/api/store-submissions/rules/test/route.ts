/**
 * POST /api/store-submissions/rules/test
 *
 * Dry-run an email against the current (or overridden) rule set for a
 * platform and return the full classification trace. Powers the "Test
 * with subject" affordance in the Email Rules config UI (mockup Chunk 3).
 *
 * Contract:
 *   - MANAGER role required; DEV/VIEWER → 403.
 *   - ZERO side effects: no DB writes, no Gmail API calls, no rule cache
 *     mutation. Only READS go through `getRulesSnapshotForPlatform`. The
 *     integration tests assert this by verifying `storeDb()` write
 *     methods were never invoked.
 *   - Any classifier outcome, including ERROR (e.g. a bad regex in
 *     `override_rules`), returns HTTP 200 with the outcome in the body.
 *     Only auth/validation/infra failures return non-200.
 *
 * Override semantics (`override_rules`):
 *   Each provided array REPLACES the corresponding base array in full
 *   (not a merge). Arrays left undefined fall back to the DB snapshot.
 *   Rationale: Manager testing a draft rule set wants predictable,
 *   hermetic behaviour — merging would conflate with live DB state and
 *   make "why did this classify that way?" hard to reason about.
 *
 * See docs/store-submissions/03-email-rule-engine.md §6 and
 *     docs/store-submissions/05-api-frontend.md §A.9.3.
 */

import { getServerSession } from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { authOptions } from '@/lib/auth';
import { classify } from '@/lib/store-submissions/classifier';
import type {
  ClassificationResult,
  MatchedRule,
  RulesSnapshot,
} from '@/lib/store-submissions/classifier/types';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  requireStoreRole,
} from '@/lib/store-submissions/auth';
import { getRulesSnapshotForPlatform } from '@/lib/store-submissions/queries/rules';

// -- Input schema --------------------------------------------------------
//
// `override_rules` schemas are intentionally loose (no RE2 refinement) —
// the Manager is testing a possibly-invalid regex. If it fails to
// compile, the classifier traps and returns ERROR PARSE_ERROR, which is
// useful feedback they get at HTTP 200.

const outcomeEnum = z.enum(['APPROVED', 'REJECTED', 'IN_REVIEW']);
const platformKeyEnum = z.enum(['apple', 'google', 'huawei', 'facebook']);
const aliasSourceEnum = z.enum([
  'AUTO_CURRENT',
  'AUTO_HISTORICAL',
  'MANUAL',
  'REGEX',
]);

const senderOverride = z.object({
  id: z.string().optional(),
  email: z.string(),
  is_primary: z.boolean().default(false),
  active: z.boolean().default(true),
});

const subjectPatternOverride = z.object({
  id: z.string().optional(),
  outcome: outcomeEnum,
  regex: z.string().min(1),
  priority: z.number().int().default(100),
  active: z.boolean().default(true),
});

const typeOverride = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  slug: z.string().min(1),
  body_keyword: z.string().min(1),
  payload_extract_regex: z.string().nullable().optional(),
  sort_order: z.number().int().default(100),
  active: z.boolean().default(true),
});

const submissionIdPatternOverride = z.object({
  id: z.string().optional(),
  body_regex: z.string().min(1),
  active: z.boolean().default(true),
});

const appWithAliasesOverride = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(
    z.object({
      alias_text: z.string().nullable(),
      alias_regex: z.string().nullable(),
      source_type: aliasSourceEnum,
    }),
  ),
  platform_bindings: z
    .array(z.object({ platform_id: z.string() }))
    .default([]),
});

const overrideRulesSchema = z
  .object({
    platform_key: platformKeyEnum.optional(),
    senders: z.array(senderOverride).optional(),
    subject_patterns: z.array(subjectPatternOverride).optional(),
    types: z.array(typeOverride).optional(),
    submission_id_patterns: z.array(submissionIdPatternOverride).optional(),
    apps_with_aliases: z.array(appWithAliasesOverride).optional(),
  })
  .strict();

const testInputSchema = z.object({
  sender: z.string(),
  subject: z.string(),
  body: z.string(),
  platform_id: z.string().uuid('Invalid platform_id'),
  override_rules: overrideRulesSchema.optional(),
});

// -- Handler -------------------------------------------------------------

type ErrorBody = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};

type SuccessBody = {
  ok: true;
  data: { result: ClassificationResult; trace: MatchedRule[] };
};

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse<ErrorBody> {
  return NextResponse.json(
    { ok: false, error: { code, message, details } },
    { status },
  );
}

function extractTrace(result: ClassificationResult): MatchedRule[] {
  if (result.status === 'DROPPED') return result.matched_rules ?? [];
  return result.matched_rules;
}

/**
 * Apply override_rules onto a base snapshot using replace-per-array
 * semantics. `platform_id` cannot be overridden (the URL is the source
 * of truth); `platform_key` can be because override callers supplying
 * a synthetic rule set may want to drive platform-specific formatting
 * in downstream code.
 */
/**
 * Synthesize a stable placeholder ID for an override rule that was
 * submitted without one (i.e. a draft rule the Manager hasn't saved).
 * The ID is only ever surfaced in the trace — no DB lookup happens
 * against it — so any deterministic string works.
 */
function withId<T extends { id?: string }>(
  prefix: string,
  rule: T,
  idx: number,
): T & { id: string } {
  return { ...rule, id: rule.id ?? `${prefix}-override-${idx}` };
}

function applyOverrides(
  base: RulesSnapshot,
  overrides: z.infer<typeof overrideRulesSchema> | undefined,
): RulesSnapshot {
  if (!overrides) return base;
  return {
    ...base,
    platform_key: overrides.platform_key ?? base.platform_key,
    senders: overrides.senders
      ? overrides.senders.map((s, i) => withId('sender', s, i))
      : base.senders,
    subject_patterns: overrides.subject_patterns
      ? overrides.subject_patterns.map((p, i) => withId('subject', p, i))
      : base.subject_patterns,
    types: overrides.types
      ? overrides.types.map((t, i) => ({
          ...withId('type', t, i),
          payload_extract_regex: t.payload_extract_regex ?? null,
        }))
      : base.types,
    submission_id_patterns: overrides.submission_id_patterns
      ? overrides.submission_id_patterns.map((p, i) =>
          withId('submission-id', p, i),
        )
      : base.submission_id_patterns,
    apps_with_aliases:
      overrides.apps_with_aliases ?? base.apps_with_aliases,
  };
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<SuccessBody | ErrorBody>> {
  // Auth
  const session = await getServerSession(authOptions);
  try {
    await requireStoreRole(session?.user?.email, 'MANAGER');
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return errorResponse('UNAUTHORIZED', err.message, 401);
    }
    if (err instanceof StoreForbiddenError) {
      return errorResponse('FORBIDDEN', err.message, 403);
    }
    throw err;
  }

  // Parse body
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse('BAD_REQUEST', 'Request body must be valid JSON', 400);
  }

  const parsed = testInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      'VALIDATION',
      parsed.error.issues[0]?.message ?? 'Invalid input',
      400,
      parsed.error.issues,
    );
  }

  // Load rules
  const base = await getRulesSnapshotForPlatform(parsed.data.platform_id);
  if (!base) {
    return errorResponse(
      'NOT_FOUND',
      `Platform ${parsed.data.platform_id} not found`,
      404,
    );
  }

  const rules = applyOverrides(base, parsed.data.override_rules);

  // Classify — pure function. RE2 errors are trapped by classify() and
  // surface as ErrorResult, NOT thrown. Unknown errors propagate and
  // become a 500 via Next.js default error boundary.
  const result = classify(
    {
      sender: parsed.data.sender,
      subject: parsed.data.subject,
      body: parsed.data.body,
    },
    rules,
  );

  return NextResponse.json(
    { ok: true, data: { result, trace: extractTrace(result) } },
    { status: 200 },
  );
}
