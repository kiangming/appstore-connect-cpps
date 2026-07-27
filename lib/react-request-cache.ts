import * as React from "react";

/**
 * `requestScopedCache` — wrap a server function so repeated calls with the same
 * arguments WITHIN A SINGLE REQUEST RENDER share one execution (dedupe).
 *
 * It delegates to React's `cache()`. That API ships ONLY in React's
 * `react-server` build, which Next.js resolves for Server Components in
 * production — there `cache()` provides genuine per-request memoization
 * (cleared between requests by the framework). The plain client build used by
 * Vitest does NOT export `cache`, so we read it defensively (it may be
 * `undefined`) and fall back to an identity passthrough: no memoization,
 * imports never crash, and behavior is unchanged in the test environment (it
 * simply won't dedupe there — graceful degradation, never a break).
 *
 * REQUEST-SCOPED ONLY. This must never become a module-level / cross-request
 * cache: that is precisely the P6 / bug-9ed7845 multi-instance-staleness class
 * this codebase bans. React's `cache()` is per-request by construction, which
 * is why it is the correct tool here.
 */
const reactCache = (React as { cache?: typeof import("react").cache }).cache;

export const requestScopedCache = (
  typeof reactCache === "function" ? reactCache : (<T>(fn: T): T => fn)
) as NonNullable<typeof reactCache>;
