import { Boxes } from 'lucide-react';
import { requireStoreSession } from '@/lib/store-submissions/session-guard';
import { listApps } from '@/lib/store-submissions/queries/apps';
import { listUsers } from '@/lib/store-submissions/queries/users';
import { AppsClient } from '@/components/store-submissions/apps/AppsClient';

export const dynamic = 'force-dynamic';

export default async function AppsPage() {
  const { storeUser } = await requireStoreSession();
  const [apps, teamUsers] = await Promise.all([listApps(), listUsers()]);

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center">
            <Boxes className="h-5 w-5 text-orange-700" strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              App Registry
            </h1>
            <p className="text-[13px] text-slate-500">
              Apps we track, their aliases, and store-platform bindings
            </p>
          </div>
        </div>

        <AppsClient
          initialApps={apps}
          teamUsers={teamUsers.filter((u) => u.status === 'active')}
          isManager={storeUser.role === 'MANAGER'}
        />
      </div>
    </div>
  );
}
