'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { AppAliasRecord } from '@/lib/store-submissions/queries/apps';
import { validateAliasRegexClient } from '@/lib/store-submissions/regex/client-validators';
import {
  addAliasAction,
  removeAliasAction,
} from '@/app/(dashboard)/store-submissions/config/apps/actions';

interface AliasManagerProps {
  appId: string;
  aliases: AppAliasRecord[];
  disabled?: boolean;
  onChanged: () => void;
}

type AliasKind = 'text' | 'regex';

/**
 * Inline alias editor for an app's expanded row.
 *
 * Render rules:
 *   - Every alias shows as a chip. AUTO_CURRENT / AUTO_HISTORICAL chips render
 *     without a delete button — those rows are managed by the rename
 *     transaction, not by end users. Only MANUAL + REGEX can be removed here.
 *   - "Add alias" button toggles an inline form with text/regex tabs. The
 *     regex tab runs validateAliasRegex on every keystroke; we disable Submit
 *     until the pattern compiles with RE2 and passes the permissiveness check.
 */
export function AliasManager({ appId, aliases, disabled, onChanged }: AliasManagerProps) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<AliasKind>('text');
  const [textInput, setTextInput] = useState('');
  const [regexInput, setRegexInput] = useState('');
  const [busyRemoveId, setBusyRemoveId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const regexCheck = useMemo(() => {
    if (regexInput.trim() === '') return null;
    return validateAliasRegexClient(regexInput);
  }, [regexInput]);

  const sortedAliases = useMemo(
    () =>
      [...aliases].sort((a, b) => {
        const rank = (s: string) =>
          s === 'AUTO_CURRENT' ? 0 : s === 'AUTO_HISTORICAL' ? 1 : s === 'MANUAL' ? 2 : 3;
        return rank(a.source_type) - rank(b.source_type);
      }),
    [aliases],
  );

  function reset() {
    setAdding(false);
    setKind('text');
    setTextInput('');
    setRegexInput('');
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const payload =
      kind === 'text'
        ? { app_id: appId, alias_text: textInput.trim(), source_type: 'MANUAL' as const }
        : { app_id: appId, alias_regex: regexInput.trim(), source_type: 'REGEX' as const };

    if (kind === 'text' && payload.alias_text === '') {
      toast.error('Alias text cannot be empty');
      return;
    }
    if (kind === 'regex' && (!regexCheck || !regexCheck.ok)) {
      toast.error(regexCheck?.ok === false ? regexCheck.error : 'Enter a regex');
      return;
    }

    startTransition(async () => {
      const result = await addAliasAction(payload);
      if (result.ok) {
        toast.success('Alias added');
        reset();
        onChanged();
      } else {
        toast.error(result.error.message);
      }
    });
  }

  function handleRemove(alias: AppAliasRecord) {
    setBusyRemoveId(alias.id);
    startTransition(async () => {
      const result = await removeAliasAction({ id: alias.id });
      setBusyRemoveId(null);
      if (result.ok) {
        toast.success('Alias removed');
        onChanged();
      } else {
        toast.error(result.error.message);
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex items-center gap-2 flex-wrap min-h-[48px]">
        {sortedAliases.length === 0 && (
          <span className="text-[12px] text-amber-700 italic">
            No aliases yet — emails referencing this app won&apos;t classify
          </span>
        )}
        {sortedAliases.map((alias) => (
          <AliasChip
            key={alias.id}
            alias={alias}
            busy={busyRemoveId === alias.id}
            disabled={disabled || isPending}
            onRemove={() => handleRemove(alias)}
          />
        ))}

        {!disabled && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 border border-dashed border-slate-300 hover:border-slate-500 rounded-md px-1.5 py-0.5"
          >
            <Plus className="w-3 h-3" strokeWidth={2.2} />
            Add alias
          </button>
        )}
      </div>

      {adding && !disabled && (
        <form
          onSubmit={handleAdd}
          className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5"
        >
          <div className="flex items-center gap-1">
            <KindTab label="Text" active={kind === 'text'} onClick={() => setKind('text')} />
            <KindTab label="Regex" active={kind === 'regex'} onClick={() => setKind('regex')} />
            <button
              type="button"
              onClick={reset}
              className="ml-auto text-[11px] text-slate-500 hover:text-slate-800"
            >
              Cancel
            </button>
          </div>

          {kind === 'text' ? (
            <div>
              <input
                type="text"
                autoFocus
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="e.g. SKY, Skyline Runners: Endless"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-[12.5px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Case-insensitive exact match against the email subject.
              </p>
            </div>
          ) : (
            <div>
              <input
                type="text"
                autoFocus
                value={regexInput}
                onChange={(e) => setRegexInput(e.target.value)}
                placeholder="e.g. ^Skyline.*"
                className={`w-full px-2.5 py-1.5 border rounded-md text-[12.5px] font-mono focus:outline-none focus:ring-2 ${
                  regexCheck === null
                    ? 'border-slate-200 focus:ring-[#0071E3]/20 focus:border-[#0071E3]'
                    : regexCheck.ok
                      ? 'border-emerald-300 focus:ring-emerald-200 focus:border-emerald-500'
                      : 'border-red-300 focus:ring-red-100 focus:border-red-500'
                }`}
              />
              <div className="min-h-[16px] mt-1 text-[11px]">
                {regexCheck === null ? (
                  <span className="text-slate-400">
                    RE2 dialect — no lookbehind or backreferences.
                  </span>
                ) : regexCheck.ok ? (
                  <span className="text-emerald-700 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                    Valid RE2 pattern
                  </span>
                ) : (
                  <span className="text-red-600 inline-flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" strokeWidth={2} />
                    {regexCheck.error}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="submit"
              disabled={
                isPending ||
                (kind === 'text' && textInput.trim() === '') ||
                (kind === 'regex' && (!regexCheck || !regexCheck.ok))
              }
              className="inline-flex items-center gap-1.5 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[12px] font-semibold rounded-md px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Add alias
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// -- Chip ------------------------------------------------------------------

function AliasChip({
  alias,
  busy,
  disabled,
  onRemove,
}: {
  alias: AppAliasRecord;
  busy: boolean;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const isRegex = alias.alias_regex !== null;
  const isAutoCurrent = alias.source_type === 'AUTO_CURRENT';
  const isHistorical = alias.source_type === 'AUTO_HISTORICAL';
  const locked = isAutoCurrent; // AUTO_CURRENT is rename-managed, never user-deletable here

  const badge = isAutoCurrent
    ? { text: 'auto', cls: 'bg-white text-slate-500 border-slate-200' }
    : isHistorical
      ? { text: 'prev', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
      : isRegex
        ? { text: 'regex', cls: 'bg-purple-50 text-purple-700 border-purple-200' }
        : null;

  const chipClass = isAutoCurrent
    ? 'bg-orange-50 text-orange-800 border-orange-200'
    : isHistorical
      ? 'bg-slate-100 text-slate-600 border-slate-200'
      : 'bg-slate-50 text-slate-700 border-slate-200';

  const label = isRegex ? (
    <span className="font-mono text-[10.5px]">/{alias.alias_regex}/</span>
  ) : (
    alias.alias_text
  );

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] ${chipClass}`}
      title={isHistorical && alias.previous_name ? `Previous name: ${alias.previous_name}` : undefined}
    >
      <span>{label}</span>
      {badge && (
        <span
          className={`font-mono uppercase tracking-wider text-[9.5px] px-1 py-[1px] rounded border ${badge.cls}`}
        >
          {badge.text}
        </span>
      )}
      {!locked && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy || disabled}
          className="ml-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Remove alias"
        >
          {busy ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : (
            <X className="w-2.5 h-2.5" strokeWidth={2.5} />
          )}
        </button>
      )}
    </span>
  );
}

// -- Kind tab --------------------------------------------------------------

function KindTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${
        active
          ? 'bg-white border border-slate-200 text-slate-800 shadow-sm'
          : 'text-slate-500 hover:text-slate-800'
      }`}
    >
      {label}
    </button>
  );
}
