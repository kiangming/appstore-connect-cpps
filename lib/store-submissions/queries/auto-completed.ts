/**
 * PR-16b: queries backing the auto-completed Inbox banner +
 * dedicated /inbox/auto-completed view.
 *
 * Both delegate to PL/pgSQL RPCs (migration 20260503000000) that
 * encapsulate the "latest STATE_CHANGE = system + auto_mark_done"
 * filter — Postgres can use the
 * `idx_store_mgmt_ticket_entries_ticket_created` index for the
 * per-ticket subquery; PostgREST chains can't express the same
 * subquery without a SQL VIEW.
 *
 * Filter semantics distinguish auto-DONE from Manager-marked-DONE:
 * `metadata->>'actor' = 'system'` is set only by find_or_create_ticket_tx
 * auto-DONE branch (PR-16a.2 / migration 20260502000002), never by
 * mark_done_ticket_tx (PR-10c). A Manager re-touching an auto-DONE
 * ticket appends a fresh STATE_CHANGE with their actor_id; the
 * "latest entry" check then fails — auto-DONE eligibility is lost,
 * matching Q2 design intent.
 */

import type { TicketListRow } from './tickets';

import { storeDb } from '../db';

/**
 * Banner count probe. Returns 0 on error to keep the Inbox page
 * render path resilient (matches PR-14.4 corrupt-payload precedent).
 *
 * Default 7-day window per PR-16 design Q1.E. Caller can override —
 * unused trong production today, kept cho test ergonomics.
 */
export async function getAutoCompletedCount(days = 7): Promise<number> {
  const { data, error } = await storeDb().rpc('count_auto_completed_tickets', {
    p_days: days,
  });

  if (error) {
    console.error('[getAutoCompletedCount] RPC failed:', error);
    return 0;
  }

  // RPC returns BIGINT — supabase-js may surface as string OR number
  // depending on driver version. Coerce defensively.
  const n = typeof data === 'string' ? Number.parseInt(data, 10) : Number(data);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Dedicated view list. Returns TicketListRow shape directly because
 * the RPC does the joins server-side; consumer can render trong
 * TicketListTable without a second-pass enrichment.
 */
export async function listAutoCompleted(
  opts: { days?: number; limit?: number } = {},
): Promise<TicketListRow[]> {
  const { days = 7, limit = 100 } = opts;

  const { data, error } = await storeDb().rpc('list_auto_completed_tickets', {
    p_days: days,
    p_limit: limit,
  });

  if (error) {
    console.error('[listAutoCompleted] RPC failed:', error);
    throw new Error('Failed to load auto-completed tickets');
  }

  // RPC returns TABLE rows shaped to match TicketListRow. The cast is
  // safe because the SQL signature pins every field — the migration's
  // RETURNS TABLE list is the source of truth. `first_email` is
  // intentionally omitted (the dedicated view doesn't render
  // unclassified-bucket fallbacks; all auto-completed tickets are
  // CLASSIFIED by definition of Q5.D + Q6.A).
  return (data ?? []) as unknown as TicketListRow[];
}
