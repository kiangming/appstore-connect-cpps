'use client';

/**
 * Type filter for the Apple Reports surface (PR-22).
 *
 * URL is the source of truth. Selection updates `?type_id=<uuid>` via
 * `router.push`; the Server Component re-renders with the new param
 * threaded into all 4 aggregation queries. "All types" resets the
 * param entirely so the URL stays clean for the default view.
 *
 * `FilterPill` is a minimal inline copy of the Inbox surface's pill
 * (InboxClient.tsx:1026). Reports doesn't need the disabled/hint
 * affordance the Inbox uses for platform-dependent type scoping —
 * here the platform is always Apple. Once a third confirmed copy
 * accumulates (Apps + Inbox + Reports), a dedicated PR can extract
 * to a shared component; for now the duplication is intentional
 * minimum-blast-radius scope.
 */

import { ChevronDown } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import type { TypeRow } from '@/lib/store-submissions/queries/types';

interface ReportsFiltersProps {
  types: TypeRow[];
  selectedTypeId?: string;
}

export function ReportsFilters({ types, selectedTypeId }: ReportsFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function handleChange(typeId: string | undefined) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (typeId) params.set('type_id', typeId);
    else params.delete('type_id');
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : '?');
    });
  }

  const selectedLabel = selectedTypeId
    ? types.find((t) => t.id === selectedTypeId)?.name ?? 'Unknown'
    : 'All types';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <FilterPill label="Type" value={selectedLabel} dim={isPending}>
        <select
          value={selectedTypeId ?? ''}
          onChange={(e) => handleChange(e.target.value || undefined)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </FilterPill>
    </div>
  );
}

function FilterPill({
  label,
  value,
  children,
  dim = false,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <label
      className={`relative inline-flex items-center gap-1.5 text-[13px] border rounded-lg px-3 py-1.5 cursor-pointer ${
        dim
          ? 'text-slate-400 border-slate-100 bg-slate-50'
          : 'text-slate-600 hover:text-slate-900 border-slate-200 hover:border-slate-300 bg-white'
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className="text-slate-400 font-normal">{value}</span>
      <ChevronDown className="w-3 h-3 text-slate-400" strokeWidth={1.8} />
      {children}
    </label>
  );
}
