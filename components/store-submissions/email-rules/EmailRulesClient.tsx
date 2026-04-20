'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FlaskConical, History, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

import { saveRulesAction } from '@/app/(dashboard)/store-submissions/config/email-rules/actions';
import type {
  PlatformRow,
  PlatformRules,
} from '@/lib/store-submissions/queries/rules';
import type { PlatformKey } from '@/lib/store-submissions/schemas/app';

import {
  PLATFORM_KEYS,
  PLATFORM_LABELS,
  buildDraftState,
  isDraftDirty,
  type DraftState,
  type SenderDraft,
  type SubjectPatternDraft,
  type SubmissionIdPatternDraft,
  type TypeDraft,
} from './helpers';
import { SendersTable } from './SendersTable';
import { SubjectPatternsTable } from './SubjectPatternsTable';
import { SubmissionIdPatternsTable } from './SubmissionIdPatternsTable';
import { TestEmailDialog } from './TestEmailDialog';
import { TypesTable } from './TypesTable';
import { VersionHistoryDialog } from './VersionHistoryDialog';

/**
 * Client shell for the Email Rules editor.
 *
 *   - Platform tab bar (hard-coded 4 keys) + top action bar (version badge
 *     + Test + History + Save).
 *   - DraftState + dirty tracking drives Save, beforeunload, tab-switch
 *     confirm, and the "discard draft?" prompt on rollback.
 *   - URL search param kept in sync via router.replace so platform switches
 *     don't litter browser history.
 *   - Save path: zod re-validates on submit (spec risk §1), VERSION_CONFLICT
 *     surfaces as a sonner toast with a Reload action button.
 */

export interface EmailRulesClientProps {
  platforms: PlatformRow[];
  activeKey: PlatformKey;
  initialRules: PlatformRules;
}

function PlatformTab({
  k,
  active,
  disabled,
  onClick,
}: {
  k: PlatformKey;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const base =
    'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors';
  const state = active
    ? 'bg-slate-900 text-white'
    : disabled
      ? 'text-slate-300 cursor-not-allowed'
      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100';
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${state}`}
    >
      {PLATFORM_LABELS[k]}
    </button>
  );
}

export function EmailRulesClient({
  platforms,
  activeKey,
  initialRules,
}: EmailRulesClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const platformId = initialRules.platform.id;

  const originalDraft = useMemo(
    () => buildDraftState(initialRules),
    [initialRules],
  );
  // Clone so user edits don't mutate the frozen `originalDraft` reference
  // used for dirty comparison.
  const [draft, setDraft] = useState<DraftState>(
    () => JSON.parse(JSON.stringify(originalDraft)) as DraftState,
  );

  // Snap draft back to the new platform's baseline whenever the server
  // re-renders this client with a different `initialRules`. Handles tab
  // switches (page navigation) and post-save router.refresh().
  useEffect(() => {
    setDraft(JSON.parse(JSON.stringify(originalDraft)) as DraftState);
  }, [originalDraft]);

  const dirty = isDraftDirty(originalDraft, draft);

  const activePlatformKeys = useMemo(
    () => new Set(platforms.filter((p) => p.active).map((p) => p.key)),
    [platforms],
  );

  // Warn on tab close / reload when there are unsaved changes. The custom
  // message is ignored by modern browsers (they show a generic prompt);
  // setting returnValue is what actually triggers the prompt.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const switchPlatform = useCallback(
    (nextKey: PlatformKey) => {
      if (nextKey === activeKey) return;
      if (
        dirty &&
        !window.confirm(
          'You have unsaved changes. Switch platform and discard them?',
        )
      ) {
        return;
      }
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      params.set('platform', nextKey);
      router.replace(`${pathname}?${params.toString()}`);
    },
    [activeKey, dirty, pathname, router, searchParams],
  );

  // -- Dialogs ----------------------------------------------------------
  const [testOpen, setTestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // -- Save flow --------------------------------------------------------
  const [isSaving, startSave] = useTransition();

  const handleSave = useCallback(() => {
    if (!dirty || isSaving) return;

    startSave(async () => {
      const payload = {
        platform_id: platformId,
        expected_version_number: initialRules.latest_version,
        senders: draft.senders.map((s) => ({
          email: s.email,
          is_primary: s.is_primary,
          active: s.active,
        })),
        subject_patterns: draft.subject_patterns.map((p) => ({
          outcome: p.outcome,
          regex: p.regex,
          priority: p.priority,
          example_subject: p.example_subject,
          active: p.active,
        })),
        types: draft.types.map((t) => ({
          name: t.name,
          slug: t.slug,
          body_keyword: t.body_keyword,
          payload_extract_regex: t.payload_extract_regex,
          sort_order: t.sort_order,
          active: t.active,
        })),
        submission_id_patterns: draft.submission_id_patterns.map((p) => ({
          body_regex: p.body_regex,
          active: p.active,
        })),
      };

      const res = await saveRulesAction(payload);
      if (res.ok) {
        toast.success(`Saved as v${res.data.version_number}`);
        router.refresh();
        return;
      }

      if (res.error.code === 'VERSION_CONFLICT') {
        const actual = res.error.actualVersion;
        toast.error(
          actual !== null
            ? `Rules updated to v${actual} by another Manager. Reload to pick up their changes?`
            : 'Rules updated by another Manager. Reload?',
          {
            action: {
              label: 'Reload',
              onClick: () => router.refresh(),
            },
            duration: 10_000,
          },
        );
        return;
      }

      toast.error(res.error.message);
    });
  }, [
    dirty,
    isSaving,
    platformId,
    initialRules.latest_version,
    draft,
    router,
  ]);

  const saveDisabledReason = isSaving
    ? 'Saving…'
    : dirty
      ? null
      : 'No changes to save';

  const versionLabel =
    initialRules.latest_version === null
      ? 'Unsaved'
      : `v${initialRules.latest_version}`;

  return (
    <div>
      {/* Top bar: platform tabs + version + Test + History + Save */}
      <div className="px-6 py-3 flex items-center gap-2 border-b border-slate-200 bg-slate-50/60">
        <div className="text-[11.5px] text-slate-500 uppercase tracking-wider font-medium mr-2">
          Platform
        </div>
        {PLATFORM_KEYS.map((k) => (
          <PlatformTab
            key={k}
            k={k}
            active={k === activeKey}
            disabled={!activePlatformKeys.has(k)}
            onClick={() => switchPlatform(k)}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11.5px] text-slate-500">
            Version{' '}
            <span className="font-mono text-slate-700">{versionLabel}</span>
          </span>
          <button
            type="button"
            onClick={() => setTestOpen(true)}
            title="Test against current draft"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50"
          >
            <FlaskConical className="h-3.5 w-3.5" strokeWidth={1.8} />
            Test
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            title="Version history"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50"
          >
            <History className="h-3.5 w-3.5" strokeWidth={1.8} />
            History
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || isSaving}
            title={saveDisabledReason ?? undefined}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" strokeWidth={2} />
            )}
            Save changes
          </button>
        </div>
      </div>

      <div className="px-6 py-6 max-w-5xl">
        <SendersTable
          senders={draft.senders}
          onChange={(senders: SenderDraft[]) =>
            setDraft((prev) => ({ ...prev, senders }))
          }
        />
        <SubjectPatternsTable
          patterns={draft.subject_patterns}
          onChange={(subject_patterns: SubjectPatternDraft[]) =>
            setDraft((prev) => ({ ...prev, subject_patterns }))
          }
        />
        <TypesTable
          types={draft.types}
          onChange={(types: TypeDraft[]) =>
            setDraft((prev) => ({ ...prev, types }))
          }
        />
        <SubmissionIdPatternsTable
          patterns={draft.submission_id_patterns}
          onChange={(submission_id_patterns: SubmissionIdPatternDraft[]) =>
            setDraft((prev) => ({ ...prev, submission_id_patterns }))
          }
        />
      </div>

      {testOpen && (
        <TestEmailDialog
          draft={draft}
          platformId={platformId}
          onClose={() => setTestOpen(false)}
        />
      )}

      {historyOpen && (
        <VersionHistoryDialog
          platformId={platformId}
          currentVersion={initialRules.latest_version}
          parentIsDirty={dirty}
          onClose={() => setHistoryOpen(false)}
          onRollbackSuccess={() => {
            setHistoryOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
