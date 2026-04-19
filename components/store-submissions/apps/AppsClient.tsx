'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Apple,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Facebook,
  Pencil,
  Plus,
  Search,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  AppListRow,
  AppPlatformBindingRecord,
  AppAliasRecord,
} from '@/lib/store-submissions/queries/apps';
import type { TeamUser } from '@/lib/store-submissions/queries/users';
import type { PlatformKey } from '@/lib/store-submissions/schemas/app';
import {
  deleteAppAction,
  exportAppsCsvAction,
  updateAppAction,
} from '@/app/(dashboard)/store-submissions/config/apps/actions';
import { AppDialog } from './AppDialog';
import { AliasManager } from './AliasManager';
import { CsvImportDialog } from './CsvImportDialog';

interface AppsClientProps {
  initialApps: AppListRow[];
  teamUsers: TeamUser[];
  isManager: boolean;
}

type StatusFilter = 'all' | 'active' | 'archived';

const PLATFORM_KEYS: PlatformKey[] = ['apple', 'google', 'huawei', 'facebook'];

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  apple: 'Apple App Store',
  google: 'Google Play',
  huawei: 'Huawei AppGallery',
  facebook: 'Facebook',
};

function PlatformIcon({ platform }: { platform: PlatformKey }) {
  const iconProps = { className: 'w-3.5 h-3.5 text-slate-700', strokeWidth: 1.8 } as const;
  switch (platform) {
    case 'apple':
      return <Apple {...iconProps} />;
    case 'google':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 text-slate-700">
          <path d="M3 20.5V3.5c0-.59.34-1.11.84-1.35l13.69 9.85-13.69 9.85c-.5-.25-.84-.76-.84-1.35Z" />
        </svg>
      );
    case 'facebook':
      return <Facebook {...iconProps} />;
    case 'huawei':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-3.5 h-3.5 text-slate-700" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function Avatar({ name, color = '#B8461F' }: { name: string; color?: string }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className="w-7 h-7 rounded-md flex items-center justify-center text-[13px] font-medium text-white flex-shrink-0"
      style={{ background: color }}
    >
      {initial}
    </div>
  );
}

/** Deterministic color for an app id so icons don't flicker between renders. */
function colorFromId(id: string): string {
  const palette = ['#B8461F', '#0F766E', '#6D28D9', '#0369A1', '#B45309', '#BE185D'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return palette[Math.abs(hash) % palette.length];
}

function ownerLabel(row: AppListRow): string {
  return row.team_owner_display_name ?? row.team_owner_email ?? 'Unassigned';
}

function aliasesPreview(aliases: AppAliasRecord[]): {
  shown: AppAliasRecord[];
  overflow: number;
} {
  const usable = aliases.filter((a) => a.alias_text || a.alias_regex);
  return { shown: usable.slice(0, 3), overflow: Math.max(0, usable.length - 3) };
}

type DialogState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; app: AppListRow }
  | { kind: 'import' };

export function AppsClient({ initialApps, teamUsers, isManager }: AppsClientProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<'all' | PlatformKey>('all');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [owner, setOwner] = useState<string>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [isExporting, startExport] = useTransition();
  const [isArchivingId, setIsArchivingId] = useState<string | null>(null);
  const [_isArchivePending, startArchive] = useTransition();
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of initialApps) {
      if (a.team_owner_id) {
        seen.set(a.team_owner_id, a.team_owner_display_name ?? a.team_owner_email ?? 'Unknown');
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [initialApps]);

  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return initialApps.filter((app) => {
      if (status === 'active' && !app.active) return false;
      if (status === 'archived' && app.active) return false;

      if (platform !== 'all') {
        if (!app.bindings.some((b) => b.platform_key === platform)) return false;
      }

      if (owner !== 'all') {
        if (owner === 'unassigned') {
          if (app.team_owner_id !== null) return false;
        } else if (app.team_owner_id !== owner) {
          return false;
        }
      }

      if (needle === '') return true;
      if (app.name.toLowerCase().includes(needle)) return true;
      if (app.slug.toLowerCase().includes(needle)) return true;
      if (app.aliases.some((al) => al.alias_text?.toLowerCase().includes(needle))) return true;
      if (
        app.bindings.some((b) => b.platform_ref?.toLowerCase().includes(needle))
      ) return true;
      return false;
    });
  }, [initialApps, search, platform, status, owner]);

  const stats = useMemo(() => {
    const total = initialApps.length;
    const active = initialApps.filter((a) => a.active).length;
    const platforms = new Set<PlatformKey>();
    for (const a of initialApps) {
      for (const b of a.bindings) platforms.add(b.platform_key);
    }
    return { total, active, platformsCount: platforms.size, platforms: Array.from(platforms) };
  }, [initialApps]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleExport() {
    startExport(async () => {
      const result = await exportAppsCsvAction();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const blob = new Blob([result.data.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Exported ${initialApps.length} apps`);
    });
  }

  function handleArchiveToggle(app: AppListRow) {
    setIsArchivingId(app.id);
    startArchive(async () => {
      const result = app.active
        ? await deleteAppAction({ id: app.id, hard: false })
        : await updateAppAction({ id: app.id, active: true });
      setIsArchivingId(null);
      if (result.ok) {
        toast.success(app.active ? `Archived "${app.name}"` : `Restored "${app.name}"`);
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  }

  function handleDialogSuccess() {
    setDialog({ kind: 'none' });
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {/* Filter / action bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" strokeWidth={1.8} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps, bundle ID, alias…"
            className="pl-8 pr-3 py-1.5 text-[13px] border border-slate-200 rounded-lg w-[260px] focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>

        <FilterPill
          label="Platform"
          value={platform === 'all' ? 'All' : PLATFORM_LABELS[platform]}
        >
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as 'all' | PlatformKey)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="all">All</option>
            {PLATFORM_KEYS.map((key) => (
              <option key={key} value={key}>
                {PLATFORM_LABELS[key]}
              </option>
            ))}
          </select>
        </FilterPill>

        <FilterPill
          label="Status"
          value={status === 'all' ? 'All' : status === 'active' ? 'Active' : 'Archived'}
        >
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
        </FilterPill>

        <FilterPill
          label="Owner"
          value={
            owner === 'all'
              ? 'All'
              : owner === 'unassigned'
                ? 'Unassigned'
                : ownerOptions.find(([id]) => id === owner)?.[1] ?? 'All'
          }
        >
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="all">All</option>
            <option value="unassigned">Unassigned</option>
            {ownerOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </FilterPill>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className="inline-flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 bg-white rounded-lg px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" strokeWidth={1.8} />
            {isExporting ? 'Exporting…' : 'Export CSV'}
          </button>

          {isManager && (
            <>
              <button
                type="button"
                onClick={() => setDialog({ kind: 'import' })}
                className="inline-flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 bg-white rounded-lg px-3 py-1.5"
              >
                <Upload className="w-3.5 h-3.5" strokeWidth={1.8} />
                Import CSV
              </button>
              <button
                type="button"
                onClick={() => setDialog({ kind: 'create' })}
                className="inline-flex items-center gap-1.5 text-[13px] text-white bg-[#0071E3] hover:bg-[#005fcc] rounded-lg px-3 py-1.5"
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                Add app
              </button>
            </>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total apps" value={stats.total} />
        <StatCard
          label="Active"
          value={stats.active}
          suffix={
            stats.total > 0 ? (
              <span className="text-[14px] text-slate-400"> / {stats.total}</span>
            ) : null
          }
        />
        <StatCard
          label="Platforms linked"
          value={stats.platformsCount}
          subline={
            stats.platforms.length > 0
              ? stats.platforms.map((p) => PLATFORM_LABELS[p]).join(' · ')
              : 'No bindings yet'
          }
        />
        <StatCard
          label="Unclassified today"
          value={0}
          subline="ticket engine ships with PR-5"
          muted
        />
      </div>

      {/* Table */}
      {filteredApps.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500 text-[13px]">
          {initialApps.length === 0 ? (
            <>
              No apps registered yet.{' '}
              {isManager ? 'Add your first app to start tracking submissions.' : 'A MANAGER will register apps soon.'}
            </>
          ) : (
            <>No apps match the current filters.</>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[minmax(200px,260px)_minmax(180px,220px)_1fr_90px_110px_36px] gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <div>App</div>
            <div>Platforms linked</div>
            <div>Aliases</div>
            <div className="text-right">30d tickets</div>
            <div>Status</div>
            <div />
          </div>

          {filteredApps.map((app) => {
            const expanded = expandedIds.has(app.id);
            const preview = aliasesPreview(app.aliases);
            return (
              <div key={app.id} className="border-b border-slate-100 last:border-b-0">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(app.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(app.id);
                    }
                  }}
                  className="w-full grid grid-cols-[minmax(200px,260px)_minmax(180px,220px)_1fr_90px_110px_auto] gap-3 items-center px-5 py-3 hover:bg-slate-50/70 text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar name={app.name} color={colorFromId(app.id)} />
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-medium text-slate-900 truncate">
                        {app.display_name ?? app.name}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono truncate">{app.slug}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {PLATFORM_KEYS.map((key) => {
                      const linked = app.bindings.some((b) => b.platform_key === key);
                      return (
                        <span
                          key={key}
                          title={`${PLATFORM_LABELS[key]} ${linked ? 'linked' : 'not linked'}`}
                          className={`w-6 h-6 rounded flex items-center justify-center border ${
                            linked ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-40'
                          }`}
                        >
                          <PlatformIcon platform={key} />
                        </span>
                      );
                    })}
                    <span className="text-[11px] text-slate-400 ml-1">
                      {app.bindings.length} / 4
                    </span>
                  </div>

                  <div className="flex items-center gap-1 flex-wrap">
                    {preview.shown.map((alias) => (
                      <AliasChip key={alias.id} alias={alias} compact />
                    ))}
                    {preview.overflow > 0 && (
                      <span className="text-[11px] text-slate-400">+{preview.overflow}</span>
                    )}
                    {preview.shown.length === 0 && (
                      <span className="text-[11px] text-amber-700 italic">
                        No aliases — emails won&apos;t classify
                      </span>
                    )}
                  </div>

                  <div className="text-right text-[12.5px] font-mono text-slate-400">—</div>

                  <div>
                    <StatusBadge active={app.active} />
                  </div>

                  <div className="flex justify-end items-center gap-0.5 text-slate-400">
                    {isManager && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDialog({ kind: 'edit', app });
                          }}
                          title="Edit app"
                          className="p-1.5 rounded hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleArchiveToggle(app);
                          }}
                          disabled={isArchivingId === app.id}
                          title={app.active ? 'Archive' : 'Restore'}
                          className="p-1.5 rounded hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                        >
                          {app.active ? (
                            <Archive className="h-3.5 w-3.5" strokeWidth={1.8} />
                          ) : (
                            <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={1.8} />
                          )}
                        </button>
                      </>
                    )}
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 ml-1" strokeWidth={1.8} />
                    ) : (
                      <ChevronRight className="h-4 w-4 ml-1" strokeWidth={1.8} />
                    )}
                  </div>
                </div>

                {expanded && (
                  <ExpandedDetail
                    app={app}
                    isManager={isManager}
                    onAliasChanged={() => router.refresh()}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-400 text-right">
        {filteredApps.length} of {initialApps.length} {initialApps.length === 1 ? 'app' : 'apps'}
      </p>

      {dialog.kind === 'create' && (
        <AppDialog
          mode="create"
          teamUsers={teamUsers}
          onClose={() => setDialog({ kind: 'none' })}
          onSuccess={handleDialogSuccess}
        />
      )}
      {dialog.kind === 'edit' && (
        <AppDialog
          mode="edit"
          app={dialog.app}
          teamUsers={teamUsers}
          onClose={() => setDialog({ kind: 'none' })}
          onSuccess={handleDialogSuccess}
        />
      )}
      {dialog.kind === 'import' && (
        <CsvImportDialog
          onClose={() => setDialog({ kind: 'none' })}
          onSuccess={handleDialogSuccess}
        />
      )}
    </div>
  );
}

// -- Sub-components --------------------------------------------------------

function StatCard({
  label,
  value,
  suffix,
  subline,
  muted,
}: {
  label: string;
  value: number;
  suffix?: React.ReactNode;
  subline?: string;
  muted?: boolean;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3.5">
      <div className="text-[11px] text-slate-500 uppercase tracking-wider">{label}</div>
      <div className={`text-[28px] leading-none font-semibold mt-1 ${muted ? 'text-slate-400' : 'text-slate-900'}`}>
        {value}
        {suffix}
      </div>
      {subline && <div className={`text-[11px] mt-1 ${muted ? 'text-slate-400' : 'text-slate-500'}`}>{subline}</div>}
    </div>
  );
}

function FilterPill({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <label className="relative inline-flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 bg-white rounded-lg px-3 py-1.5 cursor-pointer">
      <span className="font-medium">{label}</span>
      <span className="text-slate-400 font-normal">{value}</span>
      <ChevronDown className="w-3 h-3 text-slate-400" strokeWidth={1.8} />
      {children}
    </label>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${
        active
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-slate-100 text-slate-500 border-slate-200'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-slate-400'}`}
      />
      {active ? 'Active' : 'Archived'}
    </span>
  );
}

function AliasChip({ alias, compact = false }: { alias: AppAliasRecord; compact?: boolean }) {
  const isRegex = alias.alias_regex !== null;
  const isAutoCurrent = alias.source_type === 'AUTO_CURRENT';
  const isHistorical = alias.source_type === 'AUTO_HISTORICAL';

  const label = isRegex ? (
    <span className="font-mono text-[10.5px]">/{alias.alias_regex}/</span>
  ) : (
    alias.alias_text
  );

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

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${
        compact ? 'text-[11px]' : 'text-[12px]'
      } ${chipClass}`}
      title={isHistorical && alias.previous_name ? `Previous name: ${alias.previous_name}` : undefined}
    >
      <span>{label}</span>
      {badge && (
        <span
          className={`font-mono uppercase tracking-wider px-1 py-[1px] rounded border ${badge.cls} ${
            compact ? 'text-[9px]' : 'text-[9.5px]'
          }`}
        >
          {badge.text}
        </span>
      )}
    </span>
  );
}

function ExpandedDetail({
  app,
  isManager,
  onAliasChanged,
}: {
  app: AppListRow;
  isManager: boolean;
  onAliasChanged: () => void;
}) {
  const bindingsByKey = new Map<PlatformKey, AppPlatformBindingRecord>();
  for (const b of app.bindings) bindingsByKey.set(b.platform_key, b);

  return (
    <div className="bg-slate-50 px-5 py-4 border-t border-slate-100">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">
        {/* Left: platforms + aliases */}
        <div className="space-y-4">
          <div>
            <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold mb-2">
              Platform bindings
            </div>
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {PLATFORM_KEYS.map((key) => {
                const b = bindingsByKey.get(key);
                return (
                  <div key={key} className="px-3 py-2.5 flex items-center gap-3 text-[12px]">
                    <span className="w-6 h-6 rounded flex items-center justify-center border border-slate-100 bg-white">
                      <PlatformIcon platform={key} />
                    </span>
                    <div className="w-32 text-slate-700">{PLATFORM_LABELS[key]}</div>
                    {b ? (
                      <>
                        <span className="flex-1 font-mono text-[11.5px] text-slate-900 truncate">
                          {b.platform_ref ?? <span className="italic text-slate-400">No reference</span>}
                        </span>
                        {b.console_url && (
                          <a
                            href={b.console_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11.5px] text-slate-600 hover:text-slate-900"
                          >
                            <ExternalLink className="w-3 h-3" strokeWidth={1.8} />
                            Console
                          </a>
                        )}
                      </>
                    ) : (
                      <span className="flex-1 italic text-slate-400">Not linked</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">
                Aliases (for email subject matching)
              </div>
              <div className="text-[10.5px] text-slate-400">
                The canonical app name is auto-added as an alias
              </div>
            </div>
            <AliasManager
              appId={app.id}
              aliases={app.aliases}
              disabled={!isManager}
              onChanged={onAliasChanged}
            />
            {!isManager && (
              <p className="text-[10.5px] text-slate-400 mt-1">
                Only MANAGER can add or remove aliases.
              </p>
            )}
          </div>
        </div>

        {/* Right: meta */}
        <div className="space-y-3">
          <div className="bg-white border border-slate-200 rounded-lg p-3">
            <div className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold mb-2">
              Meta
            </div>
            <dl className="space-y-2 text-[12px]">
              <MetaRow label="Owner" value={ownerLabel(app)} />
              <MetaRow label="Slug" value={<span className="font-mono">{app.slug}</span>} />
              <MetaRow
                label="Tracking since"
                value={new Date(app.tracking_since).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              />
              <MetaRow
                label="Updated"
                value={new Date(app.updated_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              />
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800 truncate">{value}</dd>
    </div>
  );
}
