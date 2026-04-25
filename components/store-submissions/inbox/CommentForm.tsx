'use client';

/**
 * Textarea + submit form for appending COMMENT or REJECT_REASON entries
 * to a ticket. Single component handles both modes via the `mode` prop —
 * the underlying RPCs differ (`add_comment_tx` vs `add_reject_reason_tx`)
 * but the UX is the same: paste/type, submit, toast feedback.
 *
 * Reject-reason vs comment surface decisions (per PR-10c.3.1 UX-Q1):
 *   - Plain comment: always-visible textarea below the timeline.
 *   - Reject reason: hidden behind a "Add rejection reason" toggle button
 *     (`useState`-controlled); on click, `<CommentForm mode="reject_reason">`
 *     renders inline. Discoverable + uncluttered at rest.
 *
 * Validation:
 *   - Trim + non-empty enforced both client-side (submit disabled) and
 *     server-side (`BTRIM` in the RPC). Client check is UX; RPC is
 *     truth.
 *   - Soft max length 10_000 — exceeds Apple's typical reject-reason
 *     length (~2k chars) by 5×. Hard max would require a textarea-level
 *     enforcement; for MVP we trust the textarea + RPC.
 *
 * Pending UX: `useTransition` disables submit + textarea while the
 * Server Action is in flight. On success: clear textarea + toast.
 * On error: keep textarea content (user can retry without retyping)
 * + error toast.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  addCommentAction,
  addRejectReasonAction,
  type ActionError,
} from '@/app/(dashboard)/store-submissions/inbox/actions';

export interface CommentFormProps {
  ticketId: string;
  mode: 'comment' | 'reject_reason';
  /** Called after a successful submit. Use to collapse the form (reject mode). */
  onSuccess?: () => void;
}

const MODE_COPY = {
  comment: {
    placeholder: 'Add a comment…',
    submitLabel: 'Post comment',
    successToast: 'Comment posted',
  },
  reject_reason: {
    placeholder:
      'Paste rejection reason (e.g. "Guideline 2.3.10 — Metadata: Your screenshots…")',
    submitLabel: 'Add rejection reason',
    successToast: 'Rejection reason added',
  },
} as const;

const SOFT_MAX_LENGTH = 10_000;

export function CommentForm({ ticketId, mode, onSuccess }: CommentFormProps) {
  const [content, setContent] = useState('');
  const [isPending, startTransition] = useTransition();

  const trimmed = content.trim();
  const overLimit = content.length > SOFT_MAX_LENGTH;
  const canSubmit = trimmed.length > 0 && !overLimit && !isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    startTransition(async () => {
      const action =
        mode === 'comment' ? addCommentAction : addRejectReasonAction;
      const result = await action(ticketId, content);

      if (result.ok) {
        toast.success(MODE_COPY[mode].successToast);
        setContent('');
        onSuccess?.();
      } else {
        showErrorToast(result.error);
        // Intentionally retain `content` so the user can retry without
        // retyping. Submit button stays enabled (canSubmit truthy).
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={MODE_COPY[mode].placeholder}
        disabled={isPending}
        rows={mode === 'reject_reason' ? 5 : 3}
        className="w-full text-[13px] border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-y disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label={mode === 'comment' ? 'Comment text' : 'Rejection reason text'}
      />
      <div className="flex items-center justify-between gap-3">
        <CharCounter length={content.length} overLimit={overLimit} />
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium rounded-lg bg-[#0071E3] text-white hover:bg-[#005cb8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Posting…' : MODE_COPY[mode].submitLabel}
        </button>
      </div>
    </form>
  );
}

// -- Subcomponents --------------------------------------------------------

function CharCounter({
  length,
  overLimit,
}: {
  length: number;
  overLimit: boolean;
}) {
  if (length === 0) return <span />; // keep flex spacing
  return (
    <span
      className={`text-[11px] tabular-nums ${
        overLimit ? 'text-red-600 font-medium' : 'text-slate-400'
      }`}
    >
      {length.toLocaleString()} / {SOFT_MAX_LENGTH.toLocaleString()}
      {overLimit && ' — too long'}
    </span>
  );
}

function showErrorToast(error: ActionError): void {
  toast.error(error.message);
}
