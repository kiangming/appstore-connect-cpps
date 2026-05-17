/**
 * Poll Apple until a freshly-created IAP is ready for downstream calls
 * (IAP.o.11a, Manager Q-B).
 *
 * Even though Apple returns 200 on the CREATE IAP POST, downstream endpoints
 * (price points, price schedules) occasionally appear to race against the
 * propagation of the new IAP across Apple's services. The IAP.o.11 hotfix
 * cycle introduces this poll as a precautionary gate between Stage 1 (CREATE)
 * and Stage 2 (set price schedule).
 *
 * Manager Q-B locked: poll, do not blind-delay. The fast-path IAP gets through
 * in ~200ms; the slow-path IAP waits up to 2 s. A blind 2 s wait would
 * uniformly penalize every IAP, including ones Apple has already propagated.
 *
 * Success criterion: a `GET /v2/inAppPurchases/{id}` succeeds and the response
 * has `data.attributes.state` populated. That signals Apple has fully written
 * the IAP record and we can proceed with pricing/screenshot/submit.
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
    };

const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_MAX_ATTEMPTS = 10;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll Apple's GET IAP endpoint until the IAP record is queryable with a
 * populated `state` attribute. Returns a typed result so callers can branch
 * on `ready` without re-running checks.
 *
 * Console-logs every attempt with `[poll-iap-ready]` prefix so Railway tail
 * shows poll progression for diagnostic purposes (IAP.o.11 instrumentation
 * requirement).
 */
export async function pollIapReadyForPricing(
  args: PollIapReadyArgs,
): Promise<PollIapReadyResult> {
  const intervalMs = args.config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxAttempts = args.config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = args.config?.sleep ?? defaultSleep;

  console.log(
    `[poll-iap-ready] start apple_iap_id=${args.appleIapId} interval=${intervalMs}ms max=${maxAttempts}`,
  );

  const startedAt = Date.now();
  let lastReason = "no state";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await iapFetch<AscApiResponse<InAppPurchase>>(
        args.creds,
        "GET",
        `/v2/inAppPurchases/${args.appleIapId}`,
      );
      const state = res.data.attributes.state;
      if (typeof state === "string" && state.length > 0) {
        const totalMs = Date.now() - startedAt;
        console.log(
          `[poll-iap-ready] ready apple_iap_id=${args.appleIapId} attempt=${attempt} total=${totalMs}ms state=${state}`,
        );
        return { ready: true, attempts: attempt, total_ms: totalMs, final_state: state };
      }
      lastReason = "no state";
      console.log(
        `[poll-iap-ready] attempt=${attempt} apple_iap_id=${args.appleIapId} state-missing`,
      );
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
  return { ready: false, attempts: maxAttempts, total_ms: totalMs, reason: lastReason };
}
