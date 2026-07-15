/**
 * Poll Apple until a freshly-created IAP reaches a required state (IAP.o.11a
 * Stage 1→2 guard; IAP.q.2 Stage 4→5 guard).
 *
 * Even though Apple returns 200 on the CREATE IAP POST (and on the screenshot
 * confirm PATCH), downstream endpoints occasionally appear to race against
 * propagation of that write across Apple's services. Both exported pollers
 * share the same bounded retry-with-backoff loop below and differ only in
 * their readiness predicate:
 *
 *   • `pollIapReadyForPricing` — Stage 1 (CREATE) → Stage 2 (price schedule).
 *     Ready as soon as `attributes.state` is populated at all.
 *   • `pollIapReadyForSubmit` — Stage 4 (screenshot confirm) → Stage 5
 *     (submit). Ready only once `attributes.state === "READY_TO_SUBMIT"` —
 *     a populated-but-wrong state (e.g. still `MISSING_METADATA` because the
 *     screenshot relationship hasn't propagated yet) is NOT ready.
 *
 * Manager Q-B locked: poll, do not blind-delay. The fast-path IAP gets through
 * in ~200ms; the slow-path IAP waits up to 2 s. A blind 2 s wait would
 * uniformly penalize every IAP, including ones Apple has already propagated.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import { iapFetch, AppleApiError } from "./fetch";
import type { AscApiResponse, InAppPurchase } from "@/types/iap-management/apple";

export interface PollIapReadyArgs {
  creds: AscCredentials;
  appleIapId: string;
  /** Test seam: override the sleep + total budget. Defaults to 200 ms × 10. */
  config?: {
    intervalMs?: number;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

export type PollIapReadyResult =
  | {
      ready: true;
      attempts: number;
      total_ms: number;
      final_state: string;
    }
  | {
      ready: false;
      attempts: number;
      total_ms: number;
      /** Why we gave up — last error message, or "no state" if we got a 200
       *  response but `attributes.state` was missing/empty for every attempt. */
      reason: string;
      /** Most recent non-empty state Apple reported, if any attempt got one —
       *  even though it didn't satisfy the readiness predicate. Lets callers
       *  (e.g. a submit-time state guard) make a fresh-state decision without
       *  issuing a second GET right after giving up on this poll. */
      last_seen_state?: string;
    };

const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_MAX_ATTEMPTS = 10;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Shared bounded retry-with-backoff loop. Polls `GET /v2/inAppPurchases/{id}`
 * until `isReady(state)` is true or attempts are exhausted. Console-logs every
 * attempt with `[poll-iap-ready]` prefix so Railway tail shows poll
 * progression for diagnostic purposes (IAP.o.11 instrumentation requirement).
 */
async function pollIapState(
  args: PollIapReadyArgs,
  isReady: (state: string) => boolean,
): Promise<PollIapReadyResult> {
  const intervalMs = args.config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxAttempts = args.config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = args.config?.sleep ?? defaultSleep;

  console.log(
    `[poll-iap-ready] start apple_iap_id=${args.appleIapId} interval=${intervalMs}ms max=${maxAttempts}`,
  );

  const startedAt = Date.now();
  let lastReason = "no state";
  let lastSeenState: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await iapFetch<AscApiResponse<InAppPurchase>>(
        args.creds,
        "GET",
        `/v2/inAppPurchases/${args.appleIapId}`,
      );
      const state = res.data.attributes.state;
      if (typeof state === "string" && state.length > 0) {
        lastSeenState = state;
        if (isReady(state)) {
          const totalMs = Date.now() - startedAt;
          console.log(
            `[poll-iap-ready] ready apple_iap_id=${args.appleIapId} attempt=${attempt} total=${totalMs}ms state=${state}`,
          );
          return { ready: true, attempts: attempt, total_ms: totalMs, final_state: state };
        }
        lastReason = `not ready: state=${state}`;
        console.log(
          `[poll-iap-ready] attempt=${attempt} apple_iap_id=${args.appleIapId} state=${state} not-ready`,
        );
      } else {
        lastReason = "no state";
        console.log(
          `[poll-iap-ready] attempt=${attempt} apple_iap_id=${args.appleIapId} state-missing`,
        );
      }
    } catch (err) {
      lastReason =
        err instanceof AppleApiError
          ? `${err.status}: ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.log(
        `[poll-iap-ready] attempt=${attempt} apple_iap_id=${args.appleIapId} error=${lastReason}`,
      );
    }
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  const totalMs = Date.now() - startedAt;
  console.warn(
    `[poll-iap-ready] timeout apple_iap_id=${args.appleIapId} attempts=${maxAttempts} total=${totalMs}ms reason=${lastReason}`,
  );
  return {
    ready: false,
    attempts: maxAttempts,
    total_ms: totalMs,
    reason: lastReason,
    ...(lastSeenState ? { last_seen_state: lastSeenState } : {}),
  };
}

/**
 * Stage 1 (CREATE) → Stage 2 (price schedule) guard. Ready as soon as a
 * `GET /v2/inAppPurchases/{id}` succeeds with any populated `state` — that
 * signals Apple has fully written the IAP record and we can proceed with
 * pricing/screenshot/submit.
 */
export function pollIapReadyForPricing(
  args: PollIapReadyArgs,
): Promise<PollIapReadyResult> {
  return pollIapState(args, (state) => state.length > 0);
}

/**
 * IAP.q.2 — Stage 4 (screenshot confirm) → Stage 5 (submit) guard. Apple's
 * screenshot confirm PATCH returns 200 before the review-screenshot
 * relationship necessarily shows up on the IAP itself; submitting too early
 * throws `RELATIONSHIP.REQUIRED` (missing appStoreReviewScreenshot) and/or
 * `IAP_SUBMISSION_NOT_ALLOWED` (state still MISSING_METADATA). Ready only
 * once Apple reports `state === "READY_TO_SUBMIT"`.
 */
export function pollIapReadyForSubmit(
  args: PollIapReadyArgs,
): Promise<PollIapReadyResult> {
  return pollIapState(args, (state) => state === "READY_TO_SUBMIT");
}
