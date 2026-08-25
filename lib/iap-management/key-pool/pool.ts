/**
 * K2 — the `AppleKeyPool` implementation `iapFetch` hands to `appleFetch`.
 *
 * ⚠ THIS OBJECT IS THE OPT-IN. `lib/shared/apple-fetch.ts` knows only the
 * `AppleKeyPool` interface; it never imports anything from this module. CPP's
 * `ascFetch` does not import this file either, so it has no pool to pass and
 * cannot enable pooling even by mistake. `[Q-RATELIMIT.pool-scope]` — "the
 * pool serves Apple IAP Management only" — is therefore held by the module
 * graph rather than by a boolean anyone could set.
 */
import type { AppleKeyPool } from "@/lib/shared/apple-fetch";
import { selectKey, markKeyRateLimited } from "./selector";

export const iapKeyPool: AppleKeyPool = {
  select: selectKey,
  onRateLimited: markKeyRateLimited,
};
