/**
 * IAP.q.2 — submit-eligibility decision for the bulk-import create→submit
 * path. Composes two already-tested pieces without reimplementing either:
 *
 *   1. `pollIapReadyForSubmit` (poll-iap-ready.ts) — waits out the common-case
 *      propagation lag between the screenshot confirm PATCH and Apple
 *      reporting `state === "READY_TO_SUBMIT"`.
 *   2. `partitionByStateGuard` (submit-batch/bucket.ts) — the SAME Cycle 32 /
 *      IAP.q.1 state-guard the regular submit-batch endpoint uses to decide
 *      whether a fresh Apple state permits submission.
 *
 * Twin-path convergence: before this module existed, bulk-import's
 * create→submit flow called `submitInAppPurchase` directly off a purely
 * local condition (screenshot uploaded + no failed locales), with no
 * visibility into Apple's actual `state`. This helper gives it the same
 * fresh-state guard submit-batch already had, so a not-yet-ready IAP is
 * deferred instead of 409ing.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  pollIapReadyForSubmit,
  type PollIapReadyResult,
} from "./poll-iap-ready";
import { partitionByStateGuard } from "@/lib/iap-management/submit-batch/bucket";

export interface CheckSubmitEligibilityArgs {
  creds: AscCredentials;
  appleIapId: string;
  /** Test seam, forwarded to `pollIapReadyForSubmit`. */
  pollConfig?: {
    intervalMs?: number;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

export interface SubmitEligibilityResult {
  /** True only when Apple's freshest observed state is READY_TO_SUBMIT. */
  eligible: boolean;
  /** Apple's freshest observed state — the poll's final_state when ready,
   *  otherwise the last state seen across poll attempts (or "UNKNOWN" if
   *  every attempt errored before returning any state). */
  fresh_state: string;
  /** The underlying poll result, surfaced for logging/telemetry. */
  poll: PollIapReadyResult;
}

export async function checkSubmitEligibility(
  args: CheckSubmitEligibilityArgs,
): Promise<SubmitEligibilityResult> {
  const poll = await pollIapReadyForSubmit({
    creds: args.creds,
    appleIapId: args.appleIapId,
    config: args.pollConfig,
  });
  const fresh_state = poll.ready
    ? poll.final_state
    : (poll.last_seen_state ?? "UNKNOWN");

  const guard = partitionByStateGuard(
    [{ id: args.appleIapId, apple_iap_id: args.appleIapId }],
    new Map([[args.appleIapId, fresh_state]]),
  );

  return { eligible: guard.eligible.length > 0, fresh_state, poll };
}
