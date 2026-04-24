/**
 * Parse Next.js `searchParams` into a validated TicketsQuery for the
 * Inbox page.
 *
 * Next.js 14 hands Server Components a
 *   Record<string, string | string[] | undefined>
 * shape. We normalize each known field through
 * `ticketsQuerySchema.safeParse` — on any validation failure we fall
 * back to defaults (empty filters, default sort/limit) and log a
 * warning so malformed URLs degrade to a usable page rather than 500.
 *
 * Per-field degradation (e.g. keep `state=NEW`, drop malformed
 * `platform=xxx`) is intentionally **not** implemented for MVP:
 *   - adds ~3x code for little real-world UX value
 *   - malformed params come almost exclusively from stale bookmarks or
 *     cursor corruption, where "reset to defaults" is the right fix
 * Revisit if users paste filter URLs often.
 */

import { ticketsQuerySchema, type TicketsQuery } from '../schemas/ticket';

type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Normalize `string | string[] | undefined` to either a single string
 * (first element) or `undefined`. Used for fields that are not arrays.
 */
function firstOf(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Normalize `state` param — the one field that legitimately takes an
 * array (Inbox "Open" tab = `?state=NEW&state=IN_REVIEW&state=REJECTED`).
 */
function normalizeState(v: string | string[] | undefined): unknown {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v;
  // Single value — pass through as string; zod schema accepts both.
  return v;
}

export function parseTicketsQueryFromSearchParams(
  params: RawSearchParams,
): TicketsQuery {
  const raw: Record<string, unknown> = {
    cursor: firstOf(params.cursor),
    limit: firstOf(params.limit),
    state: normalizeState(params.state),
    bucket: firstOf(params.bucket),
    platform_key: firstOf(params.platform_key),
    app_id: firstOf(params.app_id),
    type_id: firstOf(params.type_id),
    priority: firstOf(params.priority),
    assigned_to: firstOf(params.assigned_to),
    search: firstOf(params.search),
    opened_from: firstOf(params.opened_from),
    opened_to: firstOf(params.opened_to),
    sort: firstOf(params.sort),
  };

  // Strip undefineds so zod defaults apply cleanly.
  for (const k of Object.keys(raw)) {
    if (raw[k] === undefined) delete raw[k];
  }

  const parsed = ticketsQuerySchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  console.warn('[inbox] invalid searchParams, falling back to defaults:', {
    issues: parsed.error.flatten().fieldErrors,
  });
  // Empty object → all-default query (sort=opened_at_desc, limit=50).
  return ticketsQuerySchema.parse({});
}
