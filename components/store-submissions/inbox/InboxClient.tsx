'use client';

/**
 * Client-side interactive shell for the Inbox.
 *
 * PR-10.2.2 adds state tabs + filter row with URL-synced state. The
 * ticket list area below still renders the 10.2.1 row-preview stub —
 * PR-10.2.3 swaps in the sortable + paginated table, and PR-10.2.4
 * layers in proper state / priority badges.
 *
 * State-sync contract:
 *   - URL query params are the source of truth.
 *   - Every filter/tab change calls `router.replace()` so the server
 *     re-renders page.tsx with new searchParams → fresh listTickets
 *     fetch. `useTransition` tracks the pending navigation for a
 *     subdued opacity/disabled UX while RSC streams.
 *   - Cursor is always dropped on filter change — the result set
 *     shifts, so stale cursors point nowhere useful.
 */

import { useCallback, useMemo, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';

import type { ListTicketsResult } from '@/lib/store-submissions/queries/tickets';
import type {
  TicketBucket,
  TicketsQuery,
  TicketSort,
  TicketState,
} from '@/lib/store-submissions/schemas/ticket';
import type { PlatformKey } from '@/lib/store-submissions/schemas/app';
import type { StoreRole } from '@/lib/store-submissions/auth';
import { TicketListTable } from './TicketListTable';

export interface InboxClientProps {
  initialData: ListTicketsResult;
  initialQuery: TicketsQuery;
  apps: Array<{ id: string; name: string }>;
  platforms: Array<{ key: string; display_name: string }>;
  /** Role-gated actions (state transitions) land in PR-10c. */
  role: StoreRole;
}

// -- Tabs -------------------------------------------------------------------

type TabKey = 'open' | 'rejected' | 'approved' | 'done' | 'archived' | 'unclassified';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'approved', label: 'Approved' },
  { key: 'done', label: 'Done' },
  { key: 'archived', label: 'Archived' },
  { key: 'unclassified', label: 'Unclassified' },
];

/**
 * Map the query state/bucket back to an active tab. The Open tab is the
 * default — it catches the "no explicit state/bucket" URL shape as well
 * as the literal Open state array (`[NEW, IN_REVIEW, REJECTED]`).
 */
function getActiveTab(query: TicketsQuery): TabKey {
  if (query.bucket === 'unclassified_any') return 'unclassified';
  if (typeof query.state === 'string') {
    if (query.state === 'APPROVED') return 'approved';
    if (query.state === 'DONE') return 'done';
    if (query.state === 'ARCHIVED') return 'archived';
    if (query.state === 'REJECTED') return 'rejected';
  }
  return 'open';
}

/**
 * Build the URL params for a tab click. Returns the mutations to apply
 * (state/bucket) — caller merges with existing filter params (platform,
 * app, search, etc) so non-state filters survive tab switches.
 */
function tabStateMutations(tab: TabKey): {
  states: TicketState[];
  bucket: TicketBucket | null;
} {
  switch (tab) {
    case 'open':
      // Intentionally empty — Open is the "no explicit filter" default;
      // the page applies it server-side. Clean URL for the common case.
      return { states: [], bucket: null };
    case 'rejected':
      return { states: ['REJECTED'], bucket: null };
    case 'approved':
      return { states: ['APPROVED'], bucket: null };
    case 'done':
      return { states: ['DONE'], bucket: null };
    case 'archived':
      return { states: ['ARCHIVED'], bucket: null };
    case 'unclassified':
      return { states: [], bucket: 'unclassified_any' };
  }
}

// -- Client component -------------------------------------------------------

export function InboxClient({
  initialData,
  initialQuery,
  apps,
  platforms,
  role,
}: InboxClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const activeTab = useMemo(() => getActiveTab(initialQuery), [initialQuery]);

  /**
   * Write a fresh URL, dropping `cursor` and keeping only filter params
   * that the caller passes in. Triggers RSC re-render of page.tsx.
   */
  const navigate = useCallback(
    (params: URLSearchParams) => {
      startTransition(() => {
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      });
    },
    [pathname, router],
  );

  /**
   * Build a URLSearchParams from the current query, excluding cursor
   * (always reset on filter/tab change) and the keys in `reset`. Used
   * as the starting point for every mutation so unrelated filters
   * survive.
   */
  const baseParams = useCallback(
    (reset: Array<keyof TicketsQuery> = []) => {
      const p = new URLSearchParams();
      const skip = new Set<string>(['cursor', ...(reset as string[])]);
      // state is array-valued; everything else is scalar.
      if (!skip.has('state') && initialQuery.state) {
        if (Array.isArray(initialQuery.state)) {
          for (const s of initialQuery.state) p.append('state', s);
        } else {
          p.set('state', initialQuery.state);
        }
      }
      const scalarKeys: Array<keyof TicketsQuery> = [
        'bucket',
        'platform_key',
        'app_id',
        'type_id',
        'priority',
        'assigned_to',
        'search',
        'opened_from',
        'opened_to',
        'sort',
        'limit',
      ];
      for (const k of scalarKeys) {
        if (skip.has(k)) continue;
        const v = initialQuery[k];
        if (v !== undefined && v !== null && v !== '') {
          p.set(k, String(v));
        }
      }
      return p;
    },
    [initialQuery],
  );

  // -- Handlers ---

  function selectTab(tab: TabKey) {
    const { states, bucket } = tabStateMutations(tab);
    const p = baseParams(['state', 'bucket']);
    for (const s of states) p.append('state', s);
    if (bucket) p.set('bucket', bucket);
    navigate(p);
  }

  function setScalarFilter(key: keyof TicketsQuery, value: string | undefined) {
    const p = baseParams([key]);
    if (value && value !== '') p.set(key, value);
    navigate(p);
  }

  function clearAllFilters() {
    navigate(new URLSearchParams());
  }

  /** True if any non-tab filter is active (platform/app/search/dates/sort non-default). */
  const hasActiveFilters = useMemo(() => {
    return Boolean(
      initialQuery.platform_key ||
        initialQuery.app_id ||
        initialQuery.search ||
        initialQuery.opened_from ||
        initialQuery.opened_to ||
        (initialQuery.sort && initialQuery.sort !== 'opened_at_desc'),
    );
  }, [initialQuery]);

  const { tickets, has_more } = initialData;

  return (
    <div
      className={`space-y-5 transition-opacity ${
        isPending ? 'opacity-60 pointer-events-none' : ''
      }`}
    >
      {/* -- State tabs -- */}
      <div className="border-b border-slate-200">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => {
            const active = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => selectTab(tab.key)}
                className={`relative px-4 py-2.5 text-[13px] font-medium transition-colors ${
                  active
                    ? 'text-slate-900'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab.label}
                {active && (
                  <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[#0071E3]" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* -- Filter row -- */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search
            className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            strokeWidth={1.8}
          />
          <input
            defaultValue={initialQuery.search ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setScalarFilter('search', e.currentTarget.value.trim() || undefined);
              }
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v !== (initialQuery.search ?? '')) {
                setScalarFilter('search', v || undefined);
              }
            }}
            placeholder="Search ticket ID (e.g. TK-…)"
            className="pl-8 pr-3 py-1.5 text-[13px] border border-slate-200 rounded-lg w-[260px] focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>

        <FilterPill
          label="Platform"
          value={
            initialQuery.platform_key
              ? platforms.find((p) => p.key === initialQuery.platform_key)?.display_name ??
                initialQuery.platform_key
              : 'All'
          }
        >
          <select
            value={initialQuery.platform_key ?? ''}
            onChange={(e) =>
              setScalarFilter('platform_key', e.target.value || undefined)
            }
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="">All platforms</option>
            {platforms.map((p) => (
              <option key={p.key} value={p.key as PlatformKey}>
                {p.display_name}
              </option>
            ))}
          </select>
        </FilterPill>

        <FilterPill
          label="App"
          value={
            initialQuery.app_id
              ? apps.find((a) => a.id === initialQuery.app_id)?.name ?? 'Unknown'
              : 'All'
          }
        >
          <select
            value={initialQuery.app_id ?? ''}
            onChange={(e) =>
              setScalarFilter('app_id', e.target.value || undefined)
            }
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </FilterPill>

        <FilterPill label="Sort" value={SORT_LABELS[initialQuery.sort]}>
          <select
            value={initialQuery.sort}
            onChange={(e) =>
              setScalarFilter('sort', e.target.value as TicketSort)
            }
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            {(Object.keys(SORT_LABELS) as TicketSort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </FilterPill>

        <DateRangeInputs
          from={initialQuery.opened_from}
          to={initialQuery.opened_to}
          onChangeFrom={(v) => setScalarFilter('opened_from', v)}
          onChangeTo={(v) => setScalarFilter('opened_to', v)}
        />

        {(hasActiveFilters || activeTab !== 'open') && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="inline-flex items-center gap-1 text-[12px] text-slate-500 hover:text-slate-900 px-2 py-1 rounded"
          >
            <X className="w-3 h-3" strokeWidth={1.8} />
            Clear filters
          </button>
        )}
      </div>

      {/* -- Ticket list -- */}
      <TicketListTable
        tickets={tickets}
        onRowClick={(t) => {
          // Detail panel wires up in PR-10b. Logging for dev-only visibility.
          if (process.env.NODE_ENV !== 'production') {
            // eslint-disable-next-line no-console
            console.debug('[inbox] row clicked:', t.display_id, t.id);
          }
        }}
      />

      {/* -- Pagination footer -- */}
      <div className="flex items-center justify-between text-[12px] text-slate-400">
        <span>
          {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}
          {initialQuery.cursor ? ' on this page' : ''}
          {' · '}role: <code className="font-mono">{role}</code>
        </span>

        {has_more && initialData.next_cursor && (
          <button
            type="button"
            onClick={() => {
              const p = baseParams([]);
              p.set('cursor', initialData.next_cursor as string);
              navigate(p);
            }}
            disabled={isPending}
            className="inline-flex items-center gap-1 text-[13px] text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 bg-white rounded-lg px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
            <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}

// -- Subcomponents ----------------------------------------------------------

const SORT_LABELS: Record<TicketSort, string> = {
  opened_at_desc: 'Newest',
  updated_at_desc: 'Recently updated',
  priority_desc: 'Priority',
};

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

function DateRangeInputs({
  from,
  to,
  onChangeFrom,
  onChangeTo,
}: {
  from?: string;
  to?: string;
  onChangeFrom: (v: string | undefined) => void;
  onChangeTo: (v: string | undefined) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 text-[13px] text-slate-600 border border-slate-200 rounded-lg px-2 py-1.5 bg-white">
      <span className="text-[12px] text-slate-400">Opened</span>
      <input
        type="date"
        defaultValue={from?.slice(0, 10) ?? ''}
        onChange={(e) => onChangeFrom(e.currentTarget.value || undefined)}
        className="text-[12px] bg-transparent focus:outline-none w-[110px]"
      />
      <span className="text-slate-300">→</span>
      <input
        type="date"
        defaultValue={to?.slice(0, 10) ?? ''}
        onChange={(e) => onChangeTo(e.currentTarget.value || undefined)}
        className="text-[12px] bg-transparent focus:outline-none w-[110px]"
      />
    </div>
  );
}

