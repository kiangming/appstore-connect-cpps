/**
 * GET /api/store-submissions/sync/health  (public health probe)
 *
 * Read-only, unauthenticated endpoint for uptime monitors (UptimeRobot,
 * Better Uptime, Railway's own healthcheck). Returns a minimal status
 * snapshot derived from `gmail_sync_state` + a 24h count of `sync_logs`.
 *
 * Status classification:
 *   - `UNCONFIGURED`  — no sync has ever run (`last_synced_at IS NULL`).
 *                       Expected before Manager runs first connect; NOT
 *                       an alert condition. HTTP 200.
 *   - `OK`            — last sync within `STALE_THRESHOLD_MS`. HTTP 200.
 *   - `STALE`         — last sync older than threshold (cron stopped or
 *                       sync looping on failure). HTTP 503 so uptime
 *                       monitors fire.
 *
 * Threshold: **15 minutes**. Cron runs every 5 min, so 15 min = 3 missed
 * intervals — a reasonable "something's wrong" signal without flapping
 * on a single slow run. Adjust only with ops buy-in; document reason
 * inline if changed.
 *
 * Response body (stable contract — external monitors depend on it):
 *   {
 *     status: 'OK' | 'STALE' | 'UNCONFIGURED',
 *     last_synced_at: string | null,    // ISO 8601 UTC
 *     consecutive_failures: number,
 *     stale_ms: number | null,          // null when last_synced_at is null
 *     recent_sync_count_24h: number,
 *   }
 *
 * **Security:** The endpoint is public because uptime monitors can't
 * send authenticated requests. The response is deliberately minimal:
 *   - No credentials, email addresses, or PII
 *   - No error messages (`last_error` NOT returned — leaks internal state)
 *   - No sync_logs details (counts only)
 * An attacker who hits this URL learns only "sync is running / stale /
 * not set up" + a failure counter. That's the same information the ops
 * team would want to post publicly anyway.
 */

import { NextResponse } from 'next/server';

import {
  countRecentSyncLogs,
  getSyncState,
} from '@/lib/store-submissions/gmail/sync-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Route files in the Next.js App Router may only export the listed
// routing symbols (HTTP verb handlers, `runtime`, `dynamic`, etc.) —
// any other named export fails the build. Keep thresholds as module
// locals and re-derive in tests via test-only imports if needed.
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const DAY_MS = 24 * 60 * 60 * 1000;

type HealthStatus = 'OK' | 'STALE' | 'UNCONFIGURED';

interface HealthResponse {
  status: HealthStatus;
  last_synced_at: string | null;
  consecutive_failures: number;
  stale_ms: number | null;
  recent_sync_count_24h: number;
}

export async function GET(): Promise<NextResponse> {
  try {
    const [state, recentCount] = await Promise.all([
      getSyncState(),
      countRecentSyncLogs(DAY_MS),
    ]);

    const now = Date.now();
    const lastSyncedMs = state.lastSyncedAt?.getTime() ?? null;
    const staleMs = lastSyncedMs === null ? null : now - lastSyncedMs;

    let status: HealthStatus;
    if (lastSyncedMs === null) {
      status = 'UNCONFIGURED';
    } else if (staleMs !== null && staleMs > STALE_THRESHOLD_MS) {
      status = 'STALE';
    } else {
      status = 'OK';
    }

    const body: HealthResponse = {
      status,
      last_synced_at: state.lastSyncedAt?.toISOString() ?? null,
      consecutive_failures: state.consecutiveFailures,
      stale_ms: staleMs,
      recent_sync_count_24h: recentCount,
    };

    // UptimeRobot fires alerts on any non-2xx. We use 503 only for
    // STALE — UNCONFIGURED returns 200 so the first-time setup window
    // doesn't page the ops team.
    return NextResponse.json(body, {
      status: status === 'STALE' ? 503 : 200,
    });
  } catch (err) {
    // A DB read failure is itself a "something's wrong" signal. Return
    // 503 + a minimal body so external monitors can alert, but NEVER
    // leak the underlying error message (could expose schema details).
    console.error('[sync/health] Failed to read sync state:', err);
    return NextResponse.json(
      {
        status: 'STALE' as const,
        last_synced_at: null,
        consecutive_failures: 0,
        stale_ms: null,
        recent_sync_count_24h: 0,
      },
      { status: 503 },
    );
  }
}

export function POST(): NextResponse {
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
    headers: { Allow: 'GET' },
  });
}
