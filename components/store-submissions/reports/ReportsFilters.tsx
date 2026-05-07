'use client';

/**
 * Type filter for the Apple Reports surface (PR-22).
 *
 * URL is the source of truth. Selection updates `?type_id=<uuid>` via
 * `router.push`; the Server Component re-renders with the new param
 * threaded into all 4 aggregation queries. "All types" resets the
 * param entirely so the URL stays clean for the default view.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { FilterPill } from '@/components/store-submissions/ui/FilterPill';
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

