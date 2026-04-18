'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, ShieldOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { TeamUser } from '@/lib/store-submissions/queries/users';
import { disableUser } from '@/app/(dashboard)/store-submissions/config/team/actions';
import { UserDialog, type UserDialogMode } from './UserDialog';

const ROLE_BADGE: Record<string, string> = {
  MANAGER: 'bg-purple-50 text-purple-700 border-purple-200',
  DEV: 'bg-blue-50 text-blue-700 border-blue-200',
  VIEWER: 'bg-slate-50 text-slate-600 border-slate-200',
};

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  disabled: 'bg-slate-100 text-slate-500 border-slate-200',
};

interface TeamTableProps {
  initialUsers: TeamUser[];
  activeManagerCount: number;
  currentUserId: string;
}

function Avatar({ user }: { user: TeamUser }) {
  if (user.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={user.avatar_url}
        alt={user.display_name ?? user.email}
        className="w-9 h-9 rounded-full object-cover flex-shrink-0"
      />
    );
  }
  const initial = (user.display_name ?? user.email).charAt(0).toUpperCase();
  return (
    <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
      <span className="text-[13px] font-medium text-slate-600">{initial}</span>
    </div>
  );
}

export function TeamTable({
  initialUsers,
  activeManagerCount,
  currentUserId,
}: TeamTableProps) {
  const router = useRouter();
  const [dialogState, setDialogState] = useState<{
    mode: UserDialogMode;
    user?: TeamUser;
  } | null>(null);
  const [disablingId, setDisablingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isLastActiveManager = (u: TeamUser) =>
    u.role === 'MANAGER' && u.status === 'active' && activeManagerCount <= 1;

  const handleDisable = (user: TeamUser) => {
    if (user.status === 'disabled') return;
    if (isLastActiveManager(user)) {
      toast.error('Cannot disable the last active MANAGER.');
      return;
    }
    if (
      !confirm(
        `Disable ${user.display_name ?? user.email}? They will lose access immediately.`
      )
    ) {
      return;
    }
    setDisablingId(user.id);
    startTransition(async () => {
      const result = await disableUser({ id: user.id });
      setDisablingId(null);
      if (result.ok) {
        toast.success('User disabled.');
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <>
      <div className="flex items-center justify-between mt-8 mb-4">
        <p className="text-[13px] text-slate-500">
          {initialUsers.length} {initialUsers.length === 1 ? 'member' : 'members'}
          {' · '}
          {activeManagerCount} active{' '}
          {activeManagerCount === 1 ? 'manager' : 'managers'}
        </p>
        <button
          type="button"
          onClick={() => setDialogState({ mode: 'create' })}
          className="inline-flex items-center gap-2 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[13px] font-semibold rounded-lg px-4 py-2 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Add member
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-6 py-3">
                Member
              </th>
              <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-6 py-3">
                Role
              </th>
              <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-6 py-3">
                Status
              </th>
              <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-6 py-3">
                Last login
              </th>
              <th className="text-right text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-6 py-3">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {initialUsers.map((user) => {
              const isYou = user.id === currentUserId;
              const disableBlocked =
                user.status === 'disabled' || isLastActiveManager(user);
              const lastLogin = user.last_login_at
                ? new Date(user.last_login_at).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : '—';

              return (
                <tr
                  key={user.id}
                  className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/50"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <Avatar user={user} />
                      <div className="min-w-0">
                        <div className="text-[14px] font-medium text-slate-900 flex items-center gap-2">
                          <span className="truncate">
                            {user.display_name ?? user.email}
                          </span>
                          {isYou && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                              You
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-slate-500 truncate">
                          {user.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${
                        ROLE_BADGE[user.role] ?? ROLE_BADGE.VIEWER
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${
                        STATUS_BADGE[user.status] ?? STATUS_BADGE.disabled
                      }`}
                    >
                      {user.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-[13px] text-slate-500">
                    {lastLogin}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setDialogState({ mode: 'edit', user })}
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDisable(user)}
                        disabled={disableBlocked || isPending}
                        className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400"
                        title={
                          isLastActiveManager(user)
                            ? 'Cannot disable the last active MANAGER'
                            : user.status === 'disabled'
                              ? 'Already disabled'
                              : 'Disable'
                        }
                      >
                        {disablingId === user.id ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            strokeWidth={1.8}
                          />
                        ) : (
                          <ShieldOff className="h-4 w-4" strokeWidth={1.8} />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialogState && (
        <UserDialog
          mode={dialogState.mode}
          user={dialogState.user}
          activeManagerCount={activeManagerCount}
          onClose={() => setDialogState(null)}
          onSuccess={() => {
            setDialogState(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
