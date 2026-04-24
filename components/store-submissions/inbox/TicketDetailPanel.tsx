'use client';

/**
 * Ticket detail — right slide-over panel.
 *
 * **Pattern choice (slide-over, not centered modal):** CppDetailPanel
 * uses a centered modal because it's a single-concern edit session.
 * Inbox triage is the opposite — users open → skim → close → open next
 * rapidly. A centered modal hides the list behind an opaque backdrop,
 * costing scroll position + active-row context on every open. The
 * slide-over keeps the list visible so the filter + selected row stay
 * as workflow anchors. Deliberate codebase inconsistency, documented
 * for future contributors.
 *
 * Built on Radix `Dialog` even though Radix defaults to centered
 * positioning — Content positioning is entirely className-driven, so
 * we pin right + full-height. Using Radix buys:
 *   - focus trap on open / focus restore on close
 *   - Escape key close
 *   - body scroll lock
 *   - aria-modal + role=dialog
 *   - backdrop click close
 * All without custom implementation.
 *
 * **Animation**: no slide/fade transitions. `tailwindcss-animate` is
 * not installed (existing Radix dialogs also render without animation).
 * Tracked post-MVP; visual polish, not functional.
 *
 * PR-10.3.1 ships the shell. PR-10.3.2 fills the metadata section.
 * PR-10.3.3 fills the timeline. PR-10c.2 adds the action footer
 * (archive / follow-up / mark-done / unarchive).
 */

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import type { TicketWithEntries } from '@/lib/store-submissions/queries/tickets';

export interface TicketDetailPanelProps {
  /**
   * null when the URL specifies a ticket that was not found (or user
   * pasted a bad id). Panel renders a "not found" state.
   */
  ticket: TicketWithEntries | null;
  /** Controlled open state — derived from URL `?ticket=<id>`. */
  isOpen: boolean;
  /** Called for any close trigger (Esc, backdrop, X). URL is cleared by caller. */
  onClose: () => void;
}

export function TicketDetailPanel({ ticket, isOpen, onClose }: TicketDetailPanelProps) {
  return (
    <Dialog.Root open={isOpen} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40" />
        <Dialog.Content
          // Right slide-over: pinned to the right edge, full height, fixed
          // width on desktop, full width on mobile. No animation (see
          // header note).
          className="fixed right-0 top-0 bottom-0 w-full md:w-[520px] bg-white shadow-xl z-50 flex flex-col focus:outline-none"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
            <div className="min-w-0 flex-1">
              <Dialog.Title asChild>
                <h2 className="text-[15px] font-semibold text-slate-900 truncate">
                  {ticket ? ticket.ticket.display_id : 'Ticket not found'}
                </h2>
              </Dialog.Title>
              {ticket && (
                <p className="text-[12px] text-slate-400 truncate mt-0.5">
                  {ticket.app?.name ?? (
                    <span className="italic">Unclassified</span>
                  )}
                </p>
              )}
            </div>
            <Dialog.Close
              className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex-shrink-0 ml-2"
              aria-label="Close ticket detail"
            >
              <X className="w-4 h-4" strokeWidth={1.8} />
            </Dialog.Close>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto">
            {ticket === null ? (
              <div className="p-8 text-center text-[13px] text-slate-500">
                This ticket could not be found. The link may be stale, or
                the ticket was archived and your current filters hide it.
              </div>
            ) : (
              <>
                {/* Metadata section — PR-10.3.2 fills this */}
                <section className="px-5 py-4 border-b border-slate-100">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
                    Metadata
                  </p>
                  <p className="text-[12px] text-slate-400 italic">
                    PR-10.3.2 — state / outcome / priority / platform / dates /
                    submission IDs land here.
                  </p>
                </section>

                {/* Timeline section — PR-10.3.3 fills this */}
                <section className="px-5 py-4">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
                    Timeline
                  </p>
                  <p className="text-[12px] text-slate-400 italic">
                    PR-10.3.3 will render {ticket.entries.length}{' '}
                    {ticket.entries.length === 1 ? 'entry' : 'entries'} here
                    (EMAIL + STATE_CHANGE + PAYLOAD_ADDED cards).
                  </p>
                </section>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
