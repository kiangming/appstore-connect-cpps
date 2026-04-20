'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  getRuleVersionAction,
  listRuleVersionsAction,
  rollbackRulesAction,
  type VersionDetail,
  type VersionSummary,
} from '@/app/(dashboard)/store-submissions/config/email-rules/actions';

/**
 * VersionHistoryDialog — list rule versions + expandable counts + rollback.
 *
 * Design notes (from Chunk 3 spec + risk flags):
 *   - Versions list is NOT cached across dialog opens — the dialog re-fetches
 *     on every mount so a Save-in-another-tab shows up immediately (risk §3).
 *   - Version details ARE cached per dialog session (Map<versionId, detail>)
 *     so collapse-expand of the same row doesn't re-fetch.
 *   - Rollback: if the parent has unsaved draft changes, the parent passes
 *     `isDirty=true` and the confirm dialog mentions "discard unsaved
 *     changes" (risk §4). The parent is responsible for the dirty check —
 *     this component just surfaces it in the confirm text.
 *   - No diff view here — counts only, per Adjustment 1 from chunk 3 brief.
 */

interface VersionHistoryDialogProps {
  platformId: string;
  currentVersion: number | null;
  parentIsDirty: boolean;
  onClose: () => void;
  /** Called after a successful rollback so the parent re-fetches. */
  onRollbackSuccess: (newVersion: number) => void;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; versions: VersionSummary[] };

export function VersionHistoryDialog({
  platformId,
  currentVersion,
  parentIsDirty,
  onClose,
  onRollbackSuccess,
}: VersionHistoryDialogProps) {
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Per-dialog cache of expanded details — cleared when dialog unmounts,
  // so the next open always re-fetches the list + details.
  const [detailCache, setDetailCache] = useState<Map<string, VersionDetail>>(
    () => new Map(),
  );
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [isRollingBack, startRollback] = useTransition();

  // Load the list on mount. Re-running when platformId changes would only
  // matter if the parent reused the dialog across platforms, which it
  // doesn't — but the dep is correct defensively.
  useEffect(() => {
    let cancelled = false;
    setListState({ kind: 'loading' });
    listRuleVersionsAction(platformId).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setListState({ kind: 'ready', versions: res.data });
      } else {
        setListState({ kind: 'error', message: res.error.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [platformId]);

  const handleToggle = useCallback(
    async (version: VersionSummary) => {
      if (expandedId === version.id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(version.id);
      if (detailCache.has(version.id)) return;
      setLoadingDetailId(version.id);
      const res = await getRuleVersionAction({
        platform_id: platformId,
        version_number: version.version_number,
      });
      setLoadingDetailId(null);
      if (res.ok) {
        setDetailCache((prev) => {
          const next = new Map(prev);
          next.set(version.id, res.data);
          return next;
        });
      } else {
        toast.error(res.error.message);
        // Collapse the row since there's nothing to show.
        setExpandedId(null);
      }
    },
    [expandedId, detailCache, platformId],
  );

  const handleRollback = useCallback(
    (version: VersionSummary) => {
      const confirmMsg = parentIsDirty
        ? `Discard your unsaved changes and roll back to v${version.version_number}?\n\nThis creates a NEW version with v${version.version_number}'s content. Your draft edits will be lost.`
        : `Roll back to v${version.version_number}?\n\nThis creates a NEW version with v${version.version_number}'s content.`;
      if (!window.confirm(confirmMsg)) return;

      startRollback(async () => {
        const res = await rollbackRulesAction({
          platform_id: platformId,
          target_version: version.version_number,
        });
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        toast.success(
          `Rolled back to v${version.version_number} (now saved as v${res.data.version_number})`,
        );
        onRollbackSuccess(res.data.version_number);
      });
    },
    [parentIsDirty, platformId, onRollbackSuccess],
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl z-50">
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-slate-500" strokeWidth={1.8} />
              <Dialog.Title className="text-[16px] font-semibold text-slate-900">
                Version history
              </Dialog.Title>
            </div>
            <Dialog.Close
              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </Dialog.Close>
          </div>

          <div className="px-6 py-4">
            {listState.kind === 'loading' && (
              <div className="flex items-center gap-2 text-[12.5px] text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading versions…
              </div>
            )}
            {listState.kind === 'error' && (
              <div className="text-[12.5px] text-rose-700">
                {listState.message}
              </div>
            )}
            {listState.kind === 'ready' && listState.versions.length === 0 && (
              <div className="text-[12.5px] text-slate-500 italic">
                No versions saved yet.
              </div>
            )}
            {listState.kind === 'ready' && listState.versions.length > 0 && (
              <div className="max-h-96 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                {listState.versions.map((v) => (
                  <VersionRow
                    key={v.id}
                    version={v}
                    expanded={expandedId === v.id}
                    detail={detailCache.get(v.id)}
                    detailLoading={loadingDetailId === v.id}
                    isCurrent={v.version_number === currentVersion}
                    rollbackPending={isRollingBack}
                    onToggle={() => handleToggle(v)}
                    onRollback={() => handleRollback(v)}
                  />
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// -- Row -----------------------------------------------------------------

function VersionRow({
  version,
  expanded,
  detail,
  detailLoading,
  isCurrent,
  rollbackPending,
  onToggle,
  onRollback,
}: {
  version: VersionSummary;
  expanded: boolean;
  detail: VersionDetail | undefined;
  detailLoading: boolean;
  isCurrent: boolean;
  rollbackPending: boolean;
  onToggle: () => void;
  onRollback: () => void;
}) {
  const savedBy =
    version.saved_by_display_name ?? version.saved_by_email ?? 'unknown';
  const savedAt = formatSavedAt(version.saved_at);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-slate-50 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" strokeWidth={1.8} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" strokeWidth={1.8} />
        )}
        <span className="font-mono text-[12.5px] text-slate-700 font-semibold w-12">
          v{version.version_number}
        </span>
        {isCurrent && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
            Current
          </span>
        )}
        <span className="text-[12px] text-slate-500 flex-1 min-w-0 truncate">
          {version.note ?? <span className="italic">No note</span>}
        </span>
        <span className="text-[11px] text-slate-400 font-mono flex-shrink-0">
          {savedAt}
        </span>
        <span className="text-[11px] text-slate-500 flex-shrink-0 truncate max-w-[140px]">
          {savedBy}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-slate-50/60 border-t border-slate-100 text-[12px]">
          {detailLoading && (
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading details…
            </div>
          )}
          {!detailLoading && detail && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-600">
                <span>
                  Senders:{' '}
                  <span className="font-mono text-slate-800">
                    {detail.counts.senders}
                  </span>
                </span>
                <span>
                  Subject patterns:{' '}
                  <span className="font-mono text-slate-800">
                    {detail.counts.subject_patterns}
                  </span>
                </span>
                <span>
                  Types:{' '}
                  <span className="font-mono text-slate-800">
                    {detail.counts.types}
                  </span>
                </span>
                <span>
                  Submission ID patterns:{' '}
                  <span className="font-mono text-slate-800">
                    {detail.counts.submission_id_patterns}
                  </span>
                </span>
              </div>
              {detail.note && (
                <p className="text-slate-600 whitespace-pre-wrap">
                  {detail.note}
                </p>
              )}
              {!isCurrent && (
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={onRollback}
                    disabled={rollbackPending}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
                  >
                    {rollbackPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" strokeWidth={2} />
                    )}
                    Roll back to v{version.version_number}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Format an ISO timestamp as a short local-time marker. "2m ago", "3h ago",
 * or a date+time for anything older than a day. Kept in-file because it's
 * only used here; if another dialog needs relative-time it can move to a
 * shared util later.
 */
function formatSavedAt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const deltaMs = Date.now() - t;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const date = new Date(t);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
