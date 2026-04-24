import { Inbox } from 'lucide-react';

import { requireStoreSession } from '@/lib/store-submissions/session-guard';
import { listTickets } from '@/lib/store-submissions/queries/tickets';
import { parseTicketsQueryFromSearchParams } from '@/lib/store-submissions/inbox/search-params';
import { InboxClient } from '@/components/store-submissions/inbox/InboxClient';

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
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { storeUser } = await requireStoreSession();

  const query = parseTicketsQueryFromSearchParams(searchParams);
  const data = await listTickets(query);

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
          role={storeUser.role}
        />
      </div>
    </div>
  );
}
