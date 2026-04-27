'use server';

/**
 * Server Actions for MANAGER-triggered backfill of UNCLASSIFIED Apple
 * emails (PR-12.5).
 *
 * Re-fetches Gmail HTML for rows missing `extracted_payload`, runs the
 * html-extractor (PR-12.1), persists the structured payload, then triggers
 * `reclassify_email_tx` atomic via `reclassifyOne` from the shared core
 * module. Apple-only initially (D2); multi-platform deferred PR-13+.
 *
 * Two actions:
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
 * **Production state context (2026-04):**
 *   - 14 legacy UNCLASSIFIED rows pre-PR-11.3 (extracted_payload NULL)
 *   - 0 Apple emails arrived post-deploy (wire untested in production)
 *   - Single-row test mode is the production-safety verification step
 *     before the bulk run; both buttons share this code path.
 *
 * **Sentry telemetry** under `component: 'backfill-action'`:
 *   - per-row breadcrumbs: fetch-start / html-extracted / extract-result /
 *     reclassify-result
 *   - per-stage exceptions tagged with `stage: gmail-fetch | extract |
 *     reclassify | bulk-row | unmapped` so production failures pinpoint
 *     the exact pipeline step
 *
 * Atomicity: the UPDATE `extracted_payload` and the subsequent
 * reclassify happen in two SQL round-trips, not one transaction.
 * `reclassify_email_tx` re-loads the row under FOR UPDATE so a concurrent
 * sync run can't observe a half-updated row, and UNIQUE(gmail_msg_id)
 * already prevents duplicate ingestion. The brief window between UPDATE
 * and reclassify is bounded to ~50ms — Manager-driven, not high-frequency.
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
  createGmailClient,
  getMessage,
  type GmailClient,
} from '@/lib/store-submissions/gmail/client';
import {
  extractApple,
  type ExtractedPayload,
} from '@/lib/store-submissions/gmail/html-extractor';
import { parseGmailMessage } from '@/lib/store-submissions/gmail/parser';
import {
  createSenderResolver,
  loadActiveSenders,
} from '@/lib/store-submissions/gmail/sender-resolver';
import {
  EmailNotFoundError,
  ReclassifyValidationError,
  reclassifyOne,
  type ReclassifyResult,
} from '@/lib/store-submissions/reclassify/core';

import type { ActionError, ActionResult } from './actions';

// -- Public types --------------------------------------------------------

export interface BackfillResult {
  emailMessageId: string;
  /** Outcome from the freshly-extracted payload. */
  outcome: 'ACCEPTED' | 'REJECTED' | null;
  /** Number of `items[]` parsed from HTML. */
  itemsCount: number;
  /** Reclassify outcome — `changed: false` means the new classification
   *  matched the old (e.g. payload was usable but resolved the same
   *  type/app already on file). */
  reclassify: ReclassifyResult;
}

export interface BulkBackfillError {
  emailMessageId: string;
  error: string;
}

export interface BulkBackfillResult {
  /** Total candidates found (before per-row processing). */
  total: number;
  /** Successfully processed (extract + reclassify completed). */
  processed: number;
  /** Subset of `processed` where reclassify_email_tx returned changed=true. */
  reclassified: number;
  /** Subset of `processed` where the new classification matched the old. */
  unchanged: number;
  /** Per-row failures — batch continues past each. */
  errors: BulkBackfillError[];
}

export interface BackfillBulkOptions {
  /** Cap candidates to N for production-safety dry-runs. Omit for full bulk. */
  limit?: number;
}

// -- Internal error classes (not exported per 'use server' rule) ---------

class NotApplePlatformError extends Error {
  constructor(emailId: string) {
    super(`Email ${emailId} is not from an Apple sender — backfill is Apple-only`);
    this.name = 'NotApplePlatformError';
  }
}

class GmailFetchError extends Error {
  constructor(emailId: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to re-fetch Gmail message for email ${emailId}: ${causeMsg}`);
    this.name = 'GmailFetchError';
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

// -- Per-row backfill pipeline ------------------------------------------

interface BackfillContext {
  gmailClient: GmailClient;
  isAppleSender: (email: string) => boolean;
}

interface EmailLookupRow {
  id: string;
  gmail_msg_id: string;
  sender_email: string;
}

/**
 * Re-fetch Gmail HTML for one persisted email row, run extractApple,
 * UPDATE extracted_payload, then call reclassifyOne for atomic ticket
 * swap. Throws on any failure; caller maps to ActionError or accumulates
 * in bulk mode.
 */
async function backfillOne(
  emailMessageId: string,
  actorId: string,
  ctx: BackfillContext,
): Promise<BackfillResult> {
  Sentry.addBreadcrumb({
    category: 'backfill',
    level: 'info',
    message: 'fetch-start',
    data: { emailMessageId },
  });

  // 1. Load row to get gmail_msg_id + sender (subject pulled fresh from
  //    Gmail in step 2; the persisted subject may be stale if the user
  //    edited it via Gmail label/reply, though Apple emails are static).
  const { data: rowData, error: rowErr } = await storeDb()
    .from('email_messages')
    .select('id, gmail_msg_id, sender_email')
    .eq('id', emailMessageId)
    .maybeSingle();

  if (rowErr) {
    throw new Error(`Failed to load email_messages: ${rowErr.message}`);
  }
  if (!rowData) {
    throw new EmailNotFoundError(emailMessageId);
  }

  const row = rowData as EmailLookupRow;
  if (!ctx.isAppleSender(row.sender_email)) {
    throw new NotApplePlatformError(emailMessageId);
  }

  // 2. Re-fetch Gmail HTML. Both `getMessage` and `parseGmailMessage`
  //    can throw — wrap together so the caller's error surface is one
  //    typed `GmailFetchError` regardless of which step failed.
  let parsedSubject: string;
  let parsedBodyHtml: string | undefined;
  try {
    const raw = await getMessage(ctx.gmailClient, row.gmail_msg_id);
    const parsed = parseGmailMessage(raw);
    parsedSubject = parsed.subject;
    parsedBodyHtml = parsed.bodyHtml;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'backfill-action', stage: 'gmail-fetch' },
      extra: { emailMessageId, gmailMsgId: row.gmail_msg_id },
    });
    throw new GmailFetchError(emailMessageId, err);
  }

  Sentry.addBreadcrumb({
    category: 'backfill',
    level: 'info',
    message: 'html-extracted',
    data: {
      emailMessageId,
      htmlSize: parsedBodyHtml?.length ?? 0,
    },
  });

  // 3. Run extractor with subject (PR-12 rejection branch detection).
  const payload: ExtractedPayload = extractApple(
    parsedBodyHtml,
    parsedSubject,
  );

  Sentry.addBreadcrumb({
    category: 'backfill',
    level: 'info',
    message: 'extract-result',
    data: {
      emailMessageId,
      outcome: payload.outcome,
      itemsCount: payload.items.length,
      itemTypes: payload.items.map((i) => i.type),
    },
  });

  // 4. Persist extracted_payload. The reclassify step below will load
  //    the row again with the fresh payload and atomically swap the
  //    ticket via RPC. Classification stays untouched here — the RPC
  //    handles the transition.
  const { error: updateErr } = await storeDb()
    .from('email_messages')
    .update({ extracted_payload: payload })
    .eq('id', emailMessageId);

  if (updateErr) {
    throw new Error(
      `Failed to persist extracted_payload: ${updateErr.message}`,
    );
  }

  // 5. Reclassify (re-uses existing pipeline + atomic RPC).
  const reclassify = await reclassifyOne(emailMessageId, actorId);

  Sentry.addBreadcrumb({
    category: 'backfill',
    level: 'info',
    message: 'reclassify-result',
    data: {
      emailMessageId,
      changed: reclassify.changed,
      previousStatus: reclassify.previousStatus,
      newStatus: reclassify.newStatus,
    },
  });

  return {
    emailMessageId,
    outcome: payload.outcome,
    itemsCount: payload.items.length,
    reclassify,
  };
}

// -- Helpers (sender filter) --------------------------------------------

/**
 * Build the Apple-sender predicate + email list used to filter
 * candidates. Returns `null` when no Apple senders are configured —
 * caller short-circuits with empty result.
 */
async function loadAppleSenderFilter(): Promise<
  | { isAppleSender: (email: string) => boolean; appleEmails: string[] }
  | null
> {
  const senders = await loadActiveSenders();
  const resolve = createSenderResolver(senders);
  const isAppleSender = (email: string) =>
    resolve(email)?.platformKey === 'apple';
  const appleEmails = senders
    .filter((s) => s.platformKey === 'apple')
    .map((s) => s.email);
  if (appleEmails.length === 0) return null;
  return { isAppleSender, appleEmails };
}

// -- Error mapping ------------------------------------------------------

function mapErrorToActionError(err: unknown, emailId: string): ActionError {
  if (err instanceof EmailNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message:
        'This email no longer exists — the list may be stale. Refresh and try again.',
    };
  }
  if (err instanceof NotApplePlatformError) {
    return {
      code: 'VALIDATION',
      message:
        'Backfill is Apple-only — this email is from a non-Apple sender.',
    };
  }
  if (err instanceof GmailFetchError) {
    return { code: 'DB_ERROR', message: err.message };
  }
  if (err instanceof ReclassifyValidationError) {
    return { code: 'VALIDATION', message: err.message };
  }
  console.error('[backfill-action] unmapped error:', err);
  Sentry.captureException(err, {
    tags: { component: 'backfill-action', stage: 'unmapped' },
    extra: { emailMessageId: emailId },
  });
  return {
    code: 'DB_ERROR',
    message: 'Unexpected error during backfill. Please try again.',
  };
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

  let gmailClient: GmailClient;
  try {
    gmailClient = await createGmailClient();
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'backfill-action', stage: 'gmail-client' },
    });
    return {
      ok: false,
      error: {
        code: 'DB_ERROR',
        message: 'Failed to create Gmail client. Check Gmail connection.',
      },
    };
  }

  try {
    const result = await backfillOne(emailMessageId, guard.user.id, {
      gmailClient,
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

  let gmailClient: GmailClient;
  try {
    gmailClient = await createGmailClient();
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'backfill-action', stage: 'gmail-client' },
    });
    return {
      ok: false,
      error: {
        code: 'DB_ERROR',
        message: 'Failed to create Gmail client. Check Gmail connection.',
      },
    };
  }

  const ctx: BackfillContext = {
    gmailClient,
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
