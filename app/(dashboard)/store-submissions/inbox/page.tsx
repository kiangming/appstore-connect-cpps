import { Inbox } from 'lucide-react';
import { z } from 'zod';

import { requireStoreSession } from '@/lib/store-submissions/session-guard';
import {
  getTicketWithEntries,
  listTickets,
} from '@/lib/store-submissions/queries/tickets';
import { listApps } from '@/lib/store-submissions/queries/apps';
import { listPlatforms } from '@/lib/store-submissions/queries/rules';
import { parseTicketsQueryFromSearchParams } from '@/lib/store-submissions/inbox/search-params';
import type { TicketsQuery } from '@/lib/store-submissions/schemas/ticket';
import { InboxClient } from '@/components/store-submissions/inbox/InboxClient';

const uuidSchema = z.string().uuid();

function firstOfStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export const dynamic = 'force-dynamic';

/**
 * Inbox — ticket triage hub for Store Management.
 *
 * All 3 roles (VIEWER / DEV / MANAGER) can view; state-transition and
 * comment actions land in PR-10c and are role-gated inside the client.
 *
 * Filter state lives in URL query params so pages are shareable and the
 * browser back button restores prior filters. searchParams → validated
 * `TicketsQuery` via `parseTicketsQueryFromSearchParams`, which falls
 * back to defaults on malformed input (e.g. stale cursors).
 *
 * Default view convention: when no state/bucket filter is in the URL,
 * the Inbox renders the "Open" tab (NEW + IN_REVIEW + REJECTED). The
 * URL stays clean (no params) so users aren't stuck with a verbose
 * shareable link for the default view. The client infers the active
 * tab from the same `initialQuery` that was used to hydrate the URL.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { storeUser } = await requireStoreSession();

  const query = parseTicketsQueryFromSearchParams(searchParams);

  // Apply Open-tab default server-side when the URL has neither `state`
  // nor `bucket`. Done here (not in the parser) because the parser is
  // a pure searchParams→schema mapping; the Open default is a page-
  // level UX decision, and a generic `listTickets` caller shouldn't
  // silently gain "only open tickets" semantics.
  const effectiveQuery: TicketsQuery =
    !query.state && !query.bucket
      ? { ...query, state: ['NEW', 'IN_REVIEW', 'REJECTED'] }
      : query;

  // Ticket detail panel: `?ticket=<uuid>` opens the slide-over with the
  // matching ticket's data. Validated separately from ticketsQuerySchema
  // — it's a UI state param, not a filter. Bad/missing UUIDs resolve to
  // null so the panel renders a "not found" state instead of a server
  // error. Only fetched when the param is present to skip the round-trip
  // on the common no-panel case.
  const rawTicket = firstOfStr(searchParams.ticket);
  const ticketIdCheck = rawTicket ? uuidSchema.safeParse(rawTicket) : null;
  const selectedTicketId = ticketIdCheck?.success ? ticketIdCheck.data : null;

  // Unclassified buckets lack `app_name`, so the list row renders sender +
  // subject as a fallback — that requires a per-ticket first-EMAIL lookup.
  // Paid only when the user is actually looking at unclassified rows.
  const isUnclassifiedView =
    effectiveQuery.bucket?.startsWith('unclassified_') ?? false;

  const [data, apps, platforms, initialTicket] = await Promise.all([
    listTickets(effectiveQuery, { includeFirstEmail: isUnclassifiedView }),
    listApps({ active: true }),
    listPlatforms(),
    selectedTicketId ? getTicketWithEntries(selectedTicketId) : Promise.resolve(null),
  ]);

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
            <Inbox className="h-5 w-5 text-[#0071E3]" strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              Inbox
            </h1>
            <p className="text-[13px] text-slate-500">
              Triage tickets across all platforms — filter, drill in, resolve
            </p>
          </div>
        </div>

        <InboxClient
          initialData={data}
          initialQuery={query}
          apps={apps.map((a) => ({ id: a.id, name: a.name }))}
          platforms={platforms.map((p) => ({ key: p.key, display_name: p.display_name }))}
          role={storeUser.role}
          selectedTicketId={selectedTicketId}
          initialTicket={initialTicket}
        />
      </div>
    </div>
  );
}
