import { Users } from 'lucide-react';
import { requireStoreSessionWithRole } from '@/lib/store-submissions/session-guard';
import { listUsers } from '@/lib/store-submissions/queries/users';
import { TeamTable } from '@/components/store-submissions/team/TeamTable';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const { storeUser } = await requireStoreSessionWithRole('MANAGER');
  const users = await listUsers();
  const activeManagerCount = users.filter(
    (u) => u.role === 'MANAGER' && u.status === 'active'
  ).length;

  return (
    <div className="px-8 py-10">
      <div className="max-w-5xl">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
            <Users className="h-5 w-5 text-purple-700" strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              Team
            </h1>
            <p className="text-[13px] text-slate-500">
              Whitelist &amp; roles for Store Management
            </p>
          </div>
        </div>

        <TeamTable
          initialUsers={users}
          activeManagerCount={activeManagerCount}
          currentUserId={storeUser.id}
        />
      </div>
    </div>
  );
}
