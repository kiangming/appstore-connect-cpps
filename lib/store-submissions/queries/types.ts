/**
 * Server-side read query for the `store_mgmt.types` table.
 *
 * Used by the Inbox to populate the Type filter pill (PR-17.1). Each
 * type belongs to exactly one platform — the Inbox UI scopes the
 * dropdown to whichever platform tab is active.
 *
 * Read-only; mutations live in the Email Rules editor's `saveRulesAction`.
 */

import { storeDb } from '../db';

export interface TypeRow {
  id: string;
  platform_id: string;
  name: string;
  slug: string;
  sort_order: number;
}

/**
 * Lists all active types across every platform. Filtering by platform is
 * done client-side in the Inbox so a single fetch backs the full pill;
 * total type count stays small (<100 across 4 platforms in production).
 */
export async function listAllTypes(): Promise<TypeRow[]> {
  const db = storeDb();
  const { data, error } = await db
    .from('types')
    .select('id, platform_id, name, slug, sort_order')
    .eq('active', true)
    .order('platform_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (error) {
    console.error('[store-types] listAllTypes failed:', error);
    throw new Error('Failed to load types');
  }

  return (data ?? []) as TypeRow[];
}
