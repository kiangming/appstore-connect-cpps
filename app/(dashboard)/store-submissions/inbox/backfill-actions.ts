'use server';

/**
 * Server Actions for MANAGER-triggered backfill of UNCLASSIFIED Apple
 * emails (PR-12.5).
 *
 * Re-fetches Gmail HTML for rows missing `extracted_payload`, runs the
 * html-extractor (PR-12.1), persists the structured payload + the
 * (possibly corrected) raw body text, then triggers `reclassify_email_tx`
 * atomic via `reclassifyOne` from the shared reclassify core. Apple-only
 * initially (D2); multi-platform deferred PR-13+.
 *
 * Two actions (this file):
 *   - `backfillSingleEmailAction(emailId)` — explicit single-row backfill.
 *     Server-side guard verifies the email exists + sender resolves to
 *     Apple. Used by future per-row affordances; the UI's "Test 1 row"
 *     button uses the bulk action with `limit: 1`.
 *
 *   - `backfillUnclassifiedAction({ limit? })` — bulk over UNCLASSIFIED
 *     Apple rows where `extracted_payload IS NULL`. Sequential per-row
 *     (Q4: prod scale ~14 rows × ~200ms = ~3s, no rate limit needed).
 *     Per-row failures are captured, counted, and the batch continues.
 *     Optional `limit` lets the UI run a 1-row dry-run for production
 *     safety before bulk.
 *
 * Sibling: `backfill-corrupt-actions.ts` ships
 * `backfillCorruptPayloadAction` for the PR-14 "extracted_payload was
 * computed by the buggy decoder" cleanup. Both files share
 * `lib/store-submissions/backfill/core.ts`, where the per-row pipeline,
 * sender filter, error classes, and error mapping live.
 *
 * **Sentry telemetry** under `component: 'backfill-action'` (set in
 * `guardManager` below). Per-row breadcrumbs + per-stage exception
 * tags are emitted from the shared `core.ts` module so both action
 * files produce uniform telemetry.
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
import {
  backfillOne,
  createBackfillGmailClient,
  loadAppleSenderFilter,
  mapErrorToActionError,
  type BackfillBulkOptions,
  type BackfillContext,
  type BackfillResult,
  type BulkBackfillResult,
} from '@/lib/store-submissions/backfill/core';
import { storeDb } from '@/lib/store-submissions/db';

import type { ActionError, ActionResult } from './actions';

// -- Auth helper (MANAGER-only) ------------------------------------------

async function guardManager(): Promise<
  { user: StoreUser } | { error: ActionError }
> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, ['MANAGER']);
    Sentry.setUser({ id: user.id, username: user.role });
    Sentry.setTag('component', 'backfill-action');
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

// -- Public Server Actions ----------------------------------------------

export async function backfillSingleEmailAction(
  emailMessageId: string,
): Promise<ActionResult<BackfillResult>> {
  if (!emailMessageId || typeof emailMessageId !== 'string') {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'emailMessageId is required' },
    };
  }

  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const filter = await loadAppleSenderFilter();
  if (!filter) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'No Apple senders configured — backfill not applicable.',
      },
    };
  }

  const clientResult = await createBackfillGmailClient();
  if ('error' in clientResult) {
    return { ok: false, error: clientResult.error };
  }

  try {
    const result = await backfillOne(emailMessageId, guard.user.id, {
      gmailClient: clientResult.client,
      isAppleSender: filter.isAppleSender,
    });
    revalidatePath('/store-submissions/inbox');
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: mapErrorToActionError(err, emailMessageId) };
  }
}

export async function backfillUnclassifiedAction(
  options: BackfillBulkOptions = {},
): Promise<ActionResult<BulkBackfillResult>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  // Validate limit defensively — UI passes 1 or undefined; reject other
  // shapes to keep the contract narrow.
  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'limit must be a positive integer or omitted',
      },
    };
  }

  const filter = await loadAppleSenderFilter();
  const stats: BulkBackfillResult = {
    total: 0,
    processed: 0,
    reclassified: 0,
    unchanged: 0,
    errors: [],
  };

  if (!filter) {
    // No Apple senders configured — nothing to backfill.
    return { ok: true, data: stats };
  }

  // Find candidates: UNCLASSIFIED + extracted_payload IS NULL + Apple sender.
  let query = storeDb()
    .from('email_messages')
    .select('id')
    .in('classification_status', ['UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'])
    .is('extracted_payload', null)
    .in('sender_email', filter.appleEmails)
    .order('received_at', { ascending: true });

  if (limit !== undefined) {
    query = query.limit(limit);
  }

  const { data: rows, error: fetchErr } = await query;

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: { component: 'backfill-action', stage: 'fetch-candidates' },
    });
    return {
      ok: false,
      error: {
        code: 'DB_ERROR',
        message: 'Failed to load candidate emails.',
      },
    };
  }

  const ids = (rows ?? []).map((r) => (r as { id: string }).id);
  stats.total = ids.length;

  if (ids.length === 0) {
    return { ok: true, data: stats };
  }

  const clientResult = await createBackfillGmailClient();
  if ('error' in clientResult) {
    return { ok: false, error: clientResult.error };
  }

  const ctx: BackfillContext = {
    gmailClient: clientResult.client,
    isAppleSender: filter.isAppleSender,
  };

  for (const id of ids) {
    try {
      const result = await backfillOne(id, guard.user.id, ctx);
      stats.processed++;
      if (result.reclassify.changed) {
        stats.reclassified++;
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.errors.push({ emailMessageId: id, error: message });
      console.error('[backfill-action] bulk per-row failure:', { id, err });
      Sentry.captureException(err, {
        tags: { component: 'backfill-action', stage: 'bulk-row' },
        extra: { emailMessageId: id },
      });
      // Continue — one bad row must not abort the batch.
    }
  }

  revalidatePath('/store-submissions/inbox');
  return { ok: true, data: stats };
}
