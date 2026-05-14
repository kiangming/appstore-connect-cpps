/**
 * Single-email reclassification pipeline (PR-12.5 extraction).
 *
 * Plain async helpers shared between two Server Action files:
 *   - `app/(dashboard)/store-submissions/inbox/reclassify-actions.ts` —
 *     Manager-triggered reclassify of an existing email row (PR-11.5)
 *   - `app/(dashboard)/store-submissions/inbox/backfill-actions.ts` —
 *     Manager-triggered HTML re-extract + reclassify pipeline for the
 *     14 legacy UNCLASSIFIED Apple rows that pre-date PR-11.3 (PR-12.5)
 *
 * Both call sites need to: load the persisted email, re-run the
 * classifier with the **current** rules + `extracted_payload`, and
 * atomically swap the ticket via `reclassify_email_tx` RPC.
 *
 * **Why a non-`'use server'` module.** A `'use server'` file may only
 * export async functions — internal helpers cannot be exported (Next.js
 * lessons-learned trap #2 in CLAUDE.md). To share `reclassifyOne` across
 * Server Action files we factor it out here as a plain helper that both
 * import. The Server Action shells in the `app/` tree handle session
 * guards + ActionResult mapping; this module stays I/O-pure-ish (DB +
 * RPC, no auth).
 *
 * Lock order + atomicity guarantees come from the RPC, not from this
 * module — see `supabase/migrations/20260425000002_store_mgmt_reclassify_rpc.sql`.
 */

import type { PostgrestError } from '@supabase/supabase-js';

import { classify } from '../classifier';
import type {
  ClassificationResult,
  EmailInput,
} from '../classifier/types';
import { storeDb } from '../db';
import type { ExtractedPayload } from '../gmail/html-extractor';
import {
  createSenderResolver,
  loadActiveSenders,
} from '../gmail/sender-resolver';
import { CLASSIFIER_VERSION } from '../gmail/sync';
import { getRulesSnapshotForPlatform } from '../queries/rules';

// -- Public types --------------------------------------------------------

export interface ReclassifyResult {
  emailMessageId: string;
  changed: boolean;
  previousStatus: string;
  newStatus: string;
  previousTicketId: string | null;
  newTicketId: string | null;
}

// -- Public error classes ------------------------------------------------

export class EmailNotFoundError extends Error {
  constructor(emailId: string) {
    super(`Email message ${emailId} does not exist`);
    this.name = 'EmailNotFoundError';
  }
}

export class ReclassifyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReclassifyValidationError';
  }
}

/**
 * PR-Inbox.ForwardDedup. Thrown when reclassify is invoked on a row
 * that the upstream dedup gate (or historical backfill migration)
 * marked `classification_status = 'DUPLICATE_FORWARD'`. The original
 * (rn=1) row carries the canonical ticket attachment; re-classifying
 * a duplicate would either no-op (current state is terminal) or
 * risk creating a divergent reattach path. Manager Q10 LOCKED
 * Option I: refuse, surface the original's id, point Manager at it.
 *
 * `originalEmailId` is the `duplicate_of_email_id` value (NULL only
 * if a future cleanup cron purged the original — message text
 * adapts).
 */
export class DuplicateForwardRefusedError extends Error {
  readonly originalEmailId: string | null;
  constructor(emailId: string, originalEmailId: string | null) {
    const target = originalEmailId
      ? `the original email (${originalEmailId})`
      : 'the original email (no longer available)';
    super(
      `This email (${emailId}) was deduplicated as a forwarded copy. To reclassify, action ${target}.`,
    );
    this.name = 'DuplicateForwardRefusedError';
    this.originalEmailId = originalEmailId;
  }
}

// -- Internal types ------------------------------------------------------

interface EmailRow {
  id: string;
  sender_email: string;
  subject: string;
  raw_body_text: string | null;
  extracted_payload: ExtractedPayload | null;
  classification_result: Record<string, unknown> | null;
  ticket_id: string | null;
  classification_status: string;
  duplicate_of_email_id: string | null;
}

interface RpcReclassifyResult {
  changed: boolean;
  previous_status: string;
  new_status: string;
  previous_ticket_id: string | null;
  new_ticket_id: string | null;
}

// -- Core implementation -------------------------------------------------

/**
 * Re-classify one email and swap its ticket. Throws on failure; caller
 * (Server Action wrapper) maps to ActionError. Used by both single + bulk
 * reclassify and by the PR-12.5 backfill pipeline.
 *
 * Pipeline mirrors `gmail/sync.ts processMessage` with one difference:
 * sender resolution uses the **current** active senders registry. A
 * sender that matched at sync time may since have been removed by a
 * Manager; in that case the email becomes DROPPED/NO_SENDER_MATCH on
 * reclassify.
 */
export async function reclassifyOne(
  emailMessageId: string,
  actorId: string,
): Promise<ReclassifyResult> {
  // 1. Load email row.
  const { data: rowData, error: rowErr } = await storeDb()
    .from('email_messages')
    .select(
      'id, sender_email, subject, raw_body_text, extracted_payload, classification_result, ticket_id, classification_status, duplicate_of_email_id',
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

  // 1.5 PR-Inbox.ForwardDedup. Refuse before any classifier/RPC work
  //     on rows the dedup gate marked as forwarded copies. Manager
  //     Q10 LOCKED Option I — predictable refusal beats surprising
  //     a Manager who clicked Reclassify expecting "rerun on this
  //     email" but actually rerunning on a duplicate could attempt
  //     to reattach the wrong row to a new ticket.
  if (email.classification_status === 'DUPLICATE_FORWARD') {
    throw new DuplicateForwardRefusedError(
      emailMessageId,
      email.duplicate_of_email_id,
    );
  }

  // 2. Resolve sender against the *current* registry.
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

/**
 * Map RPC error codes from `reclassify_email_tx` PL/pgSQL into typed
 * exceptions. Exposed so consumers can `instanceof`-check without
 * coupling to the SQL-level error string format.
 */
export function mapRpcError(error: PostgrestError): Error {
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
