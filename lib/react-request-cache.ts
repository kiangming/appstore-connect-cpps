import * as React from "react";
import { log } from "@/lib/logger";

/**
 * `requestScopedCache` — wrap a server function so repeated calls with the same
 * arguments WITHIN A SINGLE REQUEST RENDER share one execution (dedupe).
 *
 * It delegates to React's `cache()`. That API ships ONLY in React's
 * `react-server` build, which Next.js resolves for Server Components in
 * production — there `cache()` provides genuine per-request memoization
 * (cleared between requests by the framework). The plain client build used by
 * Vitest does NOT export `cache`, so we read it defensively (it may be
 * `undefined`) and fall back to an identity passthrough so imports never crash.
 *
 * REQUEST-SCOPED ONLY. This must never become a module-level / cross-request
 * cache: that is precisely the P6 / bug-9ed7845 multi-instance-staleness class
 * this codebase bans. React's `cache()` is per-request by construction, which
 * is why it is the correct tool here.
 */
const reactCache = (React as { cache?: typeof import("react").cache }).cache;

const identity = <T>(fn: T): T => fn;

/**
 * Fail LOUD, never silent. If React's request-scoped `cache()` is missing at a
 * REAL runtime (i.e. not a unit test), the identity fallback would quietly turn
 * OFF the dedupe for `getStoreUser` / `getApplePlatformId` and every call would
 * hit Supabase again — a lost optimization nobody would notice until latency
 * and DB load crept back. A silent no-op is the worst outcome here, so emit a
 * clear WARN. Under Vitest the client React build legitimately lacks `cache()`;
 * that case is expected and intentionally stays quiet (`NODE_ENV === 'test'`).
 */
if (typeof reactCache !== "function" && process.env.NODE_ENV !== "test") {
  void log(
    "react-request-cache",
    "React cache() unavailable at runtime — request-scoped dedupe DISABLED, " +
      "falling back to identity (NO memoization). In a Next.js Server Component " +
      "this should never happen; it signals a broken react-server build or a " +
      "wrong import layer. Investigate: the perf optimization is silently off.",
    "WARN",
  );
}

export const requestScopedCache = (
  typeof reactCache === "function" ? reactCache : identity
) as NonNullable<typeof reactCache>;
