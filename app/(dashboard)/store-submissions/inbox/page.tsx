import { Inbox } from 'lucide-react';
import { requireStoreSession } from '@/lib/store-submissions/session-guard';

const ROLE_BADGE: Record<string, string> = {
  MANAGER: 'bg-purple-50 text-purple-700 border-purple-200',
  DEV: 'bg-blue-50 text-blue-700 border-blue-200',
  VIEWER: 'bg-slate-50 text-slate-600 border-slate-200',
};

export default async function InboxPage() {
  const { storeUser } = await requireStoreSession();

  return (
    <div className="flex-1 px-8 py-10">
      <div className="max-w-3xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
            <Inbox className="h-5 w-5 text-[#0071E3]" strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              Inbox
            </h1>
            <p className="text-[13px] text-slate-500">Store Management</p>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <p className="text-[13px] text-slate-500 mb-3">Signed in as</p>
          <div className="flex items-center gap-3">
            <span className="text-[15px] font-medium text-slate-900">
              {storeUser.display_name ?? storeUser.email}
            </span>
            <span
              className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${
                ROLE_BADGE[storeUser.role] ?? ROLE_BADGE.VIEWER
              }`}
            >
              {storeUser.role}
            </span>
          </div>
          <p className="text-[12px] text-slate-400 mt-1">{storeUser.email}</p>
        </div>

        <p className="text-[13px] text-slate-400 mt-6">
          Ticket triage list lands in Week 4 (PR: Inbox).
        </p>
      </div>
    </div>
  );
}
