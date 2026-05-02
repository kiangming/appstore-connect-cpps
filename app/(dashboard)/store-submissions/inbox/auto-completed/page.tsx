import Link from 'next/link';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';

import { requireStoreSessionWithRole } from '@/lib/store-submissions/session-guard';
import { listAutoCompleted } from '@/lib/store-submissions/queries/auto-completed';
import { AutoCompletedListClient } from '@/components/store-submissions/inbox/AutoCompletedListClient';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

/**
 * PR-16b Q1.E — dedicated auto-completed visibility surface.
 *
 * MANAGER-only (soft-redirected to /inbox for VIEWER/DEV via
 * `requireStoreSessionWithRole`). Lists state=DONE tickets closed
 * trong the last 7 days whose latest STATE_CHANGE is system-origin
 * auto_mark_done — i.e. tickets PR-16a auto-DONE'd that bypassed
 * the Open queue entirely.
 *
 * Row click opens the standard TicketDetailPanel by navigating to
 * `/inbox?ticket=<id>`. Existing detail panel handles reopen /
 * comment / reclassify; no duplicate affordance built here.
 */
export default async function AutoCompletedPage() {
  await requireStoreSessionWithRole('MANAGER');

  const tickets = await listAutoCompleted({ days: WINDOW_DAYS });

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto">
        <Link
          href="/store-submissions/inbox"
          className="inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700 mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.8} />
          Back to Inbox
        </Link>

        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
            <CheckCircle2
              className="h-5 w-5 text-[#0071E3]"
              strokeWidth={1.8}
            />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              Auto-completed tickets
            </h1>
            <p className="text-[13px] text-slate-500">
              Tickets auto-marked done in the last {WINDOW_DAYS} days · sorted by completion time
            </p>
          </div>
        </div>

        <AutoCompletedListClient tickets={tickets} />
      </div>
    </div>
  );
}
