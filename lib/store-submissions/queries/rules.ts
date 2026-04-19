/**
 * Server-side read queries for the Store Management email rule engine.
 *
 * Read-only, safe to call from Server Components or Server Actions.
 * Mutations live in
 *   app/(dashboard)/store-submissions/config/email-rules/actions.ts
 *
 * Resource shapes here mirror store_mgmt tables 1:1 and are used by the
 * Email Rules UI (list view, editor, version history dialog).
 */

import { storeDb } from '../db';
import type { Outcome } from '../schemas/rules';

// -- Record shapes -------------------------------------------------------

export interface PlatformRow {
  id: string;
  key: string;
  display_name: string;
  active: boolean;
}

export interface SenderRow {
  id: string;
  platform_id: string;
  email: string;
  is_primary: boolean;
  active: boolean;
}

export interface SubjectPatternRow {
  id: string;
  platform_id: string;
  outcome: Outcome;
  regex: string;
  priority: number;
  example_subject: string | null;
  active: boolean;
}

export interface TypeRow {
  id: string;
  platform_id: string;
  name: string;
  slug: string;
  body_keyword: string;
  payload_extract_regex: string | null;
  sort_order: number;
  active: boolean;
}

export interface SubmissionIdPatternRow {
  id: string;
  platform_id: string;
  body_regex: string;
  active: boolean;
}

export interface PlatformRules {
  platform: PlatformRow;
  senders: SenderRow[];
  subject_patterns: SubjectPatternRow[];
  types: TypeRow[];
  submission_id_patterns: SubmissionIdPatternRow[];
  latest_version: number | null;
}

export interface RuleVersionRow {
  id: string;
  platform_id: string;
  version_number: number;
  saved_by: string | null;
  saved_at: string;
  note: string | null;
  saved_by_email: string | null;
  saved_by_display_name: string | null;
}

export interface RuleVersionDetail extends RuleVersionRow {
  config_snapshot: unknown;
}

// -- Queries -------------------------------------------------------------

export async function listPlatforms(): Promise<PlatformRow[]> {
  const { data, error } = await storeDb()
    .from('platforms')
    .select('id, key, display_name, active')
    .eq('active', true)
    .order('display_name', { ascending: true });

  if (error) {
    console.error('[store-rules] listPlatforms failed:', error);
    throw new Error('Failed to load platforms');
  }
  return (data ?? []) as PlatformRow[];
}

export async function getPlatformByKey(key: string): Promise<PlatformRow | null> {
  const { data, error } = await storeDb()
    .from('platforms')
    .select('id, key, display_name, active')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error('[store-rules] getPlatformByKey failed:', error);
    throw new Error('Failed to load platform');
  }
  return (data as PlatformRow | null) ?? null;
}

/**
 * Fetch the full rule set for one platform — senders, subject patterns, types,
 * submission_id patterns — plus the latest rule_versions.version_number so
 * the UI can render a version badge alongside the editor.
 *
 * Returns `null` when the platform is not found (lets the caller surface a
 * 404 instead of pretending the platform has empty rules).
 */
export async function getRulesForPlatform(
  platformId: string,
): Promise<PlatformRules | null> {
  const db = storeDb();

  const { data: platform, error: platformErr } = await db
    .from('platforms')
    .select('id, key, display_name, active')
    .eq('id', platformId)
    .maybeSingle();

  if (platformErr) {
    console.error('[store-rules] getRulesForPlatform platform:', platformErr);
    throw new Error('Failed to load platform');
  }
  if (!platform) return null;

  const [sendersRes, subjectRes, typesRes, subIdRes, versionRes] = await Promise.all([
    db
      .from('senders')
      .select('id, platform_id, email, is_primary, active')
      .eq('platform_id', platformId)
      .order('is_primary', { ascending: false })
      .order('email', { ascending: true }),
    db
      .from('subject_patterns')
      .select('id, platform_id, outcome, regex, priority, example_subject, active')
      .eq('platform_id', platformId)
      .order('priority', { ascending: true }),
    db
      .from('types')
      .select(
        'id, platform_id, name, slug, body_keyword, payload_extract_regex, sort_order, active',
      )
      .eq('platform_id', platformId)
      .order('sort_order', { ascending: true }),
    db
      .from('submission_id_patterns')
      .select('id, platform_id, body_regex, active')
      .eq('platform_id', platformId)
      .order('created_at', { ascending: true }),
    db
      .from('rule_versions')
      .select('version_number')
      .eq('platform_id', platformId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const r of [sendersRes, subjectRes, typesRes, subIdRes, versionRes]) {
    if (r.error) {
      console.error('[store-rules] getRulesForPlatform related-fetch:', r.error);
      throw new Error('Failed to load platform rules');
    }
  }

  return {
    platform: platform as PlatformRow,
    senders: (sendersRes.data ?? []) as SenderRow[],
    subject_patterns: (subjectRes.data ?? []) as SubjectPatternRow[],
    types: (typesRes.data ?? []) as TypeRow[],
    submission_id_patterns: (subIdRes.data ?? []) as SubmissionIdPatternRow[],
    latest_version:
      versionRes.data === null
        ? null
        : (versionRes.data as { version_number: number }).version_number,
  };
}

/**
 * List rule versions for a platform, most-recent first. Intended for the
 * version history dialog — lightweight (excludes the JSONB config_snapshot
 * which can be large).
 *
 * `saved_by_email` / `saved_by_display_name` are eagerly joined from
 * `store_mgmt.users` so the UI doesn't need a second round-trip per version.
 */
export async function listRuleVersions(
  platformId: string,
  limit = 50,
): Promise<RuleVersionRow[]> {
  const db = storeDb();
  const { data: rows, error } = await db
    .from('rule_versions')
    .select('id, platform_id, version_number, saved_by, saved_at, note')
    .eq('platform_id', platformId)
    .order('version_number', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[store-rules] listRuleVersions:', error);
    throw new Error('Failed to load rule versions');
  }
  if (!rows || rows.length === 0) return [];

  const savedByIds = Array.from(
    new Set(
      (rows as Array<{ saved_by: string | null }>)
        .map((r) => r.saved_by)
        .filter((id): id is string => id !== null),
    ),
  );
  const userByIdP =
    savedByIds.length === 0
      ? Promise.resolve(
          new Map<string, { email: string; display_name: string | null }>(),
        )
      : db
          .from('users')
          .select('id, email, display_name')
          .in('id', savedByIds)
          .then((res) => {
            if (res.error) {
              console.error('[store-rules] listRuleVersions users:', res.error);
              throw new Error('Failed to load version authors');
            }
            const map = new Map<string, { email: string; display_name: string | null }>();
            for (const u of res.data ?? []) {
              const row = u as { id: string; email: string; display_name: string | null };
              map.set(row.id, { email: row.email, display_name: row.display_name });
            }
            return map;
          });

  const userById = await userByIdP;
  return (rows as Array<{
    id: string;
    platform_id: string;
    version_number: number;
    saved_by: string | null;
    saved_at: string;
    note: string | null;
  }>).map((r) => {
    const u = r.saved_by ? userById.get(r.saved_by) ?? null : null;
    return {
      ...r,
      saved_by_email: u?.email ?? null,
      saved_by_display_name: u?.display_name ?? null,
    };
  });
}

/**
 * Fetch a single rule version row *including* its config_snapshot. Used by
 * the rollback flow and version-diff UI. The snapshot is untyped at this
 * boundary — the caller validates via `configSnapshotSchema` before use.
 */
export async function getRuleVersion(
  platformId: string,
  versionNumber: number,
): Promise<RuleVersionDetail | null> {
  const { data, error } = await storeDb()
    .from('rule_versions')
    .select(
      'id, platform_id, version_number, saved_by, saved_at, note, config_snapshot',
    )
    .eq('platform_id', platformId)
    .eq('version_number', versionNumber)
    .maybeSingle();

  if (error) {
    console.error('[store-rules] getRuleVersion:', error);
    throw new Error('Failed to load rule version');
  }
  if (!data) return null;

  const row = data as {
    id: string;
    platform_id: string;
    version_number: number;
    saved_by: string | null;
    saved_at: string;
    note: string | null;
    config_snapshot: unknown;
  };

  let saved_by_email: string | null = null;
  let saved_by_display_name: string | null = null;
  if (row.saved_by) {
    const { data: user } = await storeDb()
      .from('users')
      .select('email, display_name')
      .eq('id', row.saved_by)
      .maybeSingle();
    if (user) {
      const u = user as { email: string; display_name: string | null };
      saved_by_email = u.email;
      saved_by_display_name = u.display_name;
    }
  }

  return {
    ...row,
    saved_by_email,
    saved_by_display_name,
  };
}
