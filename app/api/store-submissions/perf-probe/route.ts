/**
 * TEMPORARY connection-layer diagnostic — Supabase RTT / warm-vs-cold socket.
 *
 * Reuses the existing `[perf-probe]` logger convention (same tag, no PII).
 * PURELY ADDITIVE and removable in one delete — NO behaviour change, NO fix,
 * NO caching. Remove per the tripwire in
 * docs/performance-review-2026-07-27.md once the connection-layer issue is
 * RESOLVED (not merely measured).
 *
 * WHY A DEDICATED ROUTE (not a probe wired into the hot auth path):
 *   - The gate below is a pure header/env comparison and does NO DB work, so
 *     Probe A's `q1` is genuinely the request's FIRST Supabase round-trip —
 *     i.e. a COLD socket when the caller pauses >~4s between hits (undici's
 *     default global-Agent keepAliveTimeout is ~4s and nothing overrides it).
 *     Wiring the probe after `getStoreUser` would warm the socket first and
 *     destroy the cold-vs-warm signal.
 *   - Zero tax on normal navigation: it only runs when explicitly curled.
 *
 * HOW TO DRIVE (Manager): curl it a handful of times with realistic >5s
 * pauses between calls, then grep Railway:
 *
 *   curl -s -H "x-cron-secret: $CRON_SECRET" https://<app>/api/store-submissions/perf-probe
 *
 *   grep '\[perf-probe\] socket-test'   → q1_ms (cold) vs q2_ms (warm)
 *   grep '\[perf-probe\] warm-wave6'    → 6 parallel SELECTs on a WARM socket
 *   grep '\[perf-probe\] cpu-bench'      → CPU stability across calls
 *
 * READING PROBE A — TWO INDEPENDENT NUMBERS, not an either/or. Both costs can
 * be present at once and they need DIFFERENT fixes, so read GAP and LEVEL
 * separately:
 *
 *   GAP = q1_ms − q2_ms  → CONNECTION-ESTABLISHMENT cost (DNS + TCP + TLS).
 *     gap > ~200ms  ⇒ handshake dominates ⇒ fix: transport keep-alive / reuse.
 *     gap < ~50ms   ⇒ handshake is cheap OR the socket was already warm — read
 *                     q2 LEVEL and the INVALID-TEST case below before concluding.
 *
 *   LEVEL of q2_ms (warm socket) ≈ 1 RTT + PostgREST + Postgres → the TRUE
 *   PER-ROUND-TRIP FLOOR.
 *     q2 ~10–30ms  ⇒ transport is fine once warm ⇒ keep-alive alone likely
 *                    sufficient.
 *     q2 > ~80ms   ⇒ a real per-round-trip floor (geography / PostgREST /
 *                    server-side) ⇒ ALSO needs co-location and/or fewer round-
 *                    trips. Keep-alive alone will NOT be enough.
 *
 *   ⚠ BOTH q1 AND q2 LOW ⇒ the MEASUREMENT IS INVALID (not a clean "warm is
 *     fast" result) — the socket was already warm when q1 ran. q1 is only cold
 *     if NOTHING touched Supabase in the preceding ~4s, INCLUDING the Manager
 *     browsing the app in another tab. Requirement: idle ≥10s, no app clicks
 *     during the run, and take 3–4 samples.
 *
 *   WHY gap and level must be read separately: a COLD socket costs 4–5 round-
 *   trips (DNS + TCP 1 + TLS 1–2 + the request itself), not one — so at an
 *   ~80ms base RTT a cold navigation is ~320–400ms, which matches the observed
 *   floor. gap is the handshake tax; level is the irreducible per-trip floor.
 *
 * READING PROBE D — warm-socket parallel wave (warm-wave6_ms):
 *   warm-wave6 ≈ q2        ⇒ concurrency works fine on a warm socket. Confirms
 *                            the handshake + CPU-contention story and predicts a
 *                            keep-alive fix collapses the page waves too, not
 *                            just single queries.
 *   warm-wave6 ≫ q2 (2x+)  ⇒ something ELSE bottlenecks concurrency even when
 *                            warm (server-side limit, or CPU throttle
 *                            independent of handshakes) ⇒ investigate before
 *                            choosing a fix.
 *
 * READING PROBE B:
 *   cpu-bench stable & low across calls        → CPU is fine.
 *   cpu-bench varies several-fold across calls → container is CPU-throttled,
 *   which alone would explain the 4x RTT variance AND Promise.all not scaling
 *   (concurrent TLS handshakes are CPU-bound crypto that queue under throttle).
 *
 * BLIND SPOT + FREE CROSS-CHECK: a curl against this route has NO render load
 * and does NOT reproduce a real page's concurrent query burst, so it cannot
 * fully exercise the CPU-contention path. Cross-check q1 against the
 * `[perf-probe] getStoreUser SELECT dur_ms=` lines already flowing from real
 * navigations (observed 284–1159ms):
 *   probe q1 ≈ navigation numbers ⇒ the cost exists independent of render load.
 *   probe q1 ≪ navigation numbers ⇒ the render path adds cost beyond the bare
 *                                   round-trip ⇒ investigate the render path next.
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { storeDb } from "@/lib/store-submissions/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  // Off entirely under test.
  if (process.env.NODE_ENV === "test") {
    return NextResponse.json({ error: "disabled in test" }, { status: 404 });
  }

  // Gate with NO DB work (pure env/header compare) so Probe A's q1 is the
  // request's first Supabase round-trip. Mirrors the cron `x-cron-secret`
  // convention; refuses if the secret is unset (never let an empty header
  // through).
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (req.headers.get("x-cron-secret") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // A trivial SELECT with a UNIQUE filter per call. Two independence
  // guarantees: (1) it goes through `storeDb()` DIRECTLY (not `getStoreUser`),
  // bypassing the requestScopedCache dedupe; (2) the distinct `.neq('email',…)`
  // value makes each request URL unique, so even Next's patched-fetch response
  // cache cannot serve one probe query from another — every call is a real
  // network round-trip. The filter matches all ~5 rows (no such email exists),
  // so it stays a trivial indexed scan.
  const trivialSelect = (label: string) =>
    storeDb().from("users").select("id").neq("email", `__perf_probe_${label}__`).limit(1);

  // ── PROBE A — warm-vs-cold socket ────────────────────────────────────────
  // Two sequential SELECTs in ONE request. q1 = cold (first round-trip of the
  // request — cold socket iff nothing touched Supabase in the preceding ~4s),
  // q2 = warm (reuses q1's socket via undici keep-alive, held for the sub-ms
  // gap here). Read GAP (q1−q2) and LEVEL (q2) separately — see header.
  let q1_ms: number | null = null;
  let q2_ms: number | null = null;
  let warm_wave6_ms: number | null = null;
  let probeError: string | null = null;
  try {
    const t1 = Date.now();
    await trivialSelect("q1");
    q1_ms = Date.now() - t1;

    const t2 = Date.now();
    await trivialSelect("q2");
    q2_ms = Date.now() - t2;

    void log("perf-probe", `socket-test q1_ms=${q1_ms} q2_ms=${q2_ms}`);

    // ── PROBE D — warm-socket parallel wave ────────────────────────────────
    // Runs AFTER q1/q2 so the socket is warm. Fires 6 trivial SELECTs via
    // Promise.all — genuinely independent network calls (distinct URLs per the
    // unique filter above; no requestScopedCache/memoization in this path).
    // Reproduces a page's 6-7 query burst ON A WARM socket:
    //   warm-wave6 ≈ q2       ⇒ concurrency is fine once warm (keep-alive would
    //                           collapse the page waves too).
    //   warm-wave6 ≫ q2 (2x+) ⇒ something else bottlenecks concurrency even
    //                           warm ⇒ investigate before choosing a fix.
    const tw = Date.now();
    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) => trivialSelect(`wave${i}`)),
    );
    warm_wave6_ms = Date.now() - tw;
    void log("perf-probe", `warm-wave6_ms=${warm_wave6_ms}`);
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
    void log("perf-probe", `socket-test error=${probeError}`);
  }

  // ── PROBE B — CPU sanity (rules the throttle hypothesis in/out) ───────────
  // Fixed CPU-bound work (a bounded sha256 chain). Compare `cpu_bench_ms`
  // across calls: stable ⇒ CPU fine; several-fold swing ⇒ throttled container.
  const c0 = Date.now();
  let h = "seed";
  for (let i = 0; i < 50_000; i++) {
    h = createHash("sha256").update(h).update(String(i)).digest("hex");
  }
  const cpu_bench_ms = Date.now() - c0;
  void log("perf-probe", `cpu-bench ms=${cpu_bench_ms} tail=${h.slice(0, 4)}`);

  // PROBE C (undici socket-connect events via diagnostics_channel) — SKIPPED.
  // Wiring a global `undici:client:connected` subscriber + per-request
  // correlation is non-trivial in this stack and Probe A already answers the
  // cold-vs-warm question directly. Intentionally not implemented.

  return NextResponse.json({
    probe: "connection-layer",
    socket_test: { q1_ms, q2_ms, warm_wave6_ms, error: probeError },
    cpu_bench_ms,
    how_to_read: {
      gap: "q1_ms - q2_ms = connection-establishment cost. >~200ms => handshake dominates (fix: keep-alive). <~50ms => cheap OR socket already warm (check invalid_test).",
      level: "q2_ms = true per-round-trip floor. ~10-30ms => transport fine warm (keep-alive suffices). >~80ms => real floor (geo/PostgREST) => also co-locate / fewer round-trips.",
      invalid_test: "BOTH q1 AND q2 low => INVALID: socket was already warm when q1 ran. Idle >=10s, no app clicks during the run, take 3-4 samples.",
      warm_wave6: "~= q2 => concurrency fine warm (keep-alive collapses page waves too). >> q2 (2x+) => something else bottlenecks concurrency even warm => investigate.",
      cpu_bench: "varies several-fold across calls => CPU-throttled container.",
      cross_check: "compare q1_ms to real [perf-probe] getStoreUser SELECT dur_ms (284-1159ms). ~= => cost independent of render; << => render path adds cost.",
    },
  });
}
