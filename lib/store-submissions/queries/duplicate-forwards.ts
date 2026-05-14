/**
 * Server-side data fetchers for the /duplicate-forwards audit
 * dashboard (PR-Inbox.ForwardDedup FD.g).
 *
 * **Surface contract.**
 *   - `listDuplicateForwards(windowStart, windowEnd)` — list view rows
 *     (one per DUPLICATE_FORWARD email), with the original email's
 *     ticket_id and key fields embedded via the
 *     `duplicate_of_email_id` foreign key relation.
 *   - `getDuplicateForwardCount(sinceDays)` — Sidebar badge count.
 *     Filters to `received_at` in the last N days (default 30) so
 *     historical noise doesn't anchor the badge at a high number
 *     forever once the cleanup pass lands.
 *   - `getDuplicateForwardPair(duplicateEmailId)` — detail-pane fetch
 *     loading both sides of the dedup relationship in full so the UI
 *     can render side-by-side previews.
 *
 * **Why not embed apps + tickets here.** App names and ticket display
 * ids are resolved by the page component via separate batched fetches
 * (mirrors the Reports module's separation pattern). Keeps each
 * Supabase call narrow + cacheable; keeps this module's join shape
 * easy to type.
 */

import { storeDb } from '../db';

// -- Public types --------------------------------------------------------

export interface DuplicateForwardListRow {
  id: string;
  received_at: string;
  sender_email: string;
  subject: string;
  app_id: string | null;
  outcome: string | null;
  ext_submission_id: string | null;
  duplicate_fingerprint: string | null;
  original: {
    id: string;
    received_at: string;
    sender_email: string;
    ticket_id: string | null;
    app_id: string | null;
  } | null;
}

export interface DuplicateForwardDetailPair {
  duplicate: DuplicateForwardEmail;
  original: DuplicateForwardEmail | null;
}

export interface DuplicateForwardEmail {
  id: string;
  received_at: string;
  sender_email: string;
  sender_name: string | null;
  subject: string;
  raw_body_text: string | null;
  classification_status: string;
  classification_result: Record<string, unknown> | null;
  extracted_payload: Record<string, unknown> | null;
  duplicate_fingerprint: string | null;
  duplicate_of_email_id: string | null;
  ticket_id: string | null;
}

// -- Internal row shapes (Supabase embed output) -------------------------

interface RawListRow {
  id: string;
  received_at: string;
  sender_email: string;
  subject: string;
  classification_result: Record<string, unknown> | null;
  extracted_payload: Record<string, unknown> | null;
  duplicate_fingerprint: string | null;
  // Self-FK embed via `duplicate_of_email_id`. PostgREST returns a
  // single object (not array) because the FK is on the duplicate side
  // and the relationship is many-to-one (each duplicate has at most
  // one original).
  original: {
    id: string;
    received_at: string;
    sender_email: string;
    ticket_id: string | null;
    classification_result: Record<string, unknown> | null;
  } | null;
}

// -- List + count fetchers -----------------------------------------------

/**
 * Fetch DUPLICATE_FORWARD rows within a date window, newest-first,
 * with the original email's id + ticket_id + sender embedded.
 *
 * No top-N cap — production scale is small (~22 pairs/month per
 * Manager Q-Dedup-5). Pagination layer can be added later if scale
 * grows. (Mirrors PR-Reports.A.1 "unbounded listing is fine at this
 * scale" decision.)
 */
export async function listDuplicateForwards(
  windowStart: Date,
  windowEnd: Date,
): Promise<DuplicateForwardListRow[]> {
  const { data, error } = await storeDb()
    .from('email_messages')
    .select(
      `
        id,
        received_at,
        sender_email,
        subject,
        classification_result,
        extracted_payload,
        duplicate_fingerprint,
        original:email_messages!duplicate_of_email_id (
          id,
          received_at,
          sender_email,
          ticket_id,
          classification_result
        )
      `,
    )
    .eq('classification_status', 'DUPLICATE_FORWARD')
    .gte('received_at', windowStart.toISOString())
    .lt('received_at', windowEnd.toISOString())
    .order('received_at', { ascending: false });

  if (error) {
    console.error('[duplicate-forwards] list query failed:', error);
    throw new Error(`Failed to load duplicate forwards: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as RawListRow[];
  return rows.map((r) => {
    const clf = r.classification_result ?? {};
    const ext = r.extracted_payload ?? {};
    return {
      id: r.id,
      received_at: r.received_at,
      sender_email: r.sender_email,
      subject: r.subject,
      app_id: stringOrNull(clf, 'app_id'),
      outcome: stringOrNull(clf, 'outcome'),
      ext_submission_id: stringOrNull(ext, 'submission_id'),
      duplicate_fingerprint: r.duplicate_fingerprint,
      original: r.original
        ? {
            id: r.original.id,
            received_at: r.original.received_at,
            sender_email: r.original.sender_email,
            ticket_id: r.original.ticket_id,
            app_id: stringOrNull(r.original.classification_result ?? {}, 'app_id'),
          }
        : null,
    };
  });
}

/**
 * Count DUPLICATE_FORWARD rows received in the last `sinceDays` days
 * for the Sidebar nav badge. Trailing 30-day window by default so
 * the badge naturally trends toward zero post-cleanup. `head: true`
 * fetches no row data — pure count, page-load cheap.
 */
export async function getDuplicateForwardCount(
  sinceDays = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const { count, error } = await storeDb()
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('classification_status', 'DUPLICATE_FORWARD')
    .gte('received_at', cutoff.toISOString());

  if (error) {
    // Badge is observability — degrade to zero rather than failing
    // the parent page render.
    console.error('[duplicate-forwards] count query failed:', error);
    return 0;
  }
  return count ?? 0;
}

// -- Detail-pane pair fetcher --------------------------------------------

/**
 * Load both sides of a dedup pair for the detail panel. Returns
 * `original: null` when the duplicate's `duplicate_of_email_id` is
 * NULL (cleanup cron purged the original — defensive; rare).
 *
 * Throws on the duplicate-id miss path so the UI can surface a
 * dedicated "email not found" state rather than silently rendering
 * a half-empty panel.
 */
export async function getDuplicateForwardPair(
  duplicateEmailId: string,
): Promise<DuplicateForwardDetailPair> {
  const duplicate = await fetchEmail(duplicateEmailId);
  if (!duplicate) {
    throw new Error(`Duplicate forward email ${duplicateEmailId} not found`);
  }

  let original: DuplicateForwardEmail | null = null;
  if (duplicate.duplicate_of_email_id) {
    original = await fetchEmail(duplicate.duplicate_of_email_id);
  }

  return { duplicate, original };
}

async function fetchEmail(
  id: string,
): Promise<DuplicateForwardEmail | null> {
  const { data, error } = await storeDb()
    .from('email_messages')
    .select(
      `
        id,
        received_at,
        sender_email,
        sender_name,
        subject,
        raw_body_text,
        classification_status,
        classification_result,
        extracted_payload,
        duplicate_fingerprint,
        duplicate_of_email_id,
        ticket_id
      `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[duplicate-forwards] fetch one failed:', error);
    throw new Error(`Failed to load email ${id}: ${error.message}`);
  }
  return (data as DuplicateForwardEmail | null) ?? null;
}

// -- Helpers -------------------------------------------------------------

function stringOrNull(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
