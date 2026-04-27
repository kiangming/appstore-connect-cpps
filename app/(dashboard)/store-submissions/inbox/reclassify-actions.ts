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
 * **Core extracted to `lib/store-submissions/reclassify/core.ts`** in
 * PR-12.5 so the same pipeline can be reused by `backfill-actions.ts`
 * (which prepends a Gmail re-fetch + html-extractor stage). This file
 * stays the Server Action shell — auth, ActionResult mapping, revalidate.
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
import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  requireStoreRole,
  StoreForbiddenError,
  StoreUnauthorizedError,
  type StoreUser,
} from '@/lib/store-submissions/auth';
import { storeDb } from '@/lib/store-submissions/db';
import {
  EmailNotFoundError,
  ReclassifyValidationError,
  reclassifyOne,
  type ReclassifyResult,
} from '@/lib/store-submissions/reclassify/core';

import type { ActionError, ActionResult } from './actions';

// -- Public types --------------------------------------------------------

// Re-export so client components keep the same import path post-refactor.
export type { ReclassifyResult };

export type BulkReclassifyResult = {
  total: number;
  reclassified: number;
  unchanged: number;
  errors: number;
};

export type UnclassifiedBucket = 'app' | 'type' | 'any';

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

// -- Error mapping -------------------------------------------------------

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
