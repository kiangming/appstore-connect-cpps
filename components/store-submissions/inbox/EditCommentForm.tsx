'use client';

/**
 * Inline edit form for an existing COMMENT entry.
 *
 * Lifecycle (wired into `CommentEntryCard` by PR-10c.3.2):
 *   - Card renders a pencil icon for own comments only.
 *   - Click → card swaps content view for `<EditCommentForm>`.
 *   - Submit success → card receives `onSuccess`, swaps back to view +
 *     re-renders with edited content (the panel revalidatePath flushes
 *     the timeline data).
 *   - Cancel → card receives `onCancel`, swaps back without saving.
 *
 * Save button enabled only when:
 *   - content trimmed non-empty
 *   - content differs from `initialContent` (no-op edits don't dispatch)
 *   - not currently pending
 *
 * Ownership enforced server-side at the RPC (`COMMENT_FORBIDDEN`). The
 * card's pencil-icon visibility is the UX gate; RPC is the security gate.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  editCommentAction,
  type ActionError,
} from '@/app/(dashboard)/store-submissions/inbox/actions';

export interface EditCommentFormProps {
  ticketId: string;
  entryId: string;
  initialContent: string;
  onCancel: () => void;
  onSuccess: () => void;
}

const SOFT_MAX_LENGTH = 10_000;

export function EditCommentForm({
  ticketId,
  entryId,
  initialContent,
  onCancel,
  onSuccess,
}: EditCommentFormProps) {
  const [content, setContent] = useState(initialContent);
  const [isPending, startTransition] = useTransition();

  const trimmed = content.trim();
  const initialTrimmed = initialContent.trim();
  const unchanged = trimmed === initialTrimmed;
  const overLimit = content.length > SOFT_MAX_LENGTH;
  const canSubmit =
    trimmed.length > 0 && !unchanged && !overLimit && !isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    startTransition(async () => {
      const result = await editCommentAction(ticketId, entryId, content);

      if (result.ok) {
        toast.success('Comment updated');
        onSuccess();
      } else {
        showErrorToast(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={isPending}
        rows={3}
        autoFocus
        className="w-full text-[13px] border border-slate-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 resize-y disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Edit comment text"
      />
      <div className="flex items-center justify-between gap-3">
        <span
          className={`text-[11px] tabular-nums ${
            overLimit ? 'text-red-600 font-medium' : 'text-slate-400'
          }`}
        >
          {content.length > 0 &&
            `${content.length.toLocaleString()} / ${SOFT_MAX_LENGTH.toLocaleString()}${
              overLimit ? ' — too long' : ''
            }`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex items-center px-3 py-1.5 text-[13px] font-medium rounded-lg bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center px-3 py-1.5 text-[13px] font-medium rounded-lg bg-[#0071E3] text-white hover:bg-[#005cb8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </form>
  );
}

function showErrorToast(error: ActionError): void {
  toast.error(error.message);
}
