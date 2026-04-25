'use server';

/**
 * Server Actions for Manager-triggered email reclassify (PR-11.5).
 *
 * Two actions:
 *
 *   - `reclassifyEmailMessageAction(emailMessageId)` — single-row
 *     reclassify. Re-runs the TS classifier on the persisted email
 *     using the current rules + extracted_payload, then atomically
 *     swaps tickets via `reclassify_email_tx` RPC.
 *
 *   - `reclassifyUnclassifiedAction(bucket)` — bulk variant for the
 *     UNCLASSIFIED_APP / UNCLASSIFIED_TYPE buckets. Sequential `await`
 *     loop (Q4 confirmed: prod scale ~14 rows, sequential is fine).
 *     Per-row failures are captured + counted; the batch continues.
 *
 * Why TS-side classify + RPC for the swap (not a single SQL function):
 *   The classifier is in TypeScript (RE2 regex, fixture-tested) and
 *   runs nowhere else. Duplicating it in PL/pgSQL would fork two code
 *   paths. Keeping classification in TS and delegating only the
 *   atomic ticket swap to the RPC preserves a single classifier of
 *   record while still getting transactional guarantees on the write
 *   side.
 *
 * MANAGER-only. Defense-in-depth: Server Action gates here, RPC trusts
 * the actor_id passed in (consistent with the rest of `inbox/actions.ts`).
 *
 * Side effects:
 *   - Old ticket may end up empty if the email was its only occupant.
 *     We do NOT auto-archive empty tickets — Manager can clean those
 *     manually. The STATE_CHANGE 'reclassify_out' event entry on the
 *     old ticket preserves the move audit trail.
 *   - revalidatePath('/store-submissions/inbox') re-renders the list +
 *     any open detail panel server-side.
 */

import * as Sentry from '@sentry/nextjs';
import type { PostgrestError } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  requireStoreRole,
  StoreForbiddenError,
  StoreUnauthorizedError,
  type StoreUser,
} from '@/lib/store-submissions/auth';
import { classify } from '@/lib/store-submissions/classifier';
import type {
  ClassificationResult,
  EmailInput,
} from '@/lib/store-submissions/classifier/types';
import { storeDb } from '@/lib/store-submissions/db';
import type { ExtractedPayload } from '@/lib/store-submissions/gmail/html-extractor';
import {
  createSenderResolver,
  loadActiveSenders,
} from '@/lib/store-submissions/gmail/sender-resolver';
import { CLASSIFIER_VERSION } from '@/lib/store-submissions/gmail/sync';
import { getRulesSnapshotForPlatform } from '@/lib/store-submissions/queries/rules';

import type { ActionError, ActionResult } from './actions';

// -- Public types --------------------------------------------------------

export type ReclassifyResult = {
  emailMessageId: string;
  changed: boolean;
  previousStatus: string;
  newStatus: string;
  previousTicketId: string | null;
  newTicketId: string | null;
};

export type BulkReclassifyResult = {
  total: number;
  reclassified: number;
  unchanged: number;
  errors: number;
};

export type UnclassifiedBucket = 'app' | 'type' | 'any';

// -- Internal types ------------------------------------------------------

interface EmailRow {
  id: string;
  sender_email: string;
  subject: string;
  raw_body_text: string | null;
  extracted_payload: ExtractedPayload | null;
  classification_result: Record<string, unknown> | null;
  ticket_id: string | null;
}

interface RpcReclassifyResult {
  changed: boolean;
  previous_status: string;
  new_status: string;
  previous_ticket_id: string | null;
  new_ticket_id: string | null;
}

// -- Internal error classes (not exported — 'use server' rule) -----------

class EmailNotFoundError extends Error {
  constructor(emailId: string) {
    super(`Email message ${emailId} does not exist`);
    this.name = 'EmailNotFoundError';
  }
}

class ReclassifyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReclassifyValidationError';
  }
}

// -- Auth helper (MANAGER-only) ------------------------------------------

async function guardManager(): Promise<
  { user: StoreUser } | { error: ActionError }
> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, ['MANAGER']);
    Sentry.setUser({ id: user.id, username: user.role });
    return { user };
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }
}

// -- Core reclassify (re-run classifier + invoke RPC) --------------------

/**
 * Re-classify one email and swap its ticket. Throws on failure; caller
 * maps to ActionError. Used by both the single + bulk public actions.
 */
async function reclassifyOne(
  emailMessageId: string,
  actorId: string,
): Promise<ReclassifyResult> {
  // 1. Load email row.
  const { data: rowData, error: rowErr } = await storeDb()
    .from('email_messages')
    .select(
      'id, sender_email, subject, raw_body_text, extracted_payload, classification_result, ticket_id',
    )
    .eq('id', emailMessageId)
    .maybeSingle();

  if (rowErr) {
    throw new Error(`Failed to load email_messages: ${rowErr.message}`);
  }
  if (!rowData) {
    throw new EmailNotFoundError(emailMessageId);
  }

  const email = rowData as EmailRow;

  // 2. Resolve sender against the *current* registry. A sender that
  //    matched at sync time may since have been removed by a Manager;
  //    in that case the email becomes DROPPED/NO_SENDER_MATCH.
  const senders = await loadActiveSenders();
  const resolve = createSenderResolver(senders);
  const platformRes = resolve(email.sender_email);

  // 3. Build the new classification — full pipeline mirrors sync.ts.
  // Typed as Record<string, unknown> because the ERROR/NO_RULES branch is
  // a sync-layer concern (not in classifier's ErrorCode union); same
  // pragma as sync.ts where classification_result is JSONB-shaped, not
  // strictly typed as ClassificationResult. The RPC validates structure
  // server-side via INVALID_ARG / INVALID_STATUS prefixes.
  let newClassification: Record<string, unknown>;

  if (!platformRes) {
    newClassification = {
      status: 'DROPPED',
      reason: 'NO_SENDER_MATCH',
      classifier_version: CLASSIFIER_VERSION,
    };
  } else {
    const rules = await getRulesSnapshotForPlatform(platformRes.platformId);
    if (!rules) {
      newClassification = {
        status: 'ERROR',
        error_code: 'NO_RULES',
        error_message: `No rules configured for platform ${platformRes.platformKey}`,
        matched_rules: [],
        classifier_version: CLASSIFIER_VERSION,
        platform_id: platformRes.platformId,
        platform_key: platformRes.platformKey,
      };
    } else {
      const input: EmailInput = {
        sender: email.sender_email,
        subject: email.subject,
        body: email.raw_body_text ?? '',
        extracted_payload: email.extracted_payload,
      };
      const c: ClassificationResult = classify(input, rules);
      newClassification = { ...c, classifier_version: CLASSIFIER_VERSION };
    }
  }

  // 4. Call the atomic swap RPC.
  const { data, error } = await storeDb().rpc('reclassify_email_tx', {
    p_email_message_id: emailMessageId,
    p_new_classification: newClassification,
    p_actor_id: actorId,
  });

  if (error) throw mapRpcError(error);
  if (!data) {
    throw new Error('reclassify_email_tx returned no data');
  }

  const out = data as RpcReclassifyResult;
  return {
    emailMessageId,
    changed: out.changed,
    previousStatus: out.previous_status,
    newStatus: out.new_status,
    previousTicketId: out.previous_ticket_id,
    newTicketId: out.new_ticket_id,
  };
}

function mapRpcError(error: PostgrestError): Error {
  const message = error.message ?? 'unknown RPC error';
  if (message.includes('NOT_FOUND')) {
    return new EmailNotFoundError(message);
  }
  if (
    message.includes('INVALID_ARG') ||
    message.includes('INVALID_STATUS') ||
    message.includes('INVALID_OUTCOME')
  ) {
    return new ReclassifyValidationError(message);
  }
  return new Error(`[reclassify] RPC failed: ${message}`);
}

function mapErrorToActionError(err: unknown, emailId: string): ActionError {
  if (err instanceof EmailNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message:
        'This email no longer exists — the list may be stale. Refresh and try again.',
    };
  }
  if (err instanceof ReclassifyValidationError) {
    return { code: 'VALIDATION', message: err.message };
  }
  // Truly unexpected — schema drift, RPC outage, classifier crash.
  console.error('[reclassify-actions] unmapped error:', err);
  Sentry.captureException(err, {
    tags: { component: 'reclassify-actions' },
    extra: { emailMessageId: emailId },
  });
  return {
    code: 'DB_ERROR',
    message:
      'Unexpected error reclassifying email. Please try again.',
  };
}

// -- Public Server Actions ----------------------------------------------

export async function reclassifyEmailMessageAction(
  emailMessageId: string,
): Promise<ActionResult<ReclassifyResult>> {
  if (!emailMessageId || typeof emailMessageId !== 'string') {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'emailMessageId is required' },
    };
  }

  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  try {
    const result = await reclassifyOne(emailMessageId, guard.user.id);
    revalidatePath('/store-submissions/inbox');
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: mapErrorToActionError(err, emailMessageId) };
  }
}

export async function reclassifyUnclassifiedAction(
  bucket: UnclassifiedBucket,
): Promise<ActionResult<BulkReclassifyResult>> {
  if (bucket !== 'app' && bucket !== 'type' && bucket !== 'any') {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'bucket must be app, type, or any',
      },
    };
  }

  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  // Bucket → classification_status filter values.
  const statuses =
    bucket === 'app'
      ? ['UNCLASSIFIED_APP']
      : bucket === 'type'
        ? ['UNCLASSIFIED_TYPE']
        : ['UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'];

  const { data: rows, error: fetchErr } = await storeDb()
    .from('email_messages')
    .select('id')
    .in('classification_status', statuses);

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: { component: 'reclassify-actions', action: 'bulk-fetch' },
      extra: { bucket },
    });
    return {
      ok: false,
      error: {
        code: 'DB_ERROR',
        message: 'Failed to load unclassified emails.',
      },
    };
  }

  const ids = (rows ?? []).map((r) => (r as { id: string }).id);
  const stats: BulkReclassifyResult = {
    total: ids.length,
    reclassified: 0,
    unchanged: 0,
    errors: 0,
  };

  for (const id of ids) {
    try {
      const r = await reclassifyOne(id, guard.user.id);
      if (r.changed) {
        stats.reclassified++;
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      stats.errors++;
      console.error('[reclassify-actions] bulk per-row failure:', {
        id,
        err,
      });
      Sentry.captureException(err, {
        tags: { component: 'reclassify-actions', action: 'bulk-row' },
        extra: { emailMessageId: id, bucket },
      });
      // Continue — one bad row must not abort the batch.
    }
  }

  revalidatePath('/store-submissions/inbox');
  return { ok: true, data: stats };
}
