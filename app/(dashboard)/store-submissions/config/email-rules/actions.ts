'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  requireStoreRole,
  type StoreUser,
} from '@/lib/store-submissions/auth';
import { storeDb } from '@/lib/store-submissions/db';
import {
  getRuleVersion,
  listRuleVersions,
  type RuleVersionRow,
} from '@/lib/store-submissions/queries/rules';
import {
  configSnapshotSchema,
  rollbackRulesInputSchema,
  saveRulesInputSchema,
  type SaveRulesInput,
} from '@/lib/store-submissions/schemas/rules';

/**
 * Server Actions for the Email Rules config screen.
 *
 * Surface (diverges from the PR-5 plan's "8 actions — CRUD per rule type"):
 *   - saveRulesAction       Bulk replace all 4 rule sets for a platform
 *                           in a single transaction. Appends a rule_versions
 *                           snapshot. The UI holds draft state and submits
 *                           the entire form, so per-rule CRUD endpoints would
 *                           be redundant.
 *   - rollbackRulesAction   Restore a previous version. Implemented as a new
 *                           version append (never overwrites history).
 *
 * Both actions go through PL/pgSQL RPCs defined in the matching migration
 * (`store_mgmt.save_rules_tx`, `store_mgmt.rollback_rules_tx`) so the
 * delete + insert + version-snapshot sequence is atomic. The RPCs take
 * responsibility for:
 *   - version_number allocation with a retry-on-unique-violation loop
 *     (two concurrent Managers can both press Save)
 *   - foreign key cleanup (subject_patterns / types / submission_id_patterns
 *     cascade via platform_id on delete)
 *
 * RBAC: MANAGER-only. Enforced in guardManager() before touching the DB.
 */

export type ActionError =
  | {
      code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'VALIDATION' | 'NOT_FOUND' | 'DB_ERROR';
      message: string;
      details?: unknown;
    }
  | {
      code: 'VERSION_CONFLICT';
      message: string;
      expectedVersion: number | null;
      actualVersion: number | null;
    };

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

const EMAIL_RULES_PATH = '/store-submissions/config/email-rules';

// -- Guards ----------------------------------------------------------------

async function guardManager(): Promise<{ user: StoreUser } | { error: ActionError }> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, 'MANAGER');
    return { user };
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }
}

function firstValidationMessage(issues: readonly { message: string }[]): string {
  return issues[0]?.message ?? 'Invalid input';
}

/**
 * Parse the numeric parts of a VERSION_CONFLICT sqlerrm.
 *
 * RPC raises:   VERSION_CONFLICT: expected v<N|none>, actual v<N|none>
 * where <none> stands in for NULL (no prior save exists). Returned numbers
 * feed the client toast ("Rules updated to v13 by another Manager…").
 */
function parseVersionConflict(
  message: string,
): { expected: number | null; actual: number | null } {
  const parseToken = (tok: string | undefined): number | null => {
    if (!tok || tok === 'none') return null;
    const n = Number.parseInt(tok, 10);
    return Number.isFinite(n) ? n : null;
  };
  const m = /expected v(\d+|none),\s*actual v(\d+|none)/.exec(message);
  if (!m) return { expected: null, actual: null };
  return { expected: parseToken(m[1]), actual: parseToken(m[2]) };
}

/**
 * PostgREST / Postgres error → ActionError mapping for rule RPCs. See the
 * RPC migration for the raised sqlerrm prefixes.
 */
function mapRpcError(message: string | null | undefined): ActionError | null {
  if (!message) return null;
  if (message.includes('VERSION_CONFLICT')) {
    const parts = parseVersionConflict(message);
    return {
      code: 'VERSION_CONFLICT',
      message:
        'Another save happened concurrently — reload to pick up the latest rules before saving again.',
      expectedVersion: parts.expected,
      actualVersion: parts.actual,
    };
  }
  if (message.includes('NOT_FOUND')) {
    return { code: 'NOT_FOUND', message };
  }
  if (message.includes('INVALID_ARG')) {
    return { code: 'VALIDATION', message };
  }
  return null;
}

// -- Save rules (bulk replace + version snapshot) -------------------------

/**
 * Replace the entire rule set for a single platform and append a version
 * snapshot.
 *
 * Atomicity: one RPC call = one transaction. On success the action returns
 * the new `version_number` only (per PR-5 spec decision — the client is
 * expected to invalidate via TanStack Query and refetch, not merge the
 * response into cache). A failed save leaves DB unchanged.
 */
export async function saveRulesAction(
  input: unknown,
): Promise<ActionResult<{ version_number: number }>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = saveRulesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
        details: parsed.error.issues,
      },
    };
  }
  const data = parsed.data satisfies SaveRulesInput;

  const { data: rpcData, error } = await storeDb().rpc('save_rules_tx', {
    p_platform_id: data.platform_id,
    p_expected_version_number: data.expected_version_number,
    p_senders: data.senders.map((s) => ({
      email: s.email,
      is_primary: s.is_primary,
      active: s.active,
    })),
    p_subject_patterns: data.subject_patterns.map((p) => ({
      outcome: p.outcome,
      regex: p.regex,
      priority: p.priority,
      example_subject: p.example_subject ?? null,
      active: p.active,
    })),
    p_types: data.types.map((t) => ({
      name: t.name,
      slug: t.slug,
      body_keyword: t.body_keyword,
      payload_extract_regex: t.payload_extract_regex ?? null,
      sort_order: t.sort_order,
      active: t.active,
    })),
    p_submission_id_patterns: data.submission_id_patterns.map((p) => ({
      body_regex: p.body_regex,
      active: p.active,
    })),
    p_saved_by: guard.user.id,
    p_note: data.note ?? null,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    if (mapped) return { ok: false, error: mapped };
    console.error('[store-rules] saveRulesAction:', error);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to save rules' } };
  }

  revalidatePath(EMAIL_RULES_PATH);
  return {
    ok: true,
    data: { version_number: rpcData as number },
  };
}

// -- Rollback to a previous version --------------------------------------

/**
 * Restore the platform's rule set to a previously-saved version and append
 * a new version row (never overwrites history). The RPC uses the stored
 * `config_snapshot` as the source of truth — rows are re-inserted with
 * fresh UUIDs, so any `rule_id` stored on historical classification results
 * will not resolve after rollback (this is noted in spec §7.2).
 */
export async function rollbackRulesAction(
  input: unknown,
): Promise<ActionResult<{ version_number: number }>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = rollbackRulesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const { data: rpcData, error } = await storeDb().rpc('rollback_rules_tx', {
    p_platform_id: parsed.data.platform_id,
    p_target_version: parsed.data.target_version,
    p_saved_by: guard.user.id,
    p_note: parsed.data.note ?? null,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    if (mapped) return { ok: false, error: mapped };
    console.error('[store-rules] rollbackRulesAction:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to roll back rules' },
    };
  }

  revalidatePath(EMAIL_RULES_PATH);
  return {
    ok: true,
    data: { version_number: rpcData as number },
  };
}

// -- Version history reads (MANAGER-only) --------------------------------

export interface VersionSummary {
  id: string;
  version_number: number;
  saved_at: string;
  saved_by_email: string | null;
  saved_by_display_name: string | null;
  note: string | null;
}

export interface VersionDetail extends VersionSummary {
  /**
   * Counts derived from the stored config_snapshot. We compute them
   * server-side so the client pays one round-trip for "how big was this
   * version?" without deserializing ~hundreds of rows it would throw away.
   * Full side-by-side diff view is deferred (see TODO.md "[PR-5 polish]
   * VersionHistoryDialog full diff view").
   */
  counts: {
    senders: number;
    subject_patterns: number;
    types: number;
    submission_id_patterns: number;
  };
}

/**
 * List the 50 most recent versions for the given platform (metadata only,
 * no config_snapshot). Powers the top of the Version History dialog.
 *
 * RBAC: MANAGER-only — consistent with saveRulesAction / rollbackRulesAction.
 * DEV/VIEWER don't reach this screen because the config page redirects them.
 */
export async function listRuleVersionsAction(
  platformId: string,
): Promise<ActionResult<VersionSummary[]>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  if (typeof platformId !== 'string' || platformId === '') {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'platformId is required' },
    };
  }

  let rows: RuleVersionRow[];
  try {
    rows = await listRuleVersions(platformId, 50);
  } catch (err) {
    console.error('[store-rules] listRuleVersionsAction:', err);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to load version history' },
    };
  }

  const data: VersionSummary[] = rows.map((r) => ({
    id: r.id,
    version_number: r.version_number,
    saved_at: r.saved_at,
    saved_by_email: r.saved_by_email,
    saved_by_display_name: r.saved_by_display_name,
    note: r.note,
  }));

  return { ok: true, data };
}

/**
 * Counts inside a config_snapshot without allocating the full arrays for
 * the UI. Values default to 0 when a field is missing so we stay resilient
 * to older snapshots that might predate a rule type.
 *
 * Exported so a future diff-view implementation can reuse the same source
 * of truth — and the unit test pins the invariant that "empty object →
 * all zeros" rather than "throws".
 */
export function countSnapshotRows(
  snapshot: unknown,
): VersionDetail['counts'] {
  const parsed = configSnapshotSchema.safeParse(snapshot);
  if (parsed.success) {
    return {
      senders: parsed.data.senders.length,
      subject_patterns: parsed.data.subject_patterns.length,
      types: parsed.data.types.length,
      submission_id_patterns: parsed.data.submission_id_patterns.length,
    };
  }
  // Best-effort fallback — old snapshots that fail the strict zod schema
  // can still surface partial counts (e.g. schema_version was added later).
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    senders: arr(s.senders),
    subject_patterns: arr(s.subject_patterns),
    types: arr(s.types),
    submission_id_patterns: arr(s.submission_id_patterns),
  };
}

/**
 * Fetch one version's details for the expanded row in Version History.
 * Returns counts (not the full rule set) to keep the payload small —
 * rollback semantics do NOT need the client to see the snapshot because
 * the RPC reads it server-side.
 */
export async function getRuleVersionAction(input: {
  platform_id: string;
  version_number: number;
}): Promise<ActionResult<VersionDetail>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  if (
    typeof input.platform_id !== 'string' ||
    input.platform_id === '' ||
    !Number.isInteger(input.version_number) ||
    input.version_number < 1
  ) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'platform_id and version_number are required',
      },
    };
  }

  try {
    const row = await getRuleVersion(input.platform_id, input.version_number);
    if (!row) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `Version v${input.version_number} not found`,
        },
      };
    }
    return {
      ok: true,
      data: {
        id: row.id,
        version_number: row.version_number,
        saved_at: row.saved_at,
        saved_by_email: row.saved_by_email,
        saved_by_display_name: row.saved_by_display_name,
        note: row.note,
        counts: countSnapshotRows(row.config_snapshot),
      },
    };
  } catch (err) {
    console.error('[store-rules] getRuleVersionAction:', err);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to load version detail' },
    };
  }
}
