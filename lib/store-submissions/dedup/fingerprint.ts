/**
 * Forward-dedup fingerprint composer (PR-Inbox.ForwardDedup, FD.d).
 *
 * **Why this module exists.** Manager added two Gmail forwarder
 * accounts on 2026-05-06, joining the original direct recipient — three
 * admin accounts now auto-forward every Apple notification into the
 * shared mailbox. Each forwarded copy arrives as a distinct
 * `gmail_msg_id`, so `UNIQUE(gmail_msg_id)` doesn't catch it; the
 * `find_or_create_ticket_tx` open-states predicate
 * (`state IN 'NEW','IN_REVIEW','REJECTED'`) incidentally absorbs
 * REJECTED forwards into the existing open ticket, but APPROVED
 * forwards land new tickets once the first forward closes/auto-DONEs
 * the prior one. Structural N-way duplication.
 *
 * **What this module does.** Given a freshly-classified email's
 * classification result + HTML-extractor payload + resolved platform
 * key, returns either:
 *   - a deterministic `string` fingerprint suitable for ±5min window
 *     lookup, OR
 *   - `null` to signal "don't dedup — proceed normal flow".
 *
 * **Composition (Manager Q4 LOCKED 2026-05-14).** Pipe-joined fields:
 *
 *     {platform_id}|{app_id}|{type_id}|{outcome}|{ext_submission_id}|{version_or_empty}
 *
 *   - `platform_id`, `app_id`, `type_id`, `outcome` come from the
 *     classifier (already normalized — Fwd-prefix in raw subject
 *     can't change them).
 *   - `ext_submission_id` is the Apple HTML-extractor's `submission_id`
 *     (`<extracted_payload>.submission_id`), NOT the classifier's
 *     subject-pattern named-group capture. Extractor anchors on the
 *     `Submission ID: <uuid>` body label which is identical across
 *     forwarders; classifier subject regex may capture stale values
 *     across template revisions.
 *   - `version` is the optional fallback (Manager Q3). Populated only
 *     when the extracted payload carries an `APP_VERSION` item;
 *     empty string for CPP / IAE / PPO / UNKNOWN. Slot is always
 *     present in the fingerprint string so two emails of the same
 *     `submission_id` but different APP_VERSION revisions don't
 *     collide (defensive — Apple's submission_id is per-version so
 *     this should never happen, but the slot costs nothing).
 *
 * **Skip conditions (return `null`).** All three must be true to
 * proceed with a fingerprint; any one false → null:
 *   - `platformKey === 'apple'` (Manager Q12 — Phase 1 Apple-only)
 *   - `classification.status === 'CLASSIFIED'` (UNCLASSIFIED_* rows
 *     already merge into bucket tickets via the find-or-create
 *     `(v_app_id IS NULL AND app_id IS NULL)` predicate, so they
 *     don't suffer the duplication pattern)
 *   - `extractedPayload?.submission_id` non-empty (without an anchor
 *     UUID the fingerprint has no identity — better to let the
 *     normal flow run than risk a false-positive collapse)
 *
 * **Format stability.** The string format MUST match the PL/pgSQL
 * fingerprint computed in
 * `20260514000000_store_mgmt_pr_inbox_forward_dedup.sql` step 3
 * (backfill). If you change separator or field order here, update
 * the migration and write a follow-up that re-computes
 * `duplicate_fingerprint` on every Apple CLASSIFIED row — otherwise
 * historical originals are unfindable by the runtime gate.
 *
 * **Pure.** No I/O, no DB, no logging. Sentry alerting on
 * fingerprint-mismatch anomalies (if added later) belongs at the
 * call site.
 */

import type { ExtractedPayload } from '../gmail/html-extractor';
import type {
  ClassificationResult,
  PlatformKey,
} from '../classifier/types';

/** Pipe separator between fingerprint slots. UUIDs, enum outcomes,
 *  and dotted version strings cannot legally contain `|`, so the
 *  separator is unambiguous without escaping. */
const SEP = '|';

export interface ComputeFingerprintArgs {
  classification: ClassificationResult;
  extractedPayload: ExtractedPayload | null;
  platformKey: PlatformKey;
}

/**
 * Returns the dedup fingerprint string, or `null` to signal the
 * runtime gate to skip this email and proceed with the normal
 * ticket-wire flow.
 *
 * See module doc for skip conditions and composition rules.
 */
export function computeFingerprint(
  args: ComputeFingerprintArgs,
): string | null {
  const { classification, extractedPayload, platformKey } = args;

  if (platformKey !== 'apple') return null;
  if (classification.status !== 'CLASSIFIED') return null;

  const extSubmissionId = extractedPayload?.submission_id;
  if (!extSubmissionId) return null;

  const version = extractVersionFromItems(extractedPayload);

  return [
    classification.platform_id,
    classification.app_id,
    classification.type_id,
    classification.outcome,
    extSubmissionId,
    version ?? '',
  ].join(SEP);
}

/**
 * Pull the `version` field off the first APP_VERSION item, if any.
 * Returns `null` when the payload has no APP_VERSION item (CPP, IAE,
 * PPO submissions) or when the APP_VERSION item lacks an explicit
 * `version` (malformed Apple HTML — extractor preserved heading but
 * couldn't parse "X.Y.Z for OS").
 *
 * Apple emits at most one APP_VERSION item per submission email; we
 * take the first match defensively.
 */
function extractVersionFromItems(
  payload: ExtractedPayload | null,
): string | null {
  if (!payload) return null;
  for (const item of payload.items) {
    if (item.type === 'APP_VERSION' && item.version) {
      return item.version;
    }
  }
  return null;
}
