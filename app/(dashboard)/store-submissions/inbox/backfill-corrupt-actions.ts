'use server';

/**
 * Server Action for MANAGER-triggered repair of corrupt-payload Apple
 * emails (PR-14.4).
 *
 * Targets rows whose `extracted_payload.app_name` or `raw_body_text`
 * carry control-byte residue from the pre-PR-14 byte-mask QP decoder
 * bug — see commit d20c898 for the parser fix and CLAUDE.md PR-14 entry
 * for the production diagnostic that surfaced 14 functional rows
 * across 4 distinct apps (Đấu Trường Chân Lý, 彈彈英雄, 創世紀戰M：阿
 * 修羅計畫, LMHT: Tốc Chiến).
 *
 * Pipeline: same as `backfillUnclassifiedAction` (PR-12.5) — re-fetch
 * Gmail HTML, re-parse via the now-byte-safe `parseGmailMessage`,
 * re-extract via `extractApple`, persist BOTH the corrected
 * `raw_body_text` and the new `extracted_payload`, atomic ticket swap
 * via `reclassify_email_tx`. Per-row engine is `backfillOne` from
 * `lib/store-submissions/backfill/core` — single source of truth.
 *
 * Difference from `backfillUnclassifiedAction`: candidate selection.
 * Unclassified backfill targets `extracted_payload IS NULL` — this
 * action targets rows where the payload IS populated but contains
 * control-byte residue (impossible in clean text; the regex
 * `[\x01-\x08\x0B\x0C\x0E-\x1F]` matches only the QP false-decode
 * fingerprint, NULL/TAB/LF/CR excluded).
 *
 * **PostgREST `.or()` regex syntax — runtime risk.** The candidate
 * filter uses `match` operators on `extracted_payload->>'app_name'`
 * and `raw_body_text` with a bracket character class. PostgREST is
 * known to handle `match` with simple patterns reliably; bracket
 * classes containing byte-escape sequences (`\x01`) are less commonly
 * exercised. If production logs show this filter returning 0 rows
 * despite the diagnostic Q-A counting matches (or 500s on the SELECT),
 * pivot to a `store_mgmt.get_corrupt_payload_emails(p_apple_emails)`
 * SQL function (forward-only migration). The decision-3 fallback path
 * is mechanical — same WHERE clause, just server-side.
 *
 * Sentry telemetry: `component: 'backfill-action'` (from `guardManager`)
 * + `variant: 'corrupt-payload'` so triage can distinguish this flow
 * from the NULL-payload backfill.
 */

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  requireStoreRole,
  StoreForbiddenError,
  StoreUnauthorizedError,
  type StoreUser,
} from '@/lib/store-submissions/auth';
import {
  backfillOne,
  createBackfillGmailClient,
  loadAppleSenderFilter,
  type BackfillBulkOptions,
  type BackfillContext,
  type BulkBackfillResult,
} from '@/lib/store-submissions/backfill/core';
import { storeDb } from '@/lib/store-submissions/db';

import type { ActionError, ActionResult } from './actions';

/**
 * Control-byte regex (Postgres POSIX flavor, escaped for the JS
 * string that supabase-js embeds in the URL query). Matches any byte
 * 0x01–0x08, 0x0B, 0x0C, 0x0E–0x1F. NULL (0x00) is excluded — parser
 * `sanitizeText` strips it. TAB / LF / CR are excluded — legitimate
 * whitespace.
 */
const CORRUPT_REGEX = '[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F]';

const CORRUPT_OR_FILTER =
  `extracted_payload->>app_name.match.${CORRUPT_REGEX},` +
  `raw_body_text.match.${CORRUPT_REGEX}`;

// -- Auth helper (MANAGER-only) ------------------------------------------

async function guardManager(): Promise<
  { user: StoreUser } | { error: ActionError }
> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, ['MANAGER']);
    Sentry.setUser({ id: user.id, username: user.role });
    Sentry.setTag('component', 'backfill-action');
    Sentry.setTag('variant', 'corrupt-payload');
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

// -- Public Server Action -----------------------------------------------

export async function backfillCorruptPayloadAction(
  options: BackfillBulkOptions = {},
): Promise<ActionResult<BulkBackfillResult>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'limit must be a positive integer or omitted',
      },
    };
  }

  const filter = await loadAppleSenderFilter();
  const stats: BulkBackfillResult = {
    total: 0,
    processed: 0,
    reclassified: 0,
    unchanged: 0,
    errors: [],
  };

  if (!filter) {
    return { ok: true, data: stats };
  }

  // Find candidates: control-byte residue in app_name or raw_body_text,
  // payload IS populated (functional rows only), not DROPPED, Apple sender.
  let query = storeDb()
    .from('email_messages')
    .select('id')
    .or(CORRUPT_OR_FILTER)
    .not('extracted_payload', 'is', null)
    .not('classification_status', 'eq', 'DROPPED')
    .in('sender_email', filter.appleEmails)
    .order('received_at', { ascending: true });

  if (limit !== undefined) {
    query = query.limit(limit);
  }

  const { data: rows, error: fetchErr } = await query;

  if (fetchErr) {
    Sentry.captureException(fetchErr, {
      tags: {
        component: 'backfill-action',
        variant: 'corrupt-payload',
        stage: 'fetch-candidates',
      },
    });
    return {
      ok: false,
      error: {
        code: 'DB_ERROR',
        message: 'Failed to load candidate emails.',
      },
    };
  }

  const ids = (rows ?? []).map((r) => (r as { id: string }).id);
  stats.total = ids.length;

  if (ids.length === 0) {
    return { ok: true, data: stats };
  }

  const clientResult = await createBackfillGmailClient();
  if ('error' in clientResult) {
    return { ok: false, error: clientResult.error };
  }

  const ctx: BackfillContext = {
    gmailClient: clientResult.client,
    isAppleSender: filter.isAppleSender,
  };

  for (const id of ids) {
    try {
      const result = await backfillOne(id, guard.user.id, ctx);
      stats.processed++;
      if (result.reclassify.changed) {
        stats.reclassified++;
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.errors.push({ emailMessageId: id, error: message });
      console.error('[backfill-corrupt] bulk per-row failure:', { id, err });
      Sentry.captureException(err, {
        tags: {
          component: 'backfill-action',
          variant: 'corrupt-payload',
          stage: 'bulk-row',
        },
        extra: { emailMessageId: id },
      });
    }
  }

  revalidatePath('/store-submissions/inbox');
  return { ok: true, data: stats };
}
