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
