/**
 * Pure helpers for rule-snapshot manipulation. No DB, no I/O, no async.
 *
 * Lives outside the `'use server'` actions file because Next.js requires
 * every export in a `'use server'` module to be an async function — sync
 * helpers must move here so they remain importable from Server Actions,
 * Route Handlers, and client components alike.
 */

import { configSnapshotSchema } from '@/lib/store-submissions/schemas/rules';

/**
 * Row counts per rule type, derived from a stored `config_snapshot` JSONB.
 * Mirrors the `VersionDetail.counts` field served by the version detail
 * Server Action.
 */
export interface RuleCounts {
  senders: number;
  subject_patterns: number;
  types: number;
  submission_id_patterns: number;
}

/**
 * Count rows inside a `config_snapshot` without allocating the full
 * arrays for the UI. Values default to 0 when a field is missing so we
 * stay resilient to older snapshots that might predate a rule type.
 *
 * Strict zod parse first; best-effort array-count fallback covers legacy
 * snapshots that fail the strict schema (e.g. pre-`schema_version`).
 *
 * Exported so a future diff-view implementation can reuse the same
 * source of truth — the unit test pins the invariant that "empty object
 * → all zeros" rather than "throws".
 */
export function countSnapshotRows(snapshot: unknown): RuleCounts {
  const parsed = configSnapshotSchema.safeParse(snapshot);
  if (parsed.success) {
    return {
      senders: parsed.data.senders.length,
      subject_patterns: parsed.data.subject_patterns.length,
      types: parsed.data.types.length,
      submission_id_patterns: parsed.data.submission_id_patterns.length,
    };
  }
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    senders: arr(s.senders),
    subject_patterns: arr(s.subject_patterns),
    types: arr(s.types),
    submission_id_patterns: arr(s.submission_id_patterns),
  };
}
