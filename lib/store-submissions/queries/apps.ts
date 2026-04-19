/**
 * Server-side read queries for the Store Management App Registry.
 *
 * Mutations live in Server Actions in
 * app/(dashboard)/store-submissions/config/apps/actions.ts — this module is
 * read-only and safe to call from Server Components or Server Actions.
 *
 * Typed shapes exported here are the canonical representation used by the
 * App Registry UI (list table, detail expand, dialogs).
 */

import { storeDb } from '../db';
import type { PlatformKey } from '../schemas/app';

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  display_name: string | null;
  team_owner_id: string | null;
  active: boolean;
  tracking_since: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface AppAliasRecord {
  id: string;
  app_id: string;
  alias_text: string | null;
  alias_regex: string | null;
  source_type: 'AUTO_CURRENT' | 'AUTO_HISTORICAL' | 'MANUAL' | 'REGEX';
  previous_name: string | null;
  created_at: string;
}

export interface AppPlatformBindingRecord {
  id: string;
  app_id: string;
  platform_id: string;
  platform_key: PlatformKey;
  platform_display_name: string;
  platform_ref: string | null;
  console_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppListRow extends AppRecord {
  aliases: AppAliasRecord[];
  bindings: AppPlatformBindingRecord[];
  team_owner_email: string | null;
  team_owner_display_name: string | null;
}

export interface ListAppsFilters {
  search?: string;
  platform?: PlatformKey;
  active?: boolean;
  teamOwnerId?: string;
}

const APP_COLUMNS =
  'id, slug, name, display_name, team_owner_id, active, tracking_since, created_at, updated_at, created_by';

const ALIAS_COLUMNS =
  'id, app_id, alias_text, alias_regex, source_type, previous_name, created_at';

/**
 * List apps with aliases + platform bindings eagerly joined.
 *
 * Filters:
 *   - search: case-insensitive match against name, slug, or any alias_text
 *   - platform: only apps that have a binding to the given platform key
 *   - active: true|false — omit to include both
 *   - teamOwnerId: UUID
 *
 * Returns rows ordered by lower(name) ascending. Intended for the App Registry
 * list view; row count is expected to stay under a few hundred apps.
 */
export async function listApps(filters: ListAppsFilters = {}): Promise<AppListRow[]> {
  const db = storeDb();

  let matchingAppIds: Set<string> | null = null;

  if (filters.search && filters.search.trim() !== '') {
    const needle = filters.search.trim();
    const escaped = needle.replace(/[%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;

    const { data: aliasMatches, error: aliasErr } = await db
      .from('app_aliases')
      .select('app_id')
      .ilike('alias_text', pattern);

    if (aliasErr) {
      console.error('[store-apps] listApps alias search failed:', aliasErr);
      throw new Error('Failed to search apps');
    }

    const { data: nameMatches, error: nameErr } = await db
      .from('apps')
      .select('id')
      .or(`name.ilike.${pattern},slug.ilike.${pattern}`);

    if (nameErr) {
      console.error('[store-apps] listApps name search failed:', nameErr);
      throw new Error('Failed to search apps');
    }

    matchingAppIds = new Set<string>();
    for (const r of aliasMatches ?? []) matchingAppIds.add((r as { app_id: string }).app_id);
    for (const r of nameMatches ?? []) matchingAppIds.add((r as { id: string }).id);

    if (matchingAppIds.size === 0) return [];
  }

  if (filters.platform) {
    const { data: platformRow, error: platformErr } = await db
      .from('platforms')
      .select('id')
      .eq('key', filters.platform)
      .maybeSingle();

    if (platformErr) {
      console.error('[store-apps] platform lookup failed:', platformErr);
      throw new Error('Failed to filter by platform');
    }
    if (!platformRow) return [];

    const { data: bindings, error: bindErr } = await db
      .from('app_platform_bindings')
      .select('app_id')
      .eq('platform_id', (platformRow as { id: string }).id);

    if (bindErr) {
      console.error('[store-apps] binding filter failed:', bindErr);
      throw new Error('Failed to filter by platform');
    }

    const bindingAppIds = new Set<string>(
      (bindings ?? []).map((b) => (b as { app_id: string }).app_id),
    );
    matchingAppIds = matchingAppIds
      ? new Set([...matchingAppIds].filter((id) => bindingAppIds.has(id)))
      : bindingAppIds;

    if (matchingAppIds.size === 0) return [];
  }

  let appQuery = db.from('apps').select(APP_COLUMNS).order('name', { ascending: true });
  if (filters.active !== undefined) appQuery = appQuery.eq('active', filters.active);
  if (filters.teamOwnerId) appQuery = appQuery.eq('team_owner_id', filters.teamOwnerId);
  if (matchingAppIds) appQuery = appQuery.in('id', Array.from(matchingAppIds));

  const { data: apps, error: appsErr } = await appQuery;
  if (appsErr) {
    console.error('[store-apps] listApps fetch failed:', appsErr);
    throw new Error('Failed to load apps');
  }
  if (!apps || apps.length === 0) return [];

  const appIds = apps.map((a) => (a as AppRecord).id);
  const [aliasesRes, bindingsRes, ownersRes, platformsRes] = await Promise.all([
    db.from('app_aliases').select(ALIAS_COLUMNS).in('app_id', appIds),
    db
      .from('app_platform_bindings')
      .select('id, app_id, platform_id, platform_ref, console_url, created_at, updated_at')
      .in('app_id', appIds),
    (async () => {
      const ownerIds = Array.from(
        new Set(
          apps
            .map((a) => (a as AppRecord).team_owner_id)
            .filter((id): id is string => id !== null),
        ),
      );
      if (ownerIds.length === 0) return { data: [], error: null };
      return db
        .from('users')
        .select('id, email, display_name')
        .in('id', ownerIds);
    })(),
    db.from('platforms').select('id, key, display_name'),
  ]);

  if (aliasesRes.error || bindingsRes.error || ownersRes.error || platformsRes.error) {
    console.error('[store-apps] listApps related-fetch failed:', {
      aliases: aliasesRes.error,
      bindings: bindingsRes.error,
      owners: ownersRes.error,
      platforms: platformsRes.error,
    });
    throw new Error('Failed to load app details');
  }

  const platformById = new Map<
    string,
    { key: PlatformKey; display_name: string }
  >();
  for (const p of platformsRes.data ?? []) {
    const row = p as { id: string; key: PlatformKey; display_name: string };
    platformById.set(row.id, { key: row.key, display_name: row.display_name });
  }

  const ownerById = new Map<string, { email: string; display_name: string | null }>();
  for (const u of ownersRes.data ?? []) {
    const row = u as { id: string; email: string; display_name: string | null };
    ownerById.set(row.id, { email: row.email, display_name: row.display_name });
  }

  const aliasesByApp = new Map<string, AppAliasRecord[]>();
  for (const a of (aliasesRes.data ?? []) as AppAliasRecord[]) {
    const bucket = aliasesByApp.get(a.app_id) ?? [];
    bucket.push(a);
    aliasesByApp.set(a.app_id, bucket);
  }

  const bindingsByApp = new Map<string, AppPlatformBindingRecord[]>();
  for (const b of bindingsRes.data ?? []) {
    const row = b as {
      id: string;
      app_id: string;
      platform_id: string;
      platform_ref: string | null;
      console_url: string | null;
      created_at: string;
      updated_at: string;
    };
    const platform = platformById.get(row.platform_id);
    if (!platform) continue;
    const bucket = bindingsByApp.get(row.app_id) ?? [];
    bucket.push({
      id: row.id,
      app_id: row.app_id,
      platform_id: row.platform_id,
      platform_key: platform.key,
      platform_display_name: platform.display_name,
      platform_ref: row.platform_ref,
      console_url: row.console_url,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    bindingsByApp.set(row.app_id, bucket);
  }

  return apps.map((a) => {
    const app = a as AppRecord;
    const owner = app.team_owner_id ? ownerById.get(app.team_owner_id) ?? null : null;
    return {
      ...app,
      aliases: aliasesByApp.get(app.id) ?? [],
      bindings: bindingsByApp.get(app.id) ?? [],
      team_owner_email: owner?.email ?? null,
      team_owner_display_name: owner?.display_name ?? null,
    };
  });
}

export async function getApp(id: string): Promise<AppListRow | null> {
  const { data: app, error } = await storeDb()
    .from('apps')
    .select(APP_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[store-apps] getApp failed:', error);
    throw new Error('Failed to load app');
  }
  if (!app) return null;

  const rows = await listApps({}).then((all) => all.filter((r) => r.id === id));
  return rows[0] ?? null;
}

export async function getAppBySlug(slug: string): Promise<AppListRow | null> {
  const { data: app, error } = await storeDb()
    .from('apps')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.error('[store-apps] getAppBySlug failed:', error);
    throw new Error('Failed to load app');
  }
  if (!app) return null;
  return getApp((app as { id: string }).id);
}

/**
 * List aliases for a single app, ordered with AUTO_CURRENT first. Used by
 * the rename Server Action to feed deriveAliasChangesOnRename.
 */
export async function listAliasesForApp(appId: string): Promise<AppAliasRecord[]> {
  const { data, error } = await storeDb()
    .from('app_aliases')
    .select(ALIAS_COLUMNS)
    .eq('app_id', appId);

  if (error) {
    console.error('[store-apps] listAliasesForApp failed:', error);
    throw new Error('Failed to load aliases');
  }
  return (data ?? []) as AppAliasRecord[];
}

/**
 * Count open tickets across a given set of app IDs. Used by Server Actions
 * when choosing between soft-toggle and hard-delete for an app.
 *
 * @internal Consumed by deleteAppAction. Tickets table lands in PR-5, so this
 * helper tolerates the table being absent for now and returns 0 — guarded by
 * a try/catch on "relation does not exist".
 */
export async function countOpenTicketsForApp(appId: string): Promise<number> {
  const { count, error } = await storeDb()
    .from('tickets')
    .select('id', { count: 'exact', head: true })
    .eq('app_id', appId)
    .in('state', ['NEW', 'IN_REVIEW', 'REJECTED']);

  if (error) {
    if (error.code === '42P01') return 0;
    console.error('[store-apps] countOpenTicketsForApp failed:', error);
    throw new Error('Failed to count tickets');
  }
  return count ?? 0;
}
