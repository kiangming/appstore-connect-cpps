/**
 * Date formatting strategy for the Store Management module.
 *
 * Two formatters with intentionally different output styles, chosen by
 * the surface they render on:
 *
 *   - `formatDateTime` — absolute "dd/MM/yyyy HH:mm" (24-hour, Vietnamese
 *     positional convention). Used in **list views** (Inbox table) where
 *     the user is scanning many rows and needs precise mental anchors.
 *   - `formatRelative` — "5 minutes ago" via date-fns `formatDistanceToNow`.
 *     Used in **reading contexts** (ticket detail panel, entry timeline)
 *     where a single row is the focus and "how long ago" is more useful
 *     than the exact timestamp. The hover `title` always shows
 *     `absoluteTs` so precision is one mouse-over away.
 *
 * Pattern: scanning context → absolute, reading context → relative.
 *
 * The pattern is locale-agnostic because dd/MM/yyyy is purely positional —
 * no day-of-week / month-name interpolation. 24-hour clock matches
 * professional/operational tooling conventions in VN team usage.
 *
 * NOTE: Three pre-existing inline copies of `formatRelative` /
 * `absoluteTs` live in TicketListTable, TicketDetailPanel, and
 * TicketEntriesTimeline. PR-17.1 keeps them in place to scope the diff;
 * a follow-up consolidation is tracked for PR-17.5.
 */

import { format, formatDistanceToNow } from 'date-fns';

/**
 * Absolute calendar date+time in "dd/MM/yyyy HH:mm" format. Returns the
 * input string verbatim when parsing fails so the UI never silently
 * displays "Invalid Date" — surfacing the raw ISO is debuggable.
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return format(d, 'dd/MM/yyyy HH:mm');
}

/**
 * Human-readable relative time, e.g. "5 minutes ago" or "about 2 hours
 * ago". Suitable for ticket detail rendering where the row is the focus
 * and exact timestamps add noise.
 */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDistanceToNow(d, { addSuffix: true });
}

/**
 * ISO-ish absolute timestamp for hover `title` attributes — uses the
 * browser's `toLocaleString()` to respect the runtime locale, which is
 * fine here because the value is only shown on hover for verification,
 * not for scanning.
 */
export function absoluteTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
