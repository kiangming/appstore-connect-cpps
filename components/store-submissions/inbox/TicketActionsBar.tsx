'use client';

/**
 * Footer actions bar for the ticket detail panel.
 *
 * Renders only the state-transition buttons (Archive / Follow Up /
 * Mark Done / Unarchive) — comments + reject reasons land in PR-10c.3.1
 * inside the panel body.
 *
 * Visibility rules:
 *   - Role gate: entire bar hidden for VIEWER (no mutations at all).
 *   - State gate: each button's visibility uses `canTransition` from
 *     state-machine.ts so the UI + RPC agree on legality. Pure function
 *     — no network call to determine button state.
 *
 * Per spec §7.6 + PR-10c design decision A: ARCHIVE is a "soft"
 * destructive action with a 10-second Undo toast. FOLLOW_UP / MARK_DONE
 * are one-way-ish (MARK_DONE is terminal, FOLLOW_UP is reversible via
 * other actions so no undo needed). UNARCHIVE is recovery — success
 * toast only.
 *
 * Pending UX: one `useTransition` shared across all four buttons. While
 * any action is in flight the whole row disables — prevents racing
 * transitions on the same ticket (e.g. rapid Archive→Unarchive clicks)
 * and matches the `FOR UPDATE` serialization the RPC provides.
 */

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Check, Forward } from 'lucide-react';

import type { StoreRole } from '@/lib/store-submissions/auth';
import { canPerformAction } from '@/lib/store-submissions/tickets/auth';
import { canTransition } from '@/lib/store-submissions/tickets/state-machine';
import type { TicketState } from '@/lib/store-submissions/schemas/ticket';
import {
  archiveTicketAction,
  followUpTicketAction,
  markDoneTicketAction,
  unarchiveTicketAction,
  type ActionError,
} from '@/app/(dashboard)/store-submissions/inbox/actions';

export interface TicketActionsBarProps {
  ticketId: string;
  ticketDisplayId: string;
  currentState: TicketState;
  userRole: StoreRole;
}

export function TicketActionsBar({
  ticketId,
  ticketDisplayId,
  currentState,
  userRole,
}: TicketActionsBarProps) {
  const [isPending, startTransition] = useTransition();

  // Role gate — a VIEWER can't perform any of the 4 transitions, and the
  // auth matrix is symmetric across them, so check any one. Hiding the
  // whole bar (vs. rendering disabled buttons) matches the "read-only"
  // role intent: the user shouldn't see affordances they can't use.
  if (!canPerformAction(userRole, 'ARCHIVE')) {
    return null;
  }

  const showArchive = canTransition(currentState, 'ARCHIVE');
  const showFollowUp = canTransition(currentState, 'FOLLOW_UP');
  const showMarkDone = canTransition(currentState, 'MARK_DONE');
  const showUnarchive = canTransition(currentState, 'UNARCHIVE');

  // Terminal states (APPROVED / DONE) have no legal transitions —
  // render an informational strip instead of an empty bar so the user
  // understands why the row is blank (vs. "buttons didn't load").
  if (!showArchive && !showFollowUp && !showMarkDone && !showUnarchive) {
    return (
      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex-shrink-0">
        <p className="text-[12px] text-slate-500 italic">
          No actions available — ticket is in terminal state{' '}
          <code className="font-mono not-italic">{currentState}</code>.
        </p>
      </div>
    );
  }

  function handleArchive() {
    startTransition(async () => {
      const result = await archiveTicketAction(ticketId);
      if (result.ok) {
        // 10-second Undo window per spec §7.6. Server does NOT enforce
        // the window — trust the client. A slow click after 10s still
        // succeeds at the RPC, but the user loses the affordance.
        toast.success(`${ticketDisplayId} archived`, {
          duration: 10_000,
          action: {
            label: 'Undo',
            onClick: () => {
              startTransition(async () => {
                const undo = await unarchiveTicketAction(ticketId);
                if (undo.ok) {
                  toast.success(`${ticketDisplayId} unarchived`);
                } else {
                  showErrorToast(undo.error);
                }
              });
            },
          },
        });
      } else {
        showErrorToast(result.error);
      }
    });
  }

  function handleFollowUp() {
    startTransition(async () => {
      const result = await followUpTicketAction(ticketId);
      if (result.ok) {
        // Spec §4.2: target state depends on latest_outcome. Toast the
        // resolved state so Manager sees where the ticket went ("moved
        // to REJECTED" when the prior email was a rejection).
        toast.success(
          `${ticketDisplayId} moved to ${result.data.newState}`,
        );
      } else {
        showErrorToast(result.error);
      }
    });
  }

  function handleMarkDone() {
    startTransition(async () => {
      const result = await markDoneTicketAction(ticketId);
      if (result.ok) {
        toast.success(`${ticketDisplayId} marked done`);
      } else {
        showErrorToast(result.error);
      }
    });
  }

  function handleUnarchive() {
    startTransition(async () => {
      const result = await unarchiveTicketAction(ticketId);
      if (result.ok) {
        toast.success(`${ticketDisplayId} unarchived`);
      } else {
        showErrorToast(result.error);
      }
    });
  }

  return (
    <div className="px-5 py-3 border-t border-slate-100 bg-white flex items-center gap-2 flex-wrap flex-shrink-0">
      {showArchive && (
        <ActionButton
          icon={<Archive className="w-3.5 h-3.5" strokeWidth={1.8} />}
          label="Archive"
          onClick={handleArchive}
          disabled={isPending}
          variant="default"
        />
      )}
      {showFollowUp && (
        <ActionButton
          icon={<Forward className="w-3.5 h-3.5" strokeWidth={1.8} />}
          label="Follow up"
          onClick={handleFollowUp}
          disabled={isPending}
          variant="default"
        />
      )}
      {showMarkDone && (
        <ActionButton
          icon={<Check className="w-3.5 h-3.5" strokeWidth={1.8} />}
          label="Mark done"
          onClick={handleMarkDone}
          disabled={isPending}
          variant="primary"
        />
      )}
      {showUnarchive && (
        <ActionButton
          icon={<ArchiveRestore className="w-3.5 h-3.5" strokeWidth={1.8} />}
          label="Unarchive"
          onClick={handleUnarchive}
          disabled={isPending}
          variant="primary"
        />
      )}
    </div>
  );
}

// -- Subcomponents + helpers ----------------------------------------------

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  variant,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  variant: 'default' | 'primary';
}) {
  const base =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const styles =
    variant === 'primary'
      ? 'bg-[#0071E3] text-white hover:bg-[#005cb8]'
      : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Toast copy tailored per error code. Generic dispatcher message is a
 * fallback — the specific codes (NOT_FOUND / CONFLICT / RACE) have
 * action-guiding phrasing the generic fallback can't match.
 */
function showErrorToast(error: ActionError): void {
  toast.error(error.message);
}
