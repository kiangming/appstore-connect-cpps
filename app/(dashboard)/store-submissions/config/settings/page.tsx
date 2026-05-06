import { Settings as SettingsIcon } from 'lucide-react';
import { requireStoreSession } from '@/lib/store-submissions/session-guard';
import { SettingsClient } from '@/components/store-submissions/settings/SettingsClient';
import { getBackfillStatusAction, getGmailStatusAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { storeUser } = await requireStoreSession();
  const [statusResult, backfillResult] = await Promise.all([
    getGmailStatusAction(),
    getBackfillStatusAction(),
  ]);

  // The actions only fail here on auth — we just passed requireStoreSession,
  // so `ok: false` would mean the user was disabled between the two calls.
  // Fall back to safe defaults so the page still renders something.
  const status = statusResult.ok
    ? statusResult.data
    : { connected: false as const };
  const backfillStatus = backfillResult.ok ? backfillResult.data : null;

  return (
    <div className="px-8 py-10">
      <div className="max-w-3xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
            <SettingsIcon
              className="h-5 w-5 text-slate-700"
              strokeWidth={1.8}
            />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              Settings
            </h1>
            <p className="text-[13px] text-slate-500">
              Gmail connection &amp; module preferences
            </p>
          </div>
        </div>

        <SettingsClient
          initialStatus={status}
          initialBackfillStatus={backfillStatus}
          isManager={storeUser.role === 'MANAGER'}
        />
      </div>
    </div>
  );
}
