/**
 * POST /api/store-submissions/sync/gmail  (cron endpoint)
 *
 * Stateless trigger for the Gmail sync orchestrator. Railway's cron
 * service calls this every 5 minutes; ops + the (future) "Sync now"
 * Settings button may call it manually. No user session involved — auth
 * is a shared-secret check against `CRON_SECRET`.
 *
 * Response contract (spec §2):
 *   200  { success, mode, durationMs, stats, nextHistoryId }
 *   401  UNAUTHORIZED  (missing/wrong secret, or refresh_token invalid)
 *   405  on GET / PUT / DELETE / PATCH
 *   409  SYNC_IN_PROGRESS            (another run holds the lock)
 *   412  GMAIL_NOT_CONNECTED         (no credentials row)
 *   500  INTERNAL_ERROR              (unknown — no details leaked)
 *
 * Logging strategy:
 *   - Auth failure: `console.warn` with IP + attempted-header length.
 *     Never log the header value itself, even partially.
 *   - Expected business errors (409, 412, 401-from-token): `console.info`.
 *   - Unknown 500: `console.error` + `Sentry.captureException` with the
 *     `component: 'gmail-sync'` tag. Business errors are NOT captured —
 *     they're normal flow noise.
 *   - Success: `console.info` with a one-line stats summary.
 *
 * Auth note: uses `crypto.timingSafeEqual` to prevent byte-by-byte
 * timing-oracle attacks on the secret. A naive `=== ` returns faster
 * for a wrong first byte than a wrong last byte; over enough requests
 * an attacker could reconstruct the secret.
 */

import { timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { NextResponse, type NextRequest } from 'next/server';

import {
  GmailNotConnectedError,
  RefreshTokenInvalidError,
  runSync,
  SyncInProgressError,
  type SyncResult,
} from '@/lib/store-submissions/gmail/sync';

// Node runtime required: `crypto.timingSafeEqual`, `Buffer`, and the
// Gmail sync's use of `googleapis` + `pg`-backed supabase-js all need
// Node built-ins that the Edge runtime doesn't expose.
export const runtime = 'nodejs';
// Every invocation is dynamic — the sync reads DB state + Gmail API at
// request time. Static/ISR caching would be harmful.
export const dynamic = 'force-dynamic';

const AUTH_HEADER = 'x-cron-secret';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authFailure = verifyCronSecret(request);
  if (authFailure) return authFailure;

  try {
    const result = await runSync({ lockedBy: 'cron-sync' });
    logSuccess(result);
    return NextResponse.json(
      {
        success: result.success,
        mode: result.mode,
        durationMs: result.durationMs,
        stats: result.stats,
        nextHistoryId: result.nextHistoryId,
      },
      { status: 200 },
    );
  } catch (err) {
    return mapErrorToResponse(err);
  }
}

// Next.js App Router returns 405 automatically for unhandled methods,
// but exporting explicit handlers lets us set `Allow: POST` and log
// attempted non-POST hits.
export function GET(): NextResponse {
  return methodNotAllowed();
}
export function PUT(): NextResponse {
  return methodNotAllowed();
}
export function DELETE(): NextResponse {
  return methodNotAllowed();
}
export function PATCH(): NextResponse {
  return methodNotAllowed();
}

function methodNotAllowed(): NextResponse {
  return new NextResponse('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}

/* ----------------------------------------------------------------------------
 * Auth
 * -------------------------------------------------------------------------- */

/**
 * Returns `null` when the caller is authenticated, or a pre-built
 * error `NextResponse` to short-circuit the handler.
 */
function verifyCronSecret(request: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length === 0) {
    // Deployment misconfiguration — we CANNOT safely authenticate
    // without the secret. Don't fall back to empty-string match (would
    // let any request with an empty header through).
    console.error(
      '[cron/sync] CRON_SECRET env var is missing or empty — refusing to authenticate any request',
    );
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }

  const received = request.headers.get(AUTH_HEADER);
  if (!received) {
    logAuthFailure(request, 0);
    return unauthorizedResponse();
  }

  const expectedBuf = Buffer.from(expected, 'utf-8');
  const receivedBuf = Buffer.from(received, 'utf-8');

  // Length check is cheap and `timingSafeEqual` throws on mismatched
  // lengths — check manually so the error path is explicit. Length is
  // inherently non-secret (attacker already knows the byte count from
  // sending it).
  if (expectedBuf.length !== receivedBuf.length) {
    logAuthFailure(request, receivedBuf.length);
    return unauthorizedResponse();
  }

  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    logAuthFailure(request, receivedBuf.length);
    return unauthorizedResponse();
  }

  return null;
}

function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

function logAuthFailure(request: NextRequest, attemptedLen: number): void {
  // `x-forwarded-for` is the Railway / Vercel edge header; fall back to
  // `x-real-ip` for other deployments. Value is logged for security
  // auditing only (per GDPR, IPs are pseudonymous — not stored beyond
  // logs). We never log the attempted secret value, only its length.
  const ipHeader =
    request.headers.get('x-forwarded-for') ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const ip = ipHeader.split(',')[0]?.trim() || 'unknown';
  const ua = (request.headers.get('user-agent') ?? 'unknown').slice(0, 120);
  console.warn(
    `[cron/sync] AUTH FAILURE ip=${ip} attempted_len=${attemptedLen} ua=${JSON.stringify(ua)} at=${new Date().toISOString()}`,
  );
}

/* ----------------------------------------------------------------------------
 * Error mapping
 * -------------------------------------------------------------------------- */

function mapErrorToResponse(err: unknown): NextResponse {
  if (err instanceof SyncInProgressError) {
    console.info('[cron/sync] 409 Sync already in progress');
    return NextResponse.json(
      { success: false, error: 'SYNC_IN_PROGRESS' },
      { status: 409 },
    );
  }
  if (err instanceof GmailNotConnectedError) {
    console.info('[cron/sync] 412 Gmail not connected');
    return NextResponse.json(
      { success: false, error: 'GMAIL_NOT_CONNECTED' },
      { status: 412 },
    );
  }
  if (err instanceof RefreshTokenInvalidError) {
    // This surfaces a Gmail-side revocation OR an `invalid_grant` from
    // the token endpoint. The UI banner (reading consecutive_failures)
    // tells the Manager to reconnect. Return 401 so monitoring can
    // alert on a distinct signal — it's NOT the cron secret that's
    // wrong.
    console.warn(
      '[cron/sync] 401 Refresh token invalid — Manager must reconnect Gmail',
    );
    return NextResponse.json(
      { success: false, error: 'REFRESH_TOKEN_INVALID' },
      { status: 401 },
    );
  }

  // Unknown failure path. Log the full error server-side for debugging,
  // but DO NOT include details in the response — leaking internal
  // messages has historically caused config/credential disclosures.
  // Sentry captures with component tag for ops triage (PR-10d.1.2).
  console.error('[cron/sync] 500 Unhandled error:', err);
  Sentry.captureException(err, {
    tags: { component: 'gmail-sync', endpoint: 'cron-tick' },
  });
  return NextResponse.json(
    { success: false, error: 'INTERNAL_ERROR' },
    { status: 500 },
  );
}

/* ----------------------------------------------------------------------------
 * Success logging
 * -------------------------------------------------------------------------- */

function logSuccess(result: SyncResult): void {
  const { stats, mode, durationMs, nextHistoryId } = result;
  console.info(
    `[cron/sync] ${result.success ? 'OK' : 'PARTIAL'} mode=${mode} duration_ms=${durationMs} fetched=${stats.fetched} classified=${stats.classified} unclassified=${stats.unclassified} dropped=${stats.dropped} errors=${stats.errors} next_history_id=${nextHistoryId ?? 'null'}`,
  );
}
