/**
 * Per-row backfill pipeline (PR-14.4 extraction).
 *
 * Plain async helpers shared between two Server Action files:
 *   - `app/(dashboard)/store-submissions/inbox/backfill-actions.ts` —
 *     Manager-triggered HTML re-extract for legacy UNCLASSIFIED Apple
 *     rows that never received an `extracted_payload` (PR-12.5)
 *   - `app/(dashboard)/store-submissions/inbox/backfill-corrupt-actions.ts` —
 *     Manager-triggered repair for CLASSIFIED Apple rows whose
 *     `extracted_payload` and `raw_body_text` were corrupted by the
 *     pre-PR-14 byte-mask QP decoder bug (PR-14.4)
 *
 * Both call sites need to: load the persisted email, re-fetch from
 * Gmail, re-parse with the **current** parser (now byte-level QP-safe
 * post-PR-14.2), re-run `extractApple`, persist BOTH the corrected
 * `raw_body_text` and the new `extracted_payload`, then atomically
 * swap the ticket via `reclassify_email_tx`.
 *
 * **Why a non-`'use server'` module.** A `'use server'` file may only
 * export async functions — internal helpers, error classes, and
 * synchronous mappers cannot be exported (Next.js trap #2 in
 * CLAUDE.md). To share `backfillOne` + helpers across Server Action
 * files we factor them out here as plain helpers; the action shells
 * in the `app/` tree handle session guards + ActionResult mapping.
 *
 * Atomicity: the UPDATE (raw_body_text + extracted_payload) and the
 * subsequent reclassify happen in two SQL round-trips, not one
 * transaction. `reclassify_email_tx` re-loads the row under FOR
 * UPDATE so a concurrent sync run can't observe a half-updated row.
 * The brief window between UPDATE and reclassify is bounded to ~50ms
 * — Manager-driven, not high-frequency.
 */

import * as Sentry from '@sentry/nextjs';

import { storeDb } from '../db';
import {
  createGmailClient,
  getMessage,
  type GmailClient,
} from '../gmail/client';
import {
  extractApple,
  type ExtractedPayload,
} from '../gmail/html-extractor';
import { parseGmailMessage } from '../gmail/parser';
import {
  createSenderResolver,
  loadActiveSenders,
} from '../gmail/sender-resolver';
import {
  EmailNotFoundError,
  ReclassifyValidationError,
  reclassifyOne,
  type ReclassifyResult,
} from '../reclassify/core';

import type { ActionError } from '@/app/(dashboard)/store-submissions/inbox/actions';

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

export interface BackfillContext {
  gmailClient: GmailClient;
  isAppleSender: (email: string) => boolean;
}

// -- Public error classes (exported so action files can instanceof) -----

export class NotApplePlatformError extends Error {
  constructor(emailId: string) {
    super(`Email ${emailId} is not from an Apple sender — backfill is Apple-only`);
    this.name = 'NotApplePlatformError';
  }
}

export class GmailFetchError extends Error {
  constructor(emailId: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to re-fetch Gmail message for email ${emailId}: ${causeMsg}`);
    this.name = 'GmailFetchError';
  }
}

// -- Internal types ------------------------------------------------------

interface EmailLookupRow {
  id: string;
  gmail_msg_id: string;
  sender_email: string;
}

// -- Public pipeline -----------------------------------------------------

/**
 * Re-fetch Gmail HTML for one persisted email row, run extractApple,
 * UPDATE both `raw_body_text` and `extracted_payload`, then call
 * `reclassifyOne` for the atomic ticket swap. Throws on any failure;
 * caller maps to ActionError or accumulates in bulk mode.
 *
 * The dual UPDATE was added in PR-14.4 — pre-PR-14.2 emails could have
 * a corrupted `raw_body_text` from the byte-mask QP decoder bug, and
 * the only way to repair it is to re-parse with the fixed decoder.
 * For NULL-payload backfill rows (PR-12.5 use case) the new
 * `raw_body_text` will usually equal the old one — a harmless rewrite
 * that also incidentally repairs any row in the intersection of the
 * two bug populations.
 */
export async function backfillOne(
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
  let parsedBody: string;
  let parsedBodyHtml: string | undefined;
  try {
    const raw = await getMessage(ctx.gmailClient, row.gmail_msg_id);
    const parsed = parseGmailMessage(raw);
    parsedSubject = parsed.subject;
    parsedBody = parsed.body;
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
      bodyLen: parsedBody.length,
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

  // 4. Persist both `raw_body_text` (corrected by the byte-level QP
  //    decoder, PR-14.2) and `extracted_payload` (re-extracted from
  //    the now-correct HTML body). The reclassify step below will
  //    load the row again with the fresh payload and atomically swap
  //    the ticket via RPC. Classification stays untouched here — the
  //    RPC handles the transition.
  const { error: updateErr } = await storeDb()
    .from('email_messages')
    .update({
      raw_body_text: parsedBody,
      extracted_payload: payload,
    })
    .eq('id', emailMessageId);

  if (updateErr) {
    throw new Error(
      `Failed to persist body + payload: ${updateErr.message}`,
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
 * caller short-circuits with an empty result.
 */
export async function loadAppleSenderFilter(): Promise<
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

/**
 * Create a Gmail client with friendly error mapping. Centralized so
 * both action files share the same surface.
 */
export async function createBackfillGmailClient(): Promise<
  { client: GmailClient } | { error: ActionError }
> {
  try {
    const client = await createGmailClient();
    return { client };
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'backfill-action', stage: 'gmail-client' },
    });
    return {
      error: {
        code: 'DB_ERROR',
        message: 'Failed to create Gmail client. Check Gmail connection.',
      },
    };
  }
}

// -- Error mapping ------------------------------------------------------

export function mapErrorToActionError(
  err: unknown,
  emailId: string,
): ActionError {
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
